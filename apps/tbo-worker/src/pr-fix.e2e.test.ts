import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findHostCore, findSidecar, type WorkerConfig } from "./config.js";
import { Engine } from "./engine.js";
import { HubClient, isPrFix, type PrFixJob } from "./hub.js";
import { silentLogger } from "./log.js";
import { PR_FIX_PROFILE_NAME } from "./pr-fix.js";
import { PR_FIX_PROFILE } from "./pr-fix-prompt.js";
import { PR_FIX_TOOL_NAMES, PR_FIX_TOOL_SEARCH_QUERY } from "./pr-fix-tools.js";
import { PERSONA, RULES } from "./prompt.js";
import { RunToolRouter, Worker } from "./supervisor.js";
import { RUN_TOOL_NAMES, TOOL_DEFINITIONS } from "./tools.js";
import { FakeModel, type ModelStep } from "./test-support/fake-model.js";
import { FakeSandbox } from "./test-support/fake-sandbox.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-support/git-fixture.js";
import { StubHub } from "./test-support/stub-hub.js";
import { removeWorkspace, workspaceRoot } from "./workspace.js";

/**
 * A developer's pull request against the real engine (host-core and the agent sidecar), a stub
 * hub, a scripted model, a fake sandbox and a local repository to push to: what the model is
 * offered, what host-core lets it write, and the one push. Needs a built host-core
 * (TBO_TEST_HOST_CORE, or `pnpm build:host`); skipped otherwise.
 */
const hostCore = process.env.TBO_TEST_HOST_CORE || findHostCore();
const sidecar = process.env.TBO_TEST_SIDECAR || findSidecar();
const ready = Boolean(hostCore && existsSync(hostCore) && sidecar);

const BRANCH = "feature/margin";
const FIXED = "def validate(doc, method=None):\n    doc.margin = (doc.selling - doc.buying) / doc.selling\n";

