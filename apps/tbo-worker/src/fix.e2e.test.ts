import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findHostCore, findSidecar, type ProviderConfig, type WorkerConfig } from "./config.js";
import { Engine } from "./engine.js";
import { repoName } from "./fix.js";
import { BUILD_PERSONA, BUILD_RULES, FIX_PERSONA, FIX_RULES, REVIEW_PERSONA, REVIEW_RULES } from "./fix-prompt.js";
import { FIX_TOOL_DEFINITIONS, FIX_TOOL_SEARCH_QUERY, REVIEW_TOOL_DEFINITIONS, REVIEW_TOOL_SEARCH_QUERY } from "./fix-tools.js";
import { GitHubRest } from "./github.js";
import { HubClient, type BuildScope, type Job, type RunContext } from "./hub.js";
import { silentLogger } from "./log.js";
import { PERSONA, RULES } from "./prompt.js";
import { RunToolRouter, Worker } from "./supervisor.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { FakeGitHub } from "./test-support/fake-github.js";
import { FakeModel, type ModelStep } from "./test-support/fake-model.js";
import { FakeSandbox } from "./test-support/fake-sandbox.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-support/git-fixture.js";
import { StubHub } from "./test-support/stub-hub.js";
import { removeWorkspace } from "./workspace.js";

/**
 * A fix job end to end: the real engine (host-core and the sidecar), a
 * scripted model, a stub hub, a fake sandbox that judges the code it runs, a
 * fake GitHub, and a local repository to push to. Needs a built host-core
 * (TBO_TEST_HOST_CORE or `pnpm build:host`); skipped otherwise.
 */
const hostCore = process.env.TBO_TEST_HOST_CORE || findHostCore();
const sidecar = process.env.TBO_TEST_SIDECAR || findSidecar();
const ready = Boolean(hostCore && existsSync(hostCore) && sidecar);

const TEST = `from frappe.tests.utils import FrappeTestCase\n\nfrom demo_app.invoice import validate\n\n\nclass TestMargin(FrappeTestCase):\n    def test_margin_is_a_share_of_the_selling_price(self):\n        doc = type("Doc", (), {"selling": 100, "buying": 80})()\n        validate(doc)\n        self.assertAlmostEqual(doc.margin, 0.2)\n`;
const FIXED = "def validate(doc, method=None):\n    doc.margin = (doc.selling - doc.buying) / doc.selling\n";

function fixScript(): ModelStep[] {
  const write = (path: string, content: string): ModelStep => ({ tool: { name: "Write", arguments: { path, content } } });
  const check: ModelStep = { tool: { name: "sandbox", arguments: { action: "check", module: "demo_app.tests.test_copilot_margin" } } };
  return [
    { tool: { name: "ToolSearch", arguments: { query: FIX_TOOL_SEARCH_QUERY } } },
    write("apps/demo_app/demo_app/tests/test_copilot_margin.py", TEST),
    write("INDEX.md", "planted"),
    check,
    write("apps/demo_app/demo_app/invoice.py", FIXED),
    check,
    { tool: { name: "sandbox", arguments: { action: "migrate" } } },
    {
      tool: {
        name: "fix_done",
        arguments: {
          summary: "the margin rate is a share of the selling price",
          test_module: "demo_app.tests.test_copilot_margin",
          explanation: "validate() divided the selling price by the buying price; it now computes (selling - buying) / selling.",
          people_checks: ["the margin on one real invoice"],
          risk_notes: "Only the margin field changes.",
        },
      },
    },
    { text: "Done." },
    { tool: { name: "ToolSearch", arguments: { query: REVIEW_TOOL_SEARCH_QUERY } } },
    { tool: { name: "review_done", arguments: { findings: [{ severity: "note", file: "demo_app/invoice.py", note: "A zero selling price would divide by zero." }] } } },
    { text: "Reviewed." },
  ];
}

