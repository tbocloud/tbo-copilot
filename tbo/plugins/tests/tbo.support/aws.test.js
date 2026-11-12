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

function setup(t, settings = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tbo-aws-test-"));
  const hub = fakeHub();
  const launches = [];
  const values = { awsProfile: "tbo-readonly", awsRegion: "ap-south-1", awsAllowChanges: true, ...settings };
  const aws = createAws({
    getSettings: async () => values,
    getDataPath: async () => dataDir,
    hub: async () => hub.client,
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
  assert.equal(out.command, TXT_CHANGE);
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