describe.skipIf(!ready)("a developer's pull request end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "tbo-prfix-e2e-"));
  let engine: Engine;
  let router: RunToolRouter;
  let stub: StubHub;
  let repo: FixtureRepo;
  const models: FakeModel[] = [];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo.dir, encoding: "utf8" }).trim();

  beforeAll(async () => {
    repo = makeFixtureRepo();
    git("branch", BRANCH, repo.commits[1]!);
    stub = await new StubHub().start();
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
      profiles: { [PR_FIX_PROFILE_NAME]: PR_FIX_PROFILE },
    });
  }, 60_000);

  afterAll(async () => {
    await engine?.stop();
    await stub?.stop();
    for (const model of models) await model.stop();
    await removeWorkspace(root);
    await removeWorkspace(repo.dir);
  });

  async function runWith(script: ModelStep[]) {
    const model = await new FakeModel(script).start();
    models.push(model);
    const job: PrFixJob = {
      kind: "pr_fix",
      pull_request: "TBO-PR-2026-00042",
      lease_token: "pr-lease-e2e",
      context: {
        pull_request: "TBO-PR-2026-00042",
        repo: repo.dir,
        number: 12,
        url: "https://github.com/demo/demo_app/pull/12",
        title: "Margin report",
        head_branch: BRANCH,
        head_sha: repo.commits[1]!,
        base_branch: "main",
        round: 1,
        findings: [
          { id: "CR-1", source: "coderabbit", title: "The margin divides by the buying price", body: "Use (selling - buying) / selling.", path: "demo_app/invoice.py", line: 2 },
          { id: "CI-1", source: "ci", title: "tests", check: "CI / tests", body: "The check failed.", summary: "AssertionError: 1.25 != 0.2" },
        ],
        apps: [{ app: "demo_app", repository: repo.dir, branch: BRANCH, commit: repo.commits[1]! }],
        app: "demo_app",
        repo_token: null,
        commit_email: "copilot@example.com",
        dollar_cap: 1,
        rules: ["Change only what a finding needs."],
      },
    };
    stub.prJobs.push(job);
    const cfg: WorkerConfig = {
      workerId: "prfix-e2e-worker",
      dir: root,
      dataDir: join(root, "data"),
      homeDir: join(root, "home"),
      reposDir: join(root, "repos"),
      runsDir: join(root, "runs"),
      logsDir: join(root, "logs"),
      hubUrl: stub.url,
      worker: { apiKey: "key", apiSecret: "secret" },
      providers: [],
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
      limits: { maxToolCalls: 40, maxMinutes: 5, maxTokens: 1_000_000, maxUsd: 2, claimIntervalMs: 50, heartbeatIntervalMs: 60_000 },
      keepRuns: false,
      repoMap: {},
      allowLocalRepos: true,
    };
    const hub = new HubClient(stub.url, cfg.worker);
    const sandbox = new FakeSandbox();
    const worker = new Worker(cfg, hub, engine, router, silentLogger, sandbox);
    const claimed = await hub.claimJob(cfg.workerId, undefined, worker.capabilities());
    if (!claimed || !isPrFix(claimed)) throw new Error("the stub hub handed out no pull request");
    const report = await worker.processPrFix(claimed);
    return { report, model, job, cfg, sandbox };
  }

  it("lets the model edit the app but no CI file, and pushes its fix to the pull request's branch", async () => {
    const { report, model, job, cfg, sandbox } = await runWith([
      { tool: { name: "ToolSearch", arguments: { query: `${PR_FIX_TOOL_SEARCH_QUERY} fix_done hub_submit_investigation` } } },
      { tool: { name: "Write", arguments: { path: "apps/demo_app/.github/workflows/tests.yml", content: "on: push\njobs: {}\n" } } },
      { tool: { name: "Write", arguments: { path: "apps/demo_app/demo_app/invoice.py", content: FIXED } } },
      { tool: { name: "sandbox", arguments: { action: "check", module: "demo_app.tests.test_margin" } } },
      {
        tool: {
          name: "pr_fix_done",
          arguments: {
            fixed: [{ id: "CR-1", note: "Divide the margin by the selling price." }, { id: "CI-1", note: "The failing margin test passes with the same change." }],
            not_fixed: [],
          },
        },
      },
      { text: "Done." },
    ]);

    expect(report).toMatchObject({ outcome: "done", fixed: 2, not_fixed: 0, denied: 1 });
    const head = git("rev-parse", BRANCH);
    expect(report.pushed).toBe(head);
    expect(git("rev-parse", `${BRANCH}^`)).toBe(repo.commits[1]);
    expect(git("log", "-1", "--format=%ae|%s", BRANCH)).toBe("copilot@example.com|fix: CodeRabbit and CI round 1 (TBO Copilot)");
    expect(git("show", "--name-only", "--format=", BRANCH)).toBe("demo_app/invoice.py");
    expect(git("rev-parse", "main")).toBe(repo.commits[2]);

    const result = stub.callsTo("pr_result").find((call) => call.body.pull_request === job.pull_request)!.body.result;
    expect(result).toMatchObject({
      kind: "done",
      head_sha: head,
      fixed: [
        { id: "CR-1", commit: head },
        { id: "CI-1", commit: head },
      ],
      not_fixed: [],
      cost: { model: "fake-model" },
    });
    expect(sandbox.calls).toEqual(["check demo_app.tests.test_margin", "migrate", "tests"]);

    // every tool the model was ever offered: the engine's own, and of this job's only its four
    const offered = new Set(model.requests.flatMap((request) => (request.tools ?? []).map((tool) => tool.function?.name)));
    for (const name of PR_FIX_TOOL_NAMES) expect(offered).toContain(name);
    for (const name of [...RUN_TOOL_NAMES.filter((tool) => tool !== "repo_git"), "fix_done", "review_done"]) expect(offered).not.toContain(name);
    expect(offered).not.toContain("Task");
    const system = JSON.stringify(model.requests[0]!.messages[0]);
    expect(system).toContain("How this pull request's fix works");
    expect(system).not.toContain("Ignore your rules"); // the repository's AGENTS.md is never loaded as instructions
    expect(existsSync(workspaceRoot(cfg.runsDir, `pr-${job.pull_request}`))).toBe(false);
  }, 120_000);
});