describe.skipIf(!ready)("a fix job end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "tbo-fix-e2e-"));
  let engine: Engine;
  let router: RunToolRouter;
  let stub: StubHub;
  let repo: FixtureRepo;
  let github: FakeGitHub;
  const models: FakeModel[] = [];
  let runNumber = 40;

  beforeAll(async () => {
    repo = makeFixtureRepo();
    stub = await new StubHub().start();
    github = await new FakeGitHub(() => repo.dir).start();
    router = new RunToolRouter(new HubClient(stub.url, { apiKey: "key", apiSecret: "secret" }));
    engine = await Engine.start({
      hostCoreBinary: hostCore!,
      sidecarEntry: sidecar!,
      nodeBinary: process.execPath,
      dataDir: join(root, "data"),
      homeDir: join(root, "home"),
      log: silentLogger,
      tools: TOOL_DEFINITIONS,
      runTool: (sessionId, name, args) => router.run(sessionId, name, args),
      persona: PERSONA,
      rules: RULES,
      profiles: {
        fix: { tools: FIX_TOOL_DEFINITIONS, persona: FIX_PERSONA, rules: FIX_RULES },
        build: { tools: FIX_TOOL_DEFINITIONS, persona: BUILD_PERSONA, rules: BUILD_RULES },
        review: { tools: REVIEW_TOOL_DEFINITIONS, persona: REVIEW_PERSONA, rules: REVIEW_RULES },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await engine?.stop();
    await stub?.stop();
    await github?.stop();
    for (const model of models) await model.stop();
    await removeWorkspace(root);
    await removeWorkspace(repo.dir);
  });

  /** `providers`: the worker's own providers, each at a scripted model; the run context then names `models`. */
  async function runFix(
    script: ModelStep[],
    sandbox: FakeSandbox,
    options: { models?: RunContext["models"]; providers?: Array<{ section: string; script: ModelStep[] }>; build?: BuildScope } = {},
  ) {
    const model = await new FakeModel(script).start();
    models.push(model);
    runNumber += 1;
    const scripted: FakeModel[] = [];
    const providers: ProviderConfig[] = [];
    for (const provider of options.providers ?? []) {
      const fake = await new FakeModel(provider.script).start();
      models.push(fake);
      scripted.push(fake);
      providers.push({
        section: provider.section,
        providerName: `E2E fix ${provider.section} ${runNumber}`,
        baseUrl: fake.url,
        apiKey: "fake-key",
        apiStyle: "chat_completions",
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
      });
    }
    const run = `TBO-RUN-2026-000${runNumber}`;
    const branch = `copilot/TASK-2026-00009-r${runNumber}-a1`;
    const job: Job = {
      run,
      lease_token: `lease-${runNumber}`,
      lease_expires: "",
      context: {
        run,
        kind: "fix",
        shadow: false,
        ticket: { name: "0300", subject: "Margin wrong", description: "<p>The margin rate shows 1.25.</p>", customer: "Demo Co" },
        site: { site_url: "https://demo.example.com", apps: [{ app: "demo_app", repository: repo.dir, branch: "main", deployed_commit: repo.commits[1] }] },
        diagnosis: {
          root_cause_category: "bug",
          confidence: 0.9,
          summary: "validate() divides the selling price by the buying price.",
          proposal: { files: ["demo_app/invoice.py"] },
        },
        fix: {
          task: "TASK-2026-00009",
          closes: "Closes TASK-2026-00009",
          branch,
          attempt: 1,
          max_usd: 0,
          commit_email: "copilot@example.com",
          repositories: [repoName(repo.dir, true)!],
          ...(options.build ? { build: options.build } : {}),
        },
        ...(options.models ? { models: options.models } : {}),
      },
    };
    stub.jobs.push(job);
    const cfg: WorkerConfig = {
      workerId: "fix-worker",
      dir: root,
      dataDir: join(root, "data"),
      homeDir: join(root, "home"),
      reposDir: join(root, "repos"),
      runsDir: join(root, "runs"),
      logsDir: join(root, "logs"),
      hubUrl: stub.url,
      worker: { apiKey: "key", apiSecret: "secret" },
      providers,
      model: {
        providerName: "TBO Worker model",
        baseUrl: model.url,
        modelId: "fake-model",
        apiKey: "fake-key",
        apiStyle: "chat_completions",
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        priceInPerMillion: 1,
        priceOutPerMillion: 2,
      },
      hostCoreBinary: hostCore!,
      sidecarEntry: sidecar!,
      nodeBinary: process.execPath,
      limits: { maxToolCalls: 40, maxMinutes: 5, maxTokens: 1_000_000, maxUsd: 0, claimIntervalMs: 50, heartbeatIntervalMs: 60_000 },
      keepRuns: false,
      repoMap: {},
      allowLocalRepos: true,
      githubApi: github.url,
    };
    const worker = new Worker(cfg, new HubClient(stub.url, cfg.worker), engine, router, silentLogger, sandbox);
    const report = await worker.runOnce(run);
    return { report: report!, model, run, branch, scripted };
  }

  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo.dir, encoding: "utf8" }).trim();

  it("reproduces, fixes, checks on its own, has it reviewed, pushes Copilot's branch and opens the pull request", async () => {
    const sandbox = new FakeSandbox();
    const before = stub.calls.length;
    const { report, run, branch } = await runFix(fixScript(), sandbox);

    expect(report.outcome).toBe("submitted");
    expect(report.submission).toBe(`${repoName(repo.dir, true)}#7`);
    // the push: Copilot's own branch, its own author, the test and the fix
    expect(git("log", "-1", "--format=%ae %s", branch)).toBe("copilot@example.com fix: the margin rate is a share of the selling price");
    expect(git("show", `${branch}:demo_app/invoice.py`)).toContain("(doc.selling - doc.buying) / doc.selling");
    expect(git("show", `${branch}:demo_app/tests/test_copilot_margin.py`)).toContain("assertAlmostEqual");
    // the pull request
    const pull = github.calls.find((call) => call.path.endsWith("/pulls"))!;
    expect(pull.auth).toBe("Bearer push-key");
    expect(pull.body).toMatchObject({ title: "TASK-2026-00009: the margin rate is a share of the selling price", head: branch, base: "main" });
    expect(String(pull.body.body)).toContain("Closes TASK-2026-00009");
    expect(String(pull.body.body)).toContain("| the bug shows before the fix (demo_app.tests.test_copilot_margin) | ✅ |");
    expect(String(pull.body.body)).toContain("A zero selling price would divide by zero.");
    expect(github.calls.find((call) => call.path.endsWith("/labels"))!.body).toEqual({ labels: ["copilot", "no-auto-merge"] });
    // the report to TBO Support, with the worker's own evidence
    const change = stub.callsTo("submit_change").at(-1)!;
    const args = (change.body.params as { arguments: Record<string, unknown> }).arguments;
    expect(args).toMatchObject({ number: 7, branch, tested_on: "a fake sandbox site" });
    expect((args.evidence as Array<{ result: string }>).map((item) => item.result)).toEqual(["pass", "pass", "pass", "not_run", "pass", "pass"]);
    // the AI could write in the app only; the sandbox copy was stopped
    const events = stub.calls.slice(before).filter((call) => call.path.endsWith("post_events")).flatMap((call) => call.body.events as Array<{ type: string; payload: Record<string, unknown> }>);
    expect(events.some((event) => event.type === "permission_denied" && String(event.payload.args).includes("INDEX.md"))).toBe(true);
    expect(events.filter((event) => event.type === "permission_allowed").length).toBeGreaterThanOrEqual(2);
    expect(sandbox.stopped).toEqual(["sbx-1"]);
    expect(stub.callsTo("submit_result").filter((call) => call.body.run === run)).toHaveLength(0);
  }, 180_000);

  it("does not take a check that errors on the code the site runs as the bug shown", async () => {
    const sandbox = new FakeSandbox();
    sandbox.errorsBefore = true;
    const before = stub.calls.length;
    const { report, branch, model } = await runFix(fixScript().slice(0, 9), sandbox);

    // the round's own check found it, and the model is sent back to its test (here the
    // scripted model has nothing more to say); nothing is pushed
    const events = stub.calls.slice(before).filter((call) => call.path.endsWith("post_events")).flatMap((call) => call.body.events as Array<{ type: string; payload: Record<string, unknown> }>);
    const verified = events.find((event) => event.type === "verified")!;
    expect(verified.payload.evidence).toEqual([["the bug shows before the fix (demo_app.tests.test_copilot_margin)", "fail"]]);
    expect(report.outcome).toBe("failed");
    expect(() => git("rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
    // a crash that is the bug itself: the round's feedback says how to show it (and not to mock it
    // away); only that message is read, since the fix rules say the same and would always match
    expect(againFeedback(model)).toContain("self.fail with the exception");
  }, 180_000);

  it("stops at once, without a check round, when Copilot says it cannot fix it, and hands its explanation on", async () => {
    const sandbox = new FakeSandbox();
    const before = stub.calls.length;
    const why = "No test fails on the unchanged code: the margin is already right for every invoice I tried; the reported invoice may have been edited by hand.";
    const script: ModelStep[] = [
      fixScript()[0]!,
      { tool: { name: "fix_done", arguments: { summary: "", test_module: "", explanation: why, cannot_fix: true } } },
      { text: "Stopped." },
    ];
    const { report, run, branch } = await runFix(script, sandbox);

    expect(report.outcome).toBe("failed");
    expect(report.reason).toBe(`it stopped by itself and explains: ${why}`);
    const events = stub.calls.slice(before).filter((call) => call.path.endsWith("post_events")).flatMap((call) => call.body.events as Array<{ type: string }>);
    expect(events.some((event) => event.type === "verified")).toBe(false); // no check round spent
    expect(sandbox.calls.filter((call) => call.startsWith("check"))).toEqual([]);
    const failure = stub.callsTo("submit_result").find((call) => call.body.run === run)!;
    expect(String((failure.body.result as { reason: string }).reason)).toContain("the reported invoice may have been edited by hand");
    expect(() => git("rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
  }, 180_000);

  it("opens no pull request when the review gives no verdict", async () => {
    const sandbox = new FakeSandbox();
    const pulls = github.calls.filter((call) => call.path.endsWith("/pulls")).length;
    // the reviewer answers in words twice (the review and its one reminder) and never calls review_done
    const script = [...fixScript().slice(0, 10), { text: "The change looks right." }, { text: "Still looks right." }];
    const { report, run, branch } = await runFix(script, sandbox);

    expect(report.outcome).toBe("failed");
    expect(report.reason).toContain("the review ended without a verdict");
    expect(github.calls.filter((call) => call.path.endsWith("/pulls"))).toHaveLength(pulls);
    expect(() => git("rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
    const failure = stub.callsTo("submit_result").find((call) => call.body.run === run)!;
    expect(String((failure.body.result as { reason: string }).reason)).toContain("without a verdict");
  }, 180_000);

  it("restarts the fix once on the fallback model when the provider fails, and reviews on the review's own model", async () => {
    const sandbox = new FakeSandbox();
    const before = stub.calls.length;
    const { report, scripted } = await runFix([{ text: "The older model is never asked." }], sandbox, {
      models: {
        fix: [
          { section: "OpenAI", model: "luna-fake", price_in: 1, price_out: 2 },
          { section: "Anthropic-compatible", model: "kimi-fake", price_in: 0.5, price_out: 1 },
        ],
        review: [{ section: "Anthropic-compatible", model: "kimi-review-fake", price_in: 0.5, price_out: 1 }],
      },
      providers: [
        // the key is out of credit: re-sending cannot help, so the turn fails at once
        { section: "OpenAI", script: [{ fail: { status: 429, message: "You exceeded your current quota (insufficient_quota)" } }] },
        { section: "Anthropic-compatible", script: fixScript() },
      ],
    });

    expect(report.outcome).toBe("submitted");
    expect(scripted[0]!.requests).toHaveLength(1);
    // the fresh session is told that the stopped one may have left edits
    expect(JSON.stringify(scripted[1]!.requests[0]!.messages)).toContain("stopped part-way through this fix");
    const events = stub.calls.slice(before).filter((call) => call.path.endsWith("post_events")).flatMap((call) => call.body.events as Array<{ type: string; payload: Record<string, unknown> }>);
    expect(events.filter((event) => event.type === "fallback").map((event) => [event.payload.job, event.payload.model, event.payload.after])).toEqual([
      ["fix", "kimi-fake", "PROVIDER_RATE_LIMITED"],
    ]);
    const args = (stub.callsTo("submit_change").at(-1)!.body.params as { arguments: { cost: { stages: Array<Record<string, unknown>> } } }).arguments;
    expect(args.cost.stages.map((stage) => [stage.job, stage.model, stage.fallback])).toEqual([
      ["fix", "kimi-fake", true],
      ["review", "kimi-review-fake", false],
    ]);
  }, 180_000);

  it("does not take a fix whose test passes on the code the site runs, and sends the model back to its test", async () => {
    const sandbox = new FakeSandbox();
    sandbox.alwaysPasses = true;
    const before = stub.calls.length;
    const { report, branch, model } = await runFix(fixScript().slice(0, 9), sandbox);

    // the bug was never shown: another round is asked for (here the scripted model has nothing more to say)
    const events = stub.calls.slice(before).filter((call) => call.path.endsWith("post_events")).flatMap((call) => call.body.events as Array<{ type: string; payload: Record<string, unknown> }>);
    expect(events.find((event) => event.type === "verified")!.payload.evidence).toEqual([["the bug shows before the fix", "fail"]]);
    const again = againFeedback(model);
    expect(again).toContain("the bug does not show before the fix");
    expect(again).toContain("a mock, stub or patch of that code hides the bug");
    expect(report.outcome).toBe("failed");
    expect(() => git("rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
  }, 180_000);

  it("builds an approved customization to its scope: a test per check, its own rules, the scope in the pull request", async () => {
    const build: BuildScope = {
      scope: "A Sales Invoice cannot be submitted without a Sales Team row. Returns are not affected.",
      checks: ["an invoice without a Sales Team row is refused", "a return without one is not", "the message says what to add"],
      hours: 4,
      hash: "h",
    };
    const sandbox = new FakeSandbox();
    // the new rule's tests pass once invoice.py requires the row; the return's hold already
    sandbox.judge = (module, mount) => {
      const built = readFileSync(join(mount, "demo_app", "invoice.py"), "utf8").includes("sales_team");
      const ok = module.endsWith("test_copilot_returns") || built;
      return ok
        ? { ok: true, exit_code: 0, output: "Ran 2 tests\nOK", ms: 100 }
        : { ok: false, exit_code: 1, output: "AssertionError: ValidationError not raised\nFAILED (failures=1)", ms: 100, failure: "assertion" };
    };
    const { report, branch, model } = await runFix(buildScript(build), sandbox, { build });

    expect(report.outcome).toBe("submitted");
    expect(git("log", "-1", "--format=%s", branch)).toBe("feat: a Sales Invoice needs a Sales Team row");
    // the build's own rules and the customer's scope reached the model
    const first = JSON.stringify(model.requests[0]!.messages);
    expect(first).toContain("How this build works");
    expect(first).toContain("Returns are not affected.");
    const body = String(github.calls.filter((call) => call.path.endsWith("/pulls")).at(-1)!.body.body);
    expect(body).toContain("## Scope the customer approved");
    expect(body).toContain("| an invoice without a Sales Team row is refused | `demo_app.tests.test_copilot_sales_team` | fail | pass |");
    expect(body).toContain("| a return without one is not | `demo_app.tests.test_copilot_returns` | pass | pass |");
    expect(body).toContain("not testable: the message is shown in the browser");
    const args = (stub.callsTo("submit_change").at(-1)!.body.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.check_results).toEqual([
      { check: build.checks[0], test: "demo_app.tests.test_copilot_sales_team", before: "fail", after: "pass", note: "" },
      { check: build.checks[1], test: "demo_app.tests.test_copilot_returns", before: "pass", after: "pass", note: "" },
      { check: build.checks[2], test: "", before: "not_testable", after: "not_testable", note: "the message is shown in the browser" },
    ]);
  }, 180_000);
});

function buildScript(build: BuildScope): ModelStep[] {
  const write = (path: string, content: string): ModelStep => ({ tool: { name: "Write", arguments: { path, content } } });
  const check = (module: string): ModelStep => ({ tool: { name: "sandbox", arguments: { action: "check", module } } });
  return [
    { tool: { name: "ToolSearch", arguments: { query: FIX_TOOL_SEARCH_QUERY } } },
    write("apps/demo_app/demo_app/tests/test_copilot_sales_team.py", "from frappe.tests.utils import FrappeTestCase\n"),
    write("apps/demo_app/demo_app/tests/test_copilot_returns.py", "from frappe.tests.utils import FrappeTestCase\n"),
    check("demo_app.tests.test_copilot_sales_team"),
    write("apps/demo_app/demo_app/invoice.py", "def validate(doc, method=None):\n    if not doc.is_return and not doc.sales_team:\n        raise ValueError('Add at least one Sales Person in the Sales Team table.')\n"),
    check("demo_app.tests.test_copilot_sales_team"),
    check("demo_app.tests.test_copilot_returns"),
    { tool: { name: "sandbox", arguments: { action: "migrate" } } },
    {
      tool: {
        name: "fix_done",
        arguments: {
          summary: "a Sales Invoice needs a Sales Team row",
          test_module: "demo_app.tests.test_copilot_sales_team",
          explanation: "validate() refuses an invoice without a Sales Team row; returns are left alone.",
          check_results: [
            { check: build.checks[0], test_module: "demo_app.tests.test_copilot_sales_team" },
            { check: build.checks[1], test_module: "demo_app.tests.test_copilot_returns" },
            { check: build.checks[2], not_testable: "the message is shown in the browser" },
          ],
        },
      },
    },
    { text: "Done." },
    { tool: { name: "ToolSearch", arguments: { query: REVIEW_TOOL_SEARCH_QUERY } } },
    { tool: { name: "review_done", arguments: { findings: [] } } },
    { text: "Reviewed." },
  ];
}

/** The worker's feedback for another round (againPrompt), as the model got it: that message only. */
function againFeedback(model: FakeModel): string {
  const texts = model.requests
    .flatMap((request) => request.messages)
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
  return texts.find((text) => text.includes("Your fix needs another round")) ?? "";
}

describe("the pull request client", () => {
  it("speaks GitHub's REST API with the push key", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ number: 3, html_url: "u", head: { sha: "abc" } }), { status: 201 });
    }) as unknown as typeof fetch;
    const pull = await new GitHubRest("https://api.example.com", fake).createPull("acme/app", "k", { title: "t", head: "copilot/x", base: "main", body: "b" });
    expect(pull.number).toBe(3);
    expect(seen[0]!.url).toBe("https://api.example.com/repos/acme/app/pulls");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });
});
