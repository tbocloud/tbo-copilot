"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AWS_TOOL,
  SERVER_VERSION,
  blockedChange,
  callResults,
  commandArg,
  createAws,
  findUv,
  hintFor,
  redact,
  secretRead,
  serverCommand,
  serverEnv,
  unwrap,
} = require("../../tbo.support/lib/aws");

const FAKE_SERVER = path.join(__dirname, "fixtures", "fake-aws-mcp.js");
const APPROVED = "helpdesk.api.copilot_actions.approved_action";
const REQUEST = "helpdesk.api.copilot_actions.request_action_approval";
const EXECUTED = "helpdesk.api.copilot_actions.mark_action_executed";

function cmd(text) {
  return commandArg({ command: text });
}

// A fake TBO Support: no approval until `approve()` is called.
function fakeHub() {
  const calls = [];
  let approval = null;
  return {
    calls,
    approve(by = "approver@example.com") {
      approval = { name: "TBO-ACT-2026-00007", decided_by: by, status: "Approved" };
    },
    client: {
      async method(p, params) {
        calls.push(["GET", p, params]);
        if (p === APPROVED) return approval;
        throw new Error(`unexpected ${p}`);
      },
      async post(p, params) {
        calls.push(["POST", p, params]);
        if (p === REQUEST) return { name: "TBO-ACT-2026-00007", assigned_to: "approver@example.com", status: "Pending", expires_at: "2026-11-12 13:00:00" };
        if (p === EXECUTED) return { name: params.name, status: params.ok ? "Executed" : "Failed" };
        throw new Error(`unexpected ${p}`);
      },
    },
  };
}

