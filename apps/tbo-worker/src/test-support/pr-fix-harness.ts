import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";

import type { FixLimits, Limits, WorkerConfig } from "../config.js";
import { HubClient, isPrFix, type PrFinding, type PrFixContext, type PrFixJob, type PrFixResult } from "../hub.js";
import { silentLogger } from "../log.js";
import type { SandboxResult } from "../sandbox.js";
import { RunToolRouter, Worker } from "../supervisor.js";
import { removeWorkspace } from "../workspace.js";
import { FakeSandbox } from "./fake-sandbox.js";
import { makeFixtureRepo, type FixtureRepo } from "./git-fixture.js";
import { ScriptedEngine, type EngineStep } from "./scripted-engine.js";
import { StubHub } from "./stub-hub.js";

/**
 * A developer's pull request's fix (Phase 26) without host-core: a stub hub, a scripted engine, a
 * fake sandbox and a local repository with the pull request's branch to push to.
 */

export const BRANCH = "feature/margin";
export const FIXED = "def validate(doc, method=None):\n    doc.margin = (doc.selling - doc.buying) / doc.selling\n";
export const CODERABBIT: PrFinding = {
  id: "CR-1",
  source: "coderabbit",
  title: "The margin divides by the buying price",
  body: "`validate()` computes `selling / buying`; a margin is `(selling - buying) / selling`.",
  path: "demo_app/invoice.py",
  line: 2,
};
export const CI: PrFinding = {
  id: "CI-1",
  source: "ci",
  title: "lint",
  check: "linters / ruff",
  body: "The check failed.",
  summary: "demo_app/hooks.py:1:1: E501 line too long (130 > 120)",
};
export const DONE = {
  fixed: [{ id: "CR-1", note: "Divide the margin by the selling price." }],
  not_fixed: [{ id: "CI-1", why: "hooks.py line 1 is 98 characters, under the limit of 120: the check ran on an older commit." }],
};
export const ONE_DOLLAR = { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 };
export const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Developer",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Developer",
  GIT_COMMITTER_EMAIL: "dev@example.com",
};
export const git = (repo: FixtureRepo, ...args: string[]) => execFileSync("git", args, { cwd: repo.dir, env: gitEnv, encoding: "utf8" }).trim();

/** The fixture app with a developer's branch at its buggy commit: the pull request's head. */
export function prRepo(): FixtureRepo {
  const repo = makeFixtureRepo();
  git(repo, "branch", BRANCH, repo.commits[1]!);
  return repo;
}

/** The developer pushes one more commit to the pull request's branch. */
export function developerPushes(repo: FixtureRepo): string {
  git(repo, "checkout", "--quiet", BRANCH);
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "wip: the report's layout");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "--quiet", "main");
  return head;
}

/** The developer commits files to the pull request's branch; its new head. */
export function commitOnBranch(repo: FixtureRepo, files: Record<string, string>): string {
  git(repo, "checkout", "--quiet", BRANCH);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), content);
  }
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "-m", "feat: the report's rate");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "--quiet", "main");
  return head;
}

/**
 * One of the remote's hooks: pre-receive runs before the remote takes the push (it may refuse it),
 * post-receive after it took it, before the pusher hears the end.
 */
