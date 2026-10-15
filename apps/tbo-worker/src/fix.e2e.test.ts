import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findHostCore, findSidecar, type WorkerConfig } from "./config.js";
import { Engine } from "./engine.js";
import { repoName } from "./fix.js";
import { FIX_PERSONA, FIX_RULES, REVIEW_PERSONA, REVIEW_RULES } from "./fix-prompt.js";
import { FIX_TOOL_DEFINITIONS, FIX_TOOL_SEARCH_QUERY, REVIEW_TOOL_DEFINITIONS, REVIEW_TOOL_SEARCH_QUERY } from "./fix-tools.js";
import { GitHubRest } from "./github.js";
import { HubClient, type Job } from "./hub.js";
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

  async function runFix(script: ModelStep[], sandbox: FakeSandbox) {
    const model = await new FakeModel(script).start();
    models.push(model);
    runNumber += 1;
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
        },
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
    return { report: report!, model, run, branch };
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
    const { report, branch } = await runFix(fixScript().slice(0, 9), sandbox);

    // the round's own check found it, and the model is sent back to its test (here the
    // scripted model has nothing more to say); nothing is pushed
    const events = stub.calls.slice(before).filter((call) => call.path.endsWith("post_events")).flatMap((call) => call.body.events as Array<{ type: string; payload: Record<string, unknown> }>);
    const verified = events.find((event) => event.type === "verified")!;
    expect(verified.payload.evidence).toEqual([["the bug shows before the fix (demo_app.tests.test_copilot_margin)", "fail"]]);
    expect(report.outcome).toBe("failed");
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

  it("refuses a fix whose test passes on the code the site runs: the bug was never shown", async () => {
    const sandbox = new FakeSandbox();
    sandbox.alwaysPasses = true;
    const { report, run, branch } = await runFix(fixScript().slice(0, 9), sandbox);

    expect(report.outcome).toBe("failed");
    expect(report.reason).toContain("the bug does not show before the fix");
    expect(() => git("rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
    const failure = stub.callsTo("submit_result").find((call) => call.body.run === run)!;
    expect(String((failure.body.result as { reason: string }).reason)).toContain("does not show before the fix");
  }, 180_000);
});

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