function setup(t, settings = {}, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tbo-aws-test-"));
  const hub = fakeHub();
  const launches = [];
  const values = { awsProfile: "tbo-readonly", awsRegion: "ap-south-1", awsAllowChanges: true, ...settings };
  const aws = createAws({
    getSettings: async () => values,
    getDataPath: async () => dataDir,
    hub: async () => hub.client,
    ...options,
    launch: ({ readOnly, conf }) => {
      launches.push(readOnly ? "read-only" : "changes");
      return {
        command: process.execPath,
        args: [FAKE_SERVER],
        env: {
          PATH: process.env.PATH,
          READ_OPERATIONS_ONLY: readOnly ? "true" : "false",
          AWS_REGION: conf.region,
          AWS_API_MCP_PROFILE_NAME: conf.profile,
        },
      };
    },
  });
  t.after(() => {
    aws.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { aws, hub, launches, values, dataDir };
}

function parsedOutput(result) {
  const inner = result.output.replace(/^<untrusted_aws_output>\n/, "").replace(/\n<\/untrusted_aws_output>$/, "");
  return JSON.parse(inner);
}

// --- the command and the rules ---------------------------------------------------

test("a command is one line that starts with aws, kept exactly as written", () => {
  const c = cmd('aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch \'{"a":  "two  spaces"}\'');
  assert.equal(c.service, "route53");
  assert.equal(c.operation, "change-resource-record-sets");
  assert.match(c.command, /two {2}spaces/);
  for (const bad of ["", "ls -la", "aws", "aws ec2", "aws ec2 describe-instances\naws iam list-users", "aws ec2 describe-instances `id`", "aws s3 ls $(whoami)"]) {
    assert.throws(() => cmd(bad), { code: "INVALID_ARGUMENT" }, bad);
  }
  assert.throws(() => cmd(`aws ec2 describe-instances ${"x".repeat(2001)}`), { code: "INVALID_ARGUMENT" });
});

test("deletes, terminations, identity and hidden changes are blocked", () => {
  for (const blocked of [
    "aws ec2 terminate-instances --instance-ids i-1",
    "aws ec2 delete-volume --volume-id vol-1",
    "aws ec2 release-address --allocation-id eipalloc-1",
    "aws ec2 disassociate-address --association-id a-1",
    "aws ec2 detach-volume --volume-id vol-1",
    "aws s3 rm s3://bucket/key",
    "aws s3 rb s3://bucket",
    "aws s3 mv s3://a/x s3://b/x",
    "aws s3 sync ./site s3://bucket --delete",
    "aws iam create-user --user-name x",
    "aws sts assume-role --role-arn r --role-session-name s",
    "aws secretsmanager put-secret-value --secret-id x --secret-string y",
    'aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch \'{"Changes":[{"Action":"DELETE","ResourceRecordSet":{}}]}\'',
    "aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch Changes=[{Action=DELETE}]",
    "aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch file://batch.json",
    "aws ec2 start-instances --instance-ids i-1 --region *",
  ]) {
    assert.ok(blockedChange(cmd(blocked)), blocked);
  }
  for (const allowed of [
    "aws ec2 start-instances --instance-ids i-1",
    "aws ec2 reboot-instances --instance-ids i-1",
    'aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch \'{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"_tbo-test.example.com","Type":"TXT","TTL":60,"ResourceRecords":[{"Value":"\\"hello\\""}]}}]}\'',
    "aws s3 sync ./site s3://bucket/",
    'aws cloudfront create-invalidation --distribution-id E1 --paths "/*"',
  ]) {
    assert.equal(blockedChange(cmd(allowed)), "", allowed);
  }
});

test("reads that hand back a secret are refused, other reads are not", () => {
  assert.ok(secretRead(cmd("aws secretsmanager get-secret-value --secret-id x")));
  assert.ok(secretRead(cmd("aws ssm get-parameters --names a --with-decryption")));
  assert.ok(secretRead(cmd("aws ec2 get-password-data --instance-id i-1")));
  assert.ok(!secretRead(cmd("aws ssm get-parameter --name a")));
  assert.ok(!secretRead(cmd("aws sts get-caller-identity")));
  assert.ok(!secretRead(cmd("aws ec2 describe-instances")));
});

test("a missing profile and an expired login each say what to do", () => {
  // the real server's words for a profile this computer does not have
  assert.match(hintFor("Error while executing the command: The config profile (tbo-readonly) could not be found", "tbo-readonly"), /aws configure sso.*AWS profile/);
  assert.match(hintFor("Token has expired and refresh failed", "tbo-readonly"), /aws sso login --profile tbo-readonly/);
  assert.equal(hintFor("AccessDenied: not allowed", "x"), "");
});

test("key-shaped text never reaches the model", () => {
  const out = redact('{"AccessKeyId": "AKIAABCDEFGHIJKLMNOP", "SecretAccessKey": "s3cr3t", "SessionToken": "tok"}\naws_secret_access_key = abc\n-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----');
  assert.doesNotMatch(out, /AKIAABCDEFGHIJKLMNOP|s3cr3t|"tok"|= abc|xyz/);
  assert.match(out, /access key left out/);
  assert.match(out, /private key left out/);
});

// --- finding uv and starting the server ------------------------------------------------

test("uv is found in the configured place, on PATH, or in the usual folders", () => {
  const exists = (p) => p === "/custom/uv" || p === "/home/me/.local/bin/uv";
  assert.equal(findUv({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/me", configured: "/custom/uv", exists }), "/custom/uv");
  assert.equal(findUv({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/me", exists }), "/home/me/.local/bin/uv");
  assert.equal(findUv({ env: { PATH: "" }, platform: "linux", home: "/nowhere", exists: () => false }), null);
});

test("the server runs the pinned version, read-only, with the profile and never with AWS keys", () => {
  const { command, args } = serverCommand({ uv: "/u/uv", platform: "darwin" });
  assert.equal(command, "/u/uv");
  assert.deepEqual(args, ["tool", "run", "--from", `awslabs.aws-api-mcp-server==${SERVER_VERSION}`, "awslabs.aws-api-mcp-server"]);
  assert.equal(serverCommand({ uv: "C:\\uv.exe", platform: "win32" }).args.at(-1), "awslabs.aws-api-mcp-server.exe");
  const env = serverEnv({
    baseEnv: { HOME: "/home/me", PATH: "/usr/bin", AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "x", AWS_PROFILE: "admin" },
    uv: "/u/uv",
    profile: "tbo-readonly",
    region: "ap-south-1",
    readOnly: true,
    workDir: "/data/aws-workdir",
  });
  assert.equal(env.READ_OPERATIONS_ONLY, "true");
  assert.equal(env.AWS_API_MCP_PROFILE_NAME, "tbo-readonly");
  assert.equal(env.AWS_REGION, "ap-south-1");
  assert.equal(env.AWS_API_MCP_TELEMETRY, "false");
  assert.equal(env.AWS_API_MCP_ALLOW_UNRESTRICTED_LOCAL_FILE_ACCESS, "workdir");
  assert.equal(env.HOME, "/home/me");
  assert.ok(env.PATH.startsWith("/u"));
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE"]) assert.equal(env[key], undefined, key);
  assert.equal(serverEnv({ baseEnv: {}, uv: "/u/uv", readOnly: false, workDir: "/w" }).READ_OPERATIONS_ONLY, "false");
});

test("without uv the tool says how to install it", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tbo-aws-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const aws = createAws({
    getSettings: async () => ({}),
    getDataPath: async () => dataDir,
    hub: async () => null,
    env: { PATH: "" },
    platform: "linux",
    home: dataDir,
  });
  await assert.rejects(aws.run({ action: "read", command: "aws ec2 describe-instances" }), { code: "UV_MISSING", message: /astral\.sh/ });
  await assert.rejects(aws.run({ action: "setup" }), { code: "UV_MISSING" });
  const status = await aws.run({ action: "status" });
  assert.equal(status.uv, null);
  assert.equal(status.changes_allowed, false);
  assert.equal(status.region, "ap-south-1");
});

test("call_aws answers are read from structured content or JSON text", () => {
  assert.deepEqual(callResults({ structuredContent: { result: [{ error: "x" }] } }), [{ error: "x" }]);
  assert.deepEqual(callResults({ content: [{ type: "text", text: '[{"response": 1}]' }] }), [{ response: 1 }]);
  assert.deepEqual(callResults({ isError: true, content: [{ type: "text", text: "boom" }] }), [{ error: "boom" }]);
});

test("a call_aws answer is unwrapped to AWS's JSON, AWS's error, or a validation failure", () => {
  assert.deepEqual(unwrap({ response: { response: { error: null, json: '{"a":1}' } } }), { text: '{"a":1}' });
  assert.deepEqual(unwrap({ response: { response: { error: "not allowed", error_code: "AccessDenied" } } }), { error: "AccessDenied: not allowed" });
  assert.deepEqual(unwrap({ response: { validation_failures: [{ reason: "--instance-ids is required" }] } }), { error: "--instance-ids is required" });
  assert.deepEqual(unwrap({ response: { response: "2026-11-12 bucket-a" } }), { text: "2026-11-12 bucket-a" });
  assert.deepEqual(unwrap({ error: "denied by security policy" }), { error: "denied by security policy" });
  assert.match(unwrap({ response: { response: { json: "[]", pagination_token: "t1" } } }).text, /pagination token t1/);
});

// --- reads through the (fake) server ------------------------------------------------------

test("a read runs on the read-only server with the person's profile, and the server is kept", async (t) => {
  const { aws, launches } = setup(t);
  const first = await aws.run({ action: "read", command: "aws ec2 describe-instances" });
  assert.match(first.output, /^<untrusted_aws_output>/);
  const out = parsedOutput(first);
  assert.deepEqual([out.readOnly, out.profile, out.region, out.keyForwarded], [true, "tbo-readonly", "ap-south-1", false]);
  await aws.run({ action: "read", command: "aws ec2 describe-instance-status --include-all-instances structured" });
  assert.deepEqual(launches, ["read-only"]);
  const status = await aws.run({ action: "status" });
  assert.equal(status.read_server_running, true);
});

test("a new profile starts a new read-only server", async (t) => {
  const { aws, launches, values } = setup(t);
  await aws.run({ action: "read", command: "aws ec2 describe-instances" });
  values.awsProfile = "other";
  const out = parsedOutput(await aws.run({ action: "read", command: "aws ec2 describe-instances" }));
  assert.equal(out.profile, "other");
  assert.deepEqual(launches, ["read-only", "read-only"]);
});

test("a change sent as a read is refused and nothing runs", async (t) => {
  const { aws, hub } = setup(t);
  const result = await aws.run({ action: "read", command: "aws ec2 start-instances --instance-ids i-1" });
  assert.equal(result.refused, true);
  assert.match(result.message, /change/);
  assert.equal(hub.calls.length, 0);
});

test("a secret read never reaches the server", async (t) => {
  const { aws, launches } = setup(t);
  await assert.rejects(aws.run({ action: "read", command: "aws secretsmanager get-secret-value --secret-id prod" }), { code: "BLOCKED" });
  assert.deepEqual(launches, []);
});

test("an expired login says how to sign in again; AWS output is cleaned", async (t) => {
  const { aws } = setup(t);
  await assert.rejects(aws.run({ action: "read", command: "aws ec2 describe-instances expired" }), {
    code: "AWS_ERROR",
    message: /aws sso login --profile tbo-readonly/,
  });
  const leaked = await aws.run({ action: "read", command: "aws iam get-user leak" });
  assert.doesNotMatch(leaked.output, /AKIAABCDEFGHIJKLMNOP|very-secret|BEGIN RSA/);
});

test("the client answers the server's ping and refuses its consent question", async (t) => {
  const { aws } = setup(t);
  assert.equal(parsedOutput(await aws.run({ action: "read", command: "aws ec2 describe-instances ping-first" })).pinged, true);
  assert.equal(parsedOutput(await aws.run({ action: "read", command: "aws ec2 describe-instances ask-consent" })).consent, -32601);
});

// --- changes: the setting, the block list and the approval ---------------------------------

const TXT_CHANGE =
  'aws route53 change-resource-record-sets --hosted-zone-id Z123 --change-batch \'{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"_tbo-test.example.com","Type":"TXT","TTL":60,"ResourceRecords":[{"Value":"\\"hello\\""}]}}]}\'';

test("changes are off unless the person turned them on", async (t) => {
  const { aws, hub, launches } = setup(t, { awsAllowChanges: false });
  await assert.rejects(aws.run({ action: "change", command: TXT_CHANGE }), { code: "CHANGES_OFF", message: /Allow AWS changes/ });
  assert.equal(hub.calls.length, 0);
  assert.deepEqual(launches, []);
});

test("a blocked change never reaches TBO Support or AWS", async (t) => {
  const { aws, hub, launches } = setup(t);
  await assert.rejects(aws.run({ action: "change", command: "aws ec2 terminate-instances --instance-ids i-1" }), { code: "BLOCKED" });
  assert.equal(hub.calls.length, 0);
  assert.deepEqual(launches, []);
});

test("the first change asks for an approval of the exact command; nothing runs", async (t) => {
  const { aws, hub, launches } = setup(t);
  const result = await aws.run({ action: "change", command: TXT_CHANGE, reason: "Test record for the AWS tool" });
  assert.equal(result.status, "waiting for approval");
  assert.equal(result.approval, "TBO-ACT-2026-00007");
  assert.equal(result.approver, "approver@example.com");
  const [lookup, ask] = hub.calls;
  const payload = { command: TXT_CHANGE, profile: "tbo-readonly", region: "ap-south-1" };
  assert.deepEqual(lookup, ["GET", APPROVED, { kind: "AWS", payload }]);
  assert.equal(ask[1], REQUEST);
  assert.deepEqual(ask[2].payload, payload);
  assert.equal(ask[2].kind, "AWS");
  assert.equal(ask[2].via, "Desktop");
  assert.match(ask[2].details, /_tbo-test\.example\.com/);
  assert.match(ask[2].details, /why: Test record/);
  assert.deepEqual(launches, []);
});

test("once approved, the same command runs once on a changes server and the outcome is recorded", async (t) => {
  const { aws, hub, launches } = setup(t);
  await aws.run({ action: "change", command: TXT_CHANGE });
  hub.approve();
  const result = await aws.run({ action: "change", command: TXT_CHANGE });
  assert.equal(result.ran, true);
  assert.equal(result.approved_by, "approver@example.com");
  const out = parsedOutput(result);
  assert.equal(out.readOnly, false);
  // the region on the card is written into the command that runs
  assert.equal(out.command, `${TXT_CHANGE} --region ap-south-1`);
  assert.equal(result.command, TXT_CHANGE);
  assert.deepEqual(launches, ["changes"]);
  const executed = hub.calls.find((c) => c[1] === EXECUTED);
  assert.equal(executed[2].name, "TBO-ACT-2026-00007");
  assert.equal(executed[2].ok, 1);
  assert.match(executed[2].log, /_tbo-test/);
});

test("an approved change AWS refuses is recorded as failed", async (t) => {
  const { aws, hub } = setup(t);
  hub.approve();
  await assert.rejects(aws.run({ action: "change", command: "aws ec2 start-instances --instance-ids i-1 refuse-me" }), {
    code: "AWS_ERROR",
    message: /Approved \(TBO-ACT-2026-00007\) but AWS refused it/,
  });
  const executed = hub.calls.find((c) => c[1] === EXECUTED);
  assert.equal(executed[2].ok, 0);
});

test("the tool's declaration lets only status and read run in Plan mode", () => {
  assert.equal(AWS_TOOL.name, "tbo_aws");
  assert.deepEqual(AWS_TOOL.planSafeActions, ["status", "read"]);
  assert.deepEqual(AWS_TOOL.schema.properties.action.enum, ["status", "setup", "read", "change"]);
  assert.equal(AWS_TOOL.schema.additionalProperties, false);
});


// --- CodeRabbit's review of PR #24 ------------------------------------------------------------

test("global options before the service are skipped, so the checks see the real command", () => {
  const kms = cmd("aws --region ap-south-1 kms decrypt --ciphertext-blob x");
  assert.deepEqual([kms.service, kms.operation], ["kms", "decrypt"]);
  assert.ok(secretRead(kms));
  assert.ok(blockedChange(cmd("aws --output json iam create-access-key --user-name x")));
  assert.ok(blockedChange(cmd("aws --debug ec2 terminate-instances --instance-ids i-1")));
  const between = cmd("aws ec2 --region ap-south-1 --query=Reservations describe-instances");
  assert.deepEqual([between.service, between.operation], ["ec2", "describe-instances"]);
  assert.deepEqual([cmd("aws --output=json s3 ls").service, cmd("aws --output=json s3 ls").operation], ["s3", "ls"]);
  assert.throws(() => cmd("aws --weird ec2 describe-instances"), { code: "INVALID_ARGUMENT", message: /not an AWS CLI global option/ });
  assert.throws(() => cmd("aws --region ap-south-1"), { code: "INVALID_ARGUMENT" });
});

test("another profile, another endpoint or no TLS check is refused anywhere in the command", () => {
  for (const bad of [
    "aws --profile admin ec2 terminate-instances --instance-ids i-1",
    "aws ec2 describe-instances --profile admin",
    "aws ec2 describe-instances --profile=admin",
    "aws --endpoint-url=https://elsewhere.example ec2 describe-instances",
    "aws s3 ls --no-verify-ssl",
    "aws s3 ls --ca-bundle /tmp/x.pem",
    "aws s3 ls s3://b --no-sign-request",
  ]) {
    assert.throws(() => cmd(bad), { code: "INVALID_ARGUMENT", message: /is not allowed/ }, bad);
  }
});

test("a delete inside escaped JSON and bucket lifecycle rules are blocked", () => {
  assert.ok(blockedChange(cmd('aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch "{\\"Changes\\":[{\\"Action\\":\\"DELETE\\",\\"ResourceRecordSet\\":{}}]}"')));
  assert.ok(blockedChange(cmd("aws s3api put-bucket-lifecycle-configuration --bucket b --lifecycle-configuration x")));
  assert.equal(blockedChange(cmd('aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch "{\\"Changes\\":[{\\"Action\\":\\"UPSERT\\"}]}"')), "");
});

test("a decrypted value and a registry token are left out of the output", () => {
  const out = redact('{"Plaintext": "c2VjcmV0", "AuthorizationToken": "QVdTOnRva2Vu", "KeyId": "k1"}');
  assert.doesNotMatch(out, /c2VjcmV0|QVdTOnRva2Vu/);
  assert.match(out, /"KeyId": "k1"/);
});

test("a profile setting that is not a profile name is reported, never used or suggested", async (t) => {
  const { aws, launches } = setup(t, { awsProfile: "bad name; rm -rf ~" });
  const status = await aws.run({ action: "status" });
  assert.match(status.profile_problem, /not a profile name/);
  await assert.rejects(aws.run({ action: "read", command: "aws ec2 describe-instances" }), { code: "INVALID_SETTING" });
  await assert.rejects(aws.run({ action: "change", command: "aws ec2 start-instances --instance-ids i-1" }), { code: "INVALID_SETTING" });
  assert.deepEqual(launches, []);
  assert.doesNotMatch(hintFor("Token has expired", "bad name; rm -rf ~"), /rm -rf/);
});

test("parallel reads share one read-only server", async (t) => {
  const { aws, launches } = setup(t);
  const results = await Promise.all([
    aws.run({ action: "read", command: "aws ec2 describe-instances" }),
    aws.run({ action: "read", command: "aws ec2 describe-instance-status" }),
    aws.run({ action: "read", command: "aws ec2 describe-volumes" }),
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(launches, ["read-only"]);
});

test("an approved change AWS never answers is recorded as spent, so it cannot run twice", async (t) => {
  const { aws, hub, launches } = setup(t, {}, { budgetMs: 1500, recordMarginMs: 200, minCallMs: 300 });
  hub.approve();
  const started = Date.now();
  await assert.rejects(aws.run({ action: "change", command: "aws ec2 start-instances --instance-ids i-1 hang-forever" }), {
    code: "AWS_ERROR",
    message: /may have run/,
  });
  assert.ok(Date.now() - started < 1500, "it ends inside its budget");
  assert.deepEqual(launches, ["changes"]);
  const executed = hub.calls.find((c) => c[1] === EXECUTED);
  assert.equal(executed[2].ok, 0);
  assert.match(executed[2].log, /may have run/);
});

test("with too little time left an approved change is not started at all", async (t) => {
  const { aws, hub, launches } = setup(t, {}, { budgetMs: 100, recordMarginMs: 200, minCallMs: 300 });
  hub.approve();
  await assert.rejects(aws.run({ action: "change", command: "aws ec2 start-instances --instance-ids i-1" }), { code: "TIMEOUT", message: /nothing has run/ });
  assert.deepEqual(launches, []);
  assert.equal(hub.calls.find((c) => c[1] === EXECUTED), undefined);
});

test("an upload is approved for its content: a changed file needs a new approval", async (t) => {
  const { aws, hub, dataDir } = setup(t);
  const site = path.join(dataDir, "aws-workdir", "site");
  fs.mkdirSync(path.join(site, "css"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<h1>v2</h1>");
  fs.writeFileSync(path.join(site, "css", "main.css"), "h1{}");
  const command = "aws s3 cp site s3://example-bucket/ --recursive";
  const first = await aws.run({ action: "change", command });
  assert.equal(first.status, "waiting for approval");
  const [lookup1, ask] = hub.calls;
  assert.match(lookup1[2].payload.content_sha256, /^[0-9a-f]{64}$/);
  assert.match(ask[2].details, /uploads site: 2 files, \d+ bytes, sha256 [0-9a-f]{16}/);
  fs.writeFileSync(path.join(site, "index.html"), "<h1>v2, edited after the approval</h1>");
  await aws.run({ action: "change", command });
  const lookup2 = hub.calls.filter((c) => c[1] === APPROVED)[1];
  assert.notEqual(lookup2[2].payload.content_sha256, lookup1[2].payload.content_sha256);
  // a command with no local source carries no digest
  await aws.run({ action: "change", command: "aws s3 cp s3://example-bucket s3://example-backup/b1/ --recursive" });
  assert.equal(hub.calls.filter((c) => c[1] === APPROVED)[2][2].payload.content_sha256, undefined);
});

// --- CodeRabbit's second review of PR #24 ---------------------------------------------------------

test("reads that return environment variables or user data are refused, in any form", () => {
  for (const blocked of [
    "aws lambda get-function-configuration --function-name app",
    "aws lambda get-function-configuration --function-name app --query Environment.Variables.DB_PASSWORD --output text",
    "aws lambda get-function --function-name app",
    "aws ecs describe-task-definition --task-definition web",
    "aws elasticbeanstalk describe-configuration-settings --application-name a --environment-name e",
    "aws codebuild batch-get-projects --names build",
    "aws ec2 describe-launch-template-versions --launch-template-id lt-1",
    "aws ec2 describe-instance-attribute --instance-id i-1 --attribute userData",
    "aws ec2 describe-instance-attribute --instance-id i-1 --attribute=userData",
  ]) {
    assert.ok(secretRead(cmd(blocked)), blocked);
  }
  assert.ok(!secretRead(cmd("aws ec2 describe-instance-attribute --instance-id i-1 --attribute instanceType")));
  assert.ok(!secretRead(cmd("aws lambda list-functions")));
});

test("a secret-bearing read never reaches the server", async (t) => {
  const { aws, launches } = setup(t);
  await assert.rejects(aws.run({ action: "read", command: "aws lambda get-function-configuration --function-name app" }), { code: "BLOCKED" });
  assert.deepEqual(launches, []);
});

test("parameters as a JSON or YAML document are refused for every command", async (t) => {
  for (const bad of [
    `aws ssm get-parameter --cli-input-json '{"Name":"/x/password","WithDecryption":true}'`,
    "aws ssm get-parameters --cli-input-yaml=Names:[a]",
    `aws ec2 start-instances --cli-input-json '{"InstanceIds":["i-1"]}'`,
  ]) {
    assert.throws(() => cmd(bad), { code: "INVALID_ARGUMENT", message: /write each parameter as its own option/ }, bad);
  }
  const { aws, hub, launches } = setup(t);
  await assert.rejects(aws.run({ action: "change", command: `aws ec2 start-instances --cli-input-json '{"InstanceIds":["i-1"]}'` }), { code: "INVALID_ARGUMENT" });
  assert.equal(hub.calls.length, 0);
  assert.deepEqual(launches, []);
});

test("the approval names the region the command will run in", async (t) => {
  assert.equal(cmd("aws --region us-east-1 ec2 start-instances --instance-ids i-1").region, "us-east-1");
  assert.equal(cmd("aws ec2 start-instances --instance-ids i-1 --region=eu-west-1").region, "eu-west-1");
  assert.equal(cmd("aws ec2 start-instances --instance-ids i-1").region, null);
  assert.throws(() => cmd("aws --region us-east-1 ec2 start-instances --instance-ids i-1 --region eu-west-1"), { code: "INVALID_ARGUMENT", message: /two different regions/ });
  const { aws, hub } = setup(t); // settings: ap-south-1
  await aws.run({ action: "change", command: "aws --region us-east-1 ec2 start-instances --instance-ids i-1" });
  const [lookup, ask] = hub.calls;
  assert.equal(lookup[2].payload.region, "us-east-1");
  assert.equal(ask[2].payload.region, "us-east-1");
  assert.match(ask[2].details, /region us-east-1/);
  await aws.run({ action: "change", command: "aws ec2 start-instances --instance-ids i-2" });
  assert.equal(hub.calls.filter((c) => c[1] === APPROVED)[1][2].payload.region, "ap-south-1");
});

test("the upload's source is the first of two arguments, whatever options stand before it", async (t) => {
  const { aws, hub, dataDir } = setup(t);
  const work = path.join(dataDir, "aws-workdir");
  for (const name of ["site-old", "site-new"]) {
    fs.mkdirSync(path.join(work, name), { recursive: true });
    fs.writeFileSync(path.join(work, name, "index.html"), `<h1>${name}</h1>`);
  }
  await aws.run({ action: "change", command: "aws s3 cp --exclude site-old site-new s3://example-bucket/ --recursive" });
  await aws.run({ action: "change", command: "aws s3 cp site-new s3://example-bucket/ --recursive" });
  await aws.run({ action: "change", command: "aws s3 cp site-old s3://example-bucket/ --recursive" });
  const [withOption, plainNew, plainOld] = hub.calls.filter((c) => c[1] === APPROVED).map((c) => c[2].payload.content_sha256);
  assert.equal(withOption, plainNew);
  assert.notEqual(withOption, plainOld);
  const ask = hub.calls.find((c) => c[1] === REQUEST);
  assert.match(ask[2].details, /uploads site-new: 1 files/);
});

test("an upload needs exactly a source and a destination inside the work folder, with no links", async (t) => {
  const { aws, hub, dataDir } = setup(t);
  const work = path.join(dataDir, "aws-workdir");
  fs.mkdirSync(path.join(work, "site"), { recursive: true });
  fs.writeFileSync(path.join(work, "site", "index.html"), "<h1>x</h1>");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tbo-aws-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.txt"), "not for upload");
  for (const [command, message] of [
    ["aws s3 cp site extra s3://example-bucket/ --recursive", /exactly a source and a destination/],
    ["aws s3 cp ../../outside s3://example-bucket/ --recursive", /not in the AWS tool's work folder|must be inside/],
    [`aws s3 cp ${outside} s3://example-bucket/ --recursive`, /must be inside the AWS tool's work folder/],
    ["aws s3 cp missing s3://example-bucket/", /not in the AWS tool's work folder/],
  ]) {
    await assert.rejects(aws.run({ action: "change", command }), { code: "INVALID_ARGUMENT", message }, command);
  }
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(work, "site", "link.txt"));
  await assert.rejects(aws.run({ action: "change", command: "aws s3 cp site s3://example-bucket/ --recursive" }), {
    code: "INVALID_ARGUMENT",
    message: /contains a link \(link\.txt\)/,
  });
  assert.equal(hub.calls.length, 0);
  // a download names nothing local to approve
  await aws.run({ action: "change", command: "aws s3 cp s3://example-bucket/index.html site/index.html" });
  assert.equal(hub.calls.filter((c) => c[1] === APPROVED)[0][2].payload.content_sha256, undefined);
});

test("hashing an upload stops at the call's time limit and at 5,000 files, before asking anyone", async (t) => {
  const slow = setup(t, {}, { budgetMs: 50, recordMarginMs: 100 });
  const site = path.join(slow.dataDir, "aws-workdir", "site");
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<h1>x</h1>");
  await assert.rejects(slow.aws.run({ action: "change", command: "aws s3 cp site s3://example-bucket/ --recursive" }), { code: "TIMEOUT", message: /Nothing was asked/ });
  assert.equal(slow.hub.calls.length, 0);
  const many = setup(t);
  const big = path.join(many.dataDir, "aws-workdir", "big");
  fs.mkdirSync(big, { recursive: true });
  for (let i = 0; i <= 5000; i += 1) fs.writeFileSync(path.join(big, `f${i}.txt`), "x");
  await assert.rejects(many.aws.run({ action: "change", command: "aws s3 cp big s3://example-bucket/ --recursive" }), { code: "TOO_LARGE", message: /5000 files/ });
  assert.equal(many.hub.calls.length, 0);
});

// --- CodeRabbit's third review of PR #24 ----------------------------------------------------------

test("a command is split the way the AWS server splits it: quotes and backslashes join a word", () => {
  assert.equal(cmd("aws ec2 start-instances --instance-ids i-1 --reg'ion'=us-east-1").region, "us-east-1");
  assert.equal(cmd('aws ec2 start-instances --instance-ids i-1 --"region" us-east-1').region, "us-east-1");
  assert.equal(cmd("aws ec2 start-instances --instance-ids i-1 --reg\\ion us-east-1").region, "us-east-1");
  assert.deepEqual(cmd(`aws ec2 describe-instances --filters "Name=tag:Name,Values=a \\"b\\" \\c" ''`).parts.slice(4), [
    'Name=tag:Name,Values=a "b" \\c',
    "",
  ]);
  for (const bad of ["aws ec2 describe-instances --filters 'Name=x", 'aws ec2 describe-instances --query "x', "aws ec2 describe-instances \\"]) {
    assert.throws(() => cmd(bad), { code: "INVALID_ARGUMENT" }, bad);
  }
});

test("a shortened option name the checks read is refused, as AWS would read it as the full one", () => {
  for (const [bad, full] of [
    ["aws ec2 start-instances --instance-ids i-1 --re us-east-1", "--region"],
    ["aws ec2 start-instances --instance-ids i-1 --regi=us-east-1", "--region"],
    ["aws --regi us-east-1 ec2 start-instances --instance-ids i-1", "--region"],
    ["aws ec2 start-instances --instance-ids i-1 --prof admin", "--profile"],
    ["aws sns subscribe --topic-arn t --protocol https --endpoint https://example.com/x", "--endpoint-url"],
    ["aws ec2 describe-instances --no-verify", "--no-verify-ssl"],
    [`aws ec2 start-instances --cli-input-js '{"InstanceIds":["i-1"]}'`, "--cli-input-json"],
    ["aws ssm get-parameter --name /x/password --with-decrypt", "--with-decryption"],
    ["aws ec2 describe-instance-attribute --instance-id i-1 --attr userData", "--attribute"],
    ["aws s3 sync site s3://example-bucket/ --del", "--delete"],
    ["aws s3 cp --recurs site-old site-new s3://example-bucket/", "--recursive"],
    ["aws s3api put-object --bucket b --key index.html --bo site/index.html", "--body"],
  ]) {
    assert.throws(() => cmd(bad), { code: "INVALID_ARGUMENT", message: new RegExp(`short for "${full}"`) }, bad);
  }
  assert.throws(() => cmd("aws ec2 start-instances --instance-ids i-1 -- --region us-east-1"), { code: "INVALID_ARGUMENT", message: /bare "--"/ });
  // full names are untouched, also those that begin like a checked one
  assert.equal(cmd("aws ec2 describe-regions --region-names ap-south-1").region, null);
  assert.ok(cmd("aws ec2 stop-instances --instance-ids i-1 --force"));
  assert.ok(cmd("aws s3 cp site s3://example-bucket/ --recursive --exclude '*.map' --size-only"));
});

test("quotes cannot hide a delete or a file from the change checks", () => {
  assert.match(
    blockedChange(cmd(`aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch '{"Changes":[{"Action":"DEL'ETE'"}]}'`)),
    /deletes something/,
  );
  assert.match(blockedChange(cmd("aws s3api put-bucket-policy --bucket b --policy fi'le://'policy.json")), /file:\/\//);
});

test("a change whose region is hidden by quotes names the region it runs in", async (t) => {
  const { aws, hub } = setup(t); // settings: ap-south-1
  await aws.run({ action: "change", command: "aws ec2 start-instances --instance-ids i-1 --reg'ion'=us-east-1" });
  const [lookup, ask] = hub.calls;
  assert.equal(lookup[2].payload.region, "us-east-1");
  assert.match(ask[2].details, /region us-east-1/);
});

test("an upload of one file by --body is approved for the file's content", async (t) => {
  const { aws, hub, dataDir } = setup(t);
  const work = path.join(dataDir, "aws-workdir");
  fs.mkdirSync(path.join(work, "site"), { recursive: true });
  fs.writeFileSync(path.join(work, "site", "index.html"), "<h1>v1</h1>");
  await aws.run({ action: "change", command: "aws s3api put-object --bucket example-bucket --key index.html --body site/index.html" });
  await aws.run({ action: "change", command: "aws s3api put-object --bucket example-bucket --key index.html --body=site/index.html" });
  fs.writeFileSync(path.join(work, "site", "index.html"), "<h1>v1, edited after the approval</h1>");
  await aws.run({ action: "change", command: "aws s3api put-object --bucket example-bucket --key index.html --body site/index.html" });
  await aws.run({ action: "change", command: "aws glacier upload-archive --vault-name v --body site/index.html" });
  const [first, equalsForm, edited, glacier] = hub.calls.filter((c) => c[1] === APPROVED).map((c) => c[2].payload.content_sha256);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(equalsForm, first);
  assert.notEqual(edited, first);
  assert.equal(glacier, edited);
  assert.match(hub.calls.find((c) => c[1] === REQUEST)[2].details, /uploads site\/index\.html: 1 files/);
  // an object with no body names nothing local to approve
  await aws.run({ action: "change", command: "aws s3api put-object --bucket example-bucket --key empty/" });
  assert.equal(hub.calls.filter((c) => c[1] === APPROVED).at(-1)[2].payload.content_sha256, undefined);
});

test("a --body outside the work folder, or given twice, is refused before anyone is asked", async (t) => {
  const { aws, hub, dataDir } = setup(t);
  const work = path.join(dataDir, "aws-workdir");
  fs.mkdirSync(path.join(work, "site"), { recursive: true });
  fs.writeFileSync(path.join(work, "site", "a.html"), "a");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tbo-aws-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.txt"), "not for upload");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(work, "site", "link.txt"));
  for (const [command, message] of [
    [`aws s3api put-object --bucket b --key k --body ${path.join(outside, "secret.txt")}`, /must be inside the AWS tool's work folder/],
    ["aws s3api put-object --bucket b --key k --body site/link.txt", /must be inside the AWS tool's work folder/],
    ["aws s3api put-object --bucket b --key k --body missing.html", /not in the AWS tool's work folder/],
    ["aws s3api put-object --bucket b --key k --body site/a.html --body site/a.html", /Write "--body" once/],
  ]) {
    await assert.rejects(aws.run({ action: "change", command }), { code: "INVALID_ARGUMENT", message }, command);
  }
  assert.equal(hub.calls.length, 0);
});

test("hashing ends at the deadline when a read stalls or a folder answers late, before anyone is asked", async (t) => {
  const { PassThrough } = require("node:stream");
  const stalled = setup(t, {}, { budgetMs: 600, recordMarginMs: 100, files: { createReadStream: () => new PassThrough() } });
  fs.mkdirSync(path.join(stalled.dataDir, "aws-workdir", "site"), { recursive: true });
  fs.writeFileSync(path.join(stalled.dataDir, "aws-workdir", "site", "index.html"), "<h1>x</h1>");
  let started = Date.now();
  await assert.rejects(stalled.aws.run({ action: "change", command: "aws s3 cp site s3://example-bucket/ --recursive" }), { code: "TIMEOUT", message: /Nothing was asked/ });
  assert.ok(Date.now() - started < 1500, "a stalled read ends at the deadline");
  assert.equal(stalled.hub.calls.length, 0);

  const late = (value) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(value), 3000);
      timer.unref();
    });
  const empty = setup(t, {}, { budgetMs: 600, recordMarginMs: 100, files: { readdir: () => late([]) } });
  fs.mkdirSync(path.join(empty.dataDir, "aws-workdir", "empty"), { recursive: true });
  started = Date.now();
  await assert.rejects(empty.aws.run({ action: "change", command: "aws s3 cp empty s3://example-bucket/ --recursive" }), { code: "TIMEOUT" });
  assert.ok(Date.now() - started < 1500, "an empty folder that answers late ends at the deadline");
  assert.equal(empty.hub.calls.length, 0);
});

// --- CodeRabbit's fourth review of PR #24 ---------------------------------------------------------

function snapshots(dataDir) {
  return fs.readdirSync(path.join(dataDir, "aws-workdir")).filter((n) => n.startsWith(".tbo-upload-"));
}

// The hub answers the approval lookup; right after it, something edits the files that were checked.
function editAfterApproval(hub, edit) {
  const lookup = hub.client.method;
  hub.client.method = async (p, params) => {
    const answer = await lookup(p, params);
    if (p === APPROVED && answer) edit();
    return answer;
  };
}

test("an approved upload runs from a snapshot of the checked bytes; a later edit is not uploaded", async (t) => {
  const { aws, hub, dataDir } = setup(t);
  const site = path.join(dataDir, "aws-workdir", "site");
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<h1>approved</h1>");
  const command = `aws s3api put-object --bucket example-bucket --key index.html --metadata '{"note":"two words"}' --body site/index.html`;
  const asked = await aws.run({ action: "change", command });
  assert.equal(asked.status, "waiting for approval");
  assert.deepEqual(snapshots(dataDir), [], "the snapshot of a request is removed");
  hub.approve();
  editAfterApproval(hub, () => fs.writeFileSync(path.join(site, "index.html"), "<h1>edited after the check</h1>"));
  const result = await aws.run({ action: "change", command });
  assert.equal(result.ran, true);
  const out = parsedOutput(result);
  assert.equal(out.body, "<h1>approved</h1>");
  assert.equal(result.command, command);
  // the command that ran is the approved one, word for word, but for the snapshot's path and the region
  const ran = cmd(out.command).parts;
  const approved = cmd(command).parts;
  assert.match(ran[approved.length - 1], /^\.tbo-upload-[^/\\]+[/\\]index\.html$/);
  assert.deepEqual(ran.slice(0, approved.length - 1), approved.slice(0, -1));
  assert.deepEqual(ran.slice(approved.length), ["--region", "ap-south-1"]);
  assert.deepEqual(snapshots(dataDir), [], "the snapshot is removed after the run");
});

test("an approved folder upload sends the folder as checked, not files changed or added later", async (t) => {
  const { aws, hub, dataDir } = setup(t);
  const site = path.join(dataDir, "aws-workdir", "site");
  fs.mkdirSync(path.join(site, "css"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "v1");
  fs.writeFileSync(path.join(site, "css", "main.css"), "h1{}");
  hub.approve();
  editAfterApproval(hub, () => {
    fs.writeFileSync(path.join(site, "index.html"), "v2, not approved");
    fs.writeFileSync(path.join(site, "extra.html"), "not approved");
  });
  const result = await aws.run({ action: "change", command: "aws s3 cp site s3://example-bucket/ --recursive" });
  assert.deepEqual(parsedOutput(result).uploaded, { "css/main.css": "h1{}", "index.html": "v1" });
  assert.deepEqual(snapshots(dataDir), []);
});

test("the work folder itself is not an upload source (its snapshots live there)", async (t) => {
  const { aws, hub } = setup(t);
  for (const command of ["aws s3 cp . s3://example-bucket/ --recursive", "aws s3 sync ./ s3://example-bucket/"]) {
    await assert.rejects(aws.run({ action: "change", command }), { code: "INVALID_ARGUMENT", message: /not the work folder itself/ }, command);
  }
  assert.equal(hub.calls.length, 0);
});

test("a change runs in the region its approval names, even when an ARN names another", async (t) => {
  const { aws, hub } = setup(t); // settings: ap-south-1
  const publish = "aws sns publish --topic-arn arn:aws:sns:us-east-1:123456789012:alerts --message test";
  await aws.run({ action: "change", command: publish });
  const [lookup, ask] = hub.calls;
  assert.equal(lookup[2].payload.region, "ap-south-1");
  assert.match(ask[2].details, /region ap-south-1 \(written into the command when it runs\)/);
  hub.approve();
  const ran = await aws.run({ action: "change", command: publish });
  assert.equal(parsedOutput(ran).command, `${publish} --region ap-south-1`);
  // a command that names its region runs as written
  const named = "aws sns publish --topic-arn arn:aws:sns:us-east-1:123456789012:alerts --message test --region us-east-1";
  assert.equal(parsedOutput(await aws.run({ action: "change", command: named })).command, named);
});

test("a service AWS pins to one region is approved for that region, whatever the command says", async (t) => {
  const { aws, hub } = setup(t); // settings: ap-south-1
  const plain = "aws route53domains update-domain-nameservers --domain-name example.com --nameservers Name=ns1.example.com";
  await aws.run({ action: "change", command: plain });
  await aws.run({ action: "change", command: `${plain} --region eu-west-1` });
  await aws.run({ action: "change", command: "aws globalaccelerator update-accelerator --accelerator-arn arn:aws:globalaccelerator::123456789012:accelerator/a --enabled" });
  const regions = hub.calls.filter((c) => c[1] === APPROVED).map((c) => c[2].payload.region);
  assert.deepEqual(regions, ["us-east-1", "us-east-1", "us-west-2"]);
  hub.approve();
  assert.equal(parsedOutput(await aws.run({ action: "change", command: plain })).command, `${plain} --region us-east-1`);
});