export function remoteHook(repo: FixtureRepo, name: "pre-receive" | "post-receive", script: string): void {
  writeFileSync(join(repo.dir, ".git", "hooks", name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

/** In a hook: the developer's commit on top of `parent` ($new: the pushed commit, $old: the head before). */
export const DEVELOPER_COMMIT = (parent: string) =>
  `next=$(GIT_AUTHOR_NAME=Dev GIT_AUTHOR_EMAIL=dev@example.com GIT_COMMITTER_NAME=Dev GIT_COMMITTER_EMAIL=dev@example.com git commit-tree "${parent}^{tree}" -p "${parent}" -m "the developer's push")`;

export const PASSED: SandboxResult = { ok: true, exit_code: 0, output: "Ran 4 tests\nOK", ms: 200 };
export const FAILED: SandboxResult = { ok: false, exit_code: 1, output: "AssertionError: 1.25 != 0.2\nFAILED (failures=1)", ms: 200, failure: "assertion" };
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The app's tests on a sandbox copy, judged from the code mounted on that copy. */
export function judgeTests(sandbox: FakeSandbox, passes: (code: string) => boolean, file = "demo_app/invoice.py"): void {
  sandbox.tests = async (id: string): Promise<SandboxResult> => {
    sandbox.calls.push("tests");
    const code = readFileSync(join(sandbox.mounts.get(id)!, file), "utf8");
    return passes(code) ? PASSED : FAILED;
  };
}

/** The stub hub, a folder for the worker, and one pull request claimed and fixed per `runWith`. */
export class PrFixHarness {
  readonly root = mkdtempSync(join(tmpdir(), "tbo-worker-prfix-"));
  stub!: StubHub;
  private count = 0;

  async start(): Promise<void> {
    this.stub = await new StubHub().start();
  }

  async stop(): Promise<void> {
    await this.stub?.stop();
    await removeWorkspace(this.root);
  }

  prJob(repo: FixtureRepo, context: Partial<PrFixContext> = {}): PrFixJob {
    this.count += 1;
    const name = `TBO-PR-2026-0000${this.count}`;
    return {
      kind: "pr_fix",
      pull_request: name,
      lease_token: `pr-lease-${this.count}`,
      lease_expires: "",
      context: {
        pull_request: name,
        repo: repo.dir,
        number: 12,
        url: "https://github.com/demo/demo_app/pull/12",
        title: "Margin report",
        head_branch: BRANCH,
        head_sha: repo.commits[1]!,
        base_branch: "main",
        round: 1,
        findings: [CODERABBIT, CI],
        task: { name: "TASK-2026-00031", subject: "A margin report" },
        apps: [
          { app: "frappe", repository: "frappe/frappe", branch: "version-15", commit: "f".repeat(40) },
          { app: "demo_app", repository: repo.dir, branch: BRANCH, commit: repo.commits[1]! },
        ],
        app: "demo_app",
        repo_token: null,
        commit_email: "copilot@example.com",
        dollar_cap: 1,
        rules: ["Change only what a finding needs."],
        ...context,
      },
    };
  }

  config(limits: Partial<Limits> = {}, fixLimits: Partial<FixLimits> = {}): WorkerConfig {
    return {
      workerId: "prfix-test-worker",
      dir: this.root,
      dataDir: join(this.root, "data"),
      homeDir: join(this.root, "home"),
      reposDir: join(this.root, "repos"),
      runsDir: join(this.root, "runs"),
      logsDir: join(this.root, "logs"),
      hubUrl: this.stub.url,
      worker: { apiKey: "key", apiSecret: "secret" },
      providers: [],
      model: {
        providerName: "TBO Worker model",
        baseUrl: "http://127.0.0.1:9/v1",
        modelId: "fake-model",
        apiKey: "fake-key",
        apiStyle: "chat_completions",
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        priceInPerMillion: 1,
        priceOutPerMillion: 2,
      },
      hostCoreBinary: "unused",
      sidecarEntry: "unused",
      nodeBinary: process.execPath,
      limits: { maxToolCalls: 40, maxMinutes: 5, maxTokens: 10_000_000, maxUsd: 2, claimIntervalMs: 50, heartbeatIntervalMs: 60_000, ...limits },
      fixLimits: { maxToolCalls: 60, maxMinutes: 10, maxTokens: 10_000_000, maxRounds: 3, ...fixLimits },
      keepRuns: false,
      repoMap: {},
      allowLocalRepos: true,
    };
  }

  /** One pull request claimed through the stub hub, a scripted engine playing the model's turns. */
  async runWith(
    turns: EngineStep[][],
    options: { repo?: FixtureRepo; context?: Partial<PrFixContext>; sandbox?: FakeSandbox; limits?: Partial<Limits>; fixLimits?: Partial<FixLimits>; profiles?: string[] } = {},
  ) {
    const repo = options.repo ?? prRepo();
    const job = this.prJob(repo, options.context);
    this.stub.prJobs.push(job);
    const cfg = this.config(options.limits, options.fixLimits);
    const hub = new HubClient(this.stub.url, cfg.worker);
    const router = new RunToolRouter(hub);
    const scripted = new ScriptedEngine((sessionId, name, args) => router.run(sessionId, name, args), turns, options.profiles ?? ["pr_fix"]);
    const sandbox = options.sandbox ?? new FakeSandbox();
    const worker = new Worker(cfg, hub, scripted.engine, router, silentLogger, sandbox);
    const claimed = await hub.claimJob(cfg.workerId, undefined, worker.capabilities());
    expect(claimed && isPrFix(claimed) ? claimed.pull_request : null).toBe(job.pull_request);
    const report = await worker.processPrFix(claimed as PrFixJob);
    const mine = (name: string) => this.stub.callsTo(name).filter((call) => call.body.pull_request === job.pull_request);
    const results = () => mine("pr_result").map((call) => call.body.result as PrFixResult);
    return { report, job, repo, cfg, router, scripted, sandbox, mine, results };
  }
}
