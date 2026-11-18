import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelConfig, WorkerConfig } from "./config.js";
import type { Engine, TurnObserver, TurnResult } from "./engine.js";
import { DEFAULT_FIX_LIMITS, SECRET, codeAsTheSiteRunsIt, pushEnv, repoName } from "./fix.js";
import { restartPrompt } from "./fix-prompt.js";
import { HubError, type HubClient, type PrFinding, type PrFixContext, type PrFixJob, type PrFixResult, type PrTests } from "./hub.js";
import type { Logger } from "./log.js";
import { StageModels, noModelReason, stageModels, type StageModel } from "./models.js";
import { RunBudget, isCiPath, pullRequestEdits, smallestCap } from "./policy.js";
import { MAX_FINDINGS, PR_FIX_NUDGE, prFixAgainPrompt, prFixPrompt, type PrCheckProblem } from "./pr-fix-prompt.js";
import { changedPaths, type PrFixDone, type PrFixToolState } from "./pr-fix-tools.js";
import { gitEnv, runGit } from "./repo-git.js";
import { APP, type Sandbox } from "./sandbox.js";
import { SuspiciousWatch } from "./suspicious.js";
import { checkoutCommit, normalizeRepository, removeWorkspace, workspaceRoot, type WorkspaceOptions } from "./workspace.js";

/**
 * A developer's pull request, taken live (Phase 26). TBO Support hands out the pull request's
 * unresolved CodeRabbit threads and failed CI checks; the worker clones the pull request at its
 * head commit, lets the model fix or answer each finding inside the app (never CI files), checks
 * the change on a sandbox site, commits it on top of that commit and pushes it, fast-forward only,
 * to the pull request's own branch. Then it tells TBO Support what was fixed and what was not, and
 * TBO Support replies on each thread.
 */

/** The engine profile a pull request's fix session uses (cli.ts registers it). */
export const PR_FIX_PROFILE_NAME = "pr_fix";

const SHA = /^[0-9a-f]{40}$/i;
const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,199}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;

export type PrFixOutcome = "done" | "failed" | "cancelled" | "lease_lost" | "stopped" | "not_reported";

export type PrFixReport = {
  pull_request: string;
  outcome: PrFixOutcome;
  reason?: string;
  /** The branch head Copilot pushed, when it pushed. */
  pushed?: string;
  fixed: number;
  not_fixed: number;
  tests?: PrTests;
  /** Lines in the findings or the files read that tried to instruct the AI (secrets taken out). */
  suspicious: string[];
  toolCalls: number;
  denied: number;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  minutes: number;
};

export type PrFixDeps = {
  cfg: WorkerConfig;
  hub: HubClient;
  engine: Engine;
  router: { prFixSessions: Map<string, PrFixToolState> };
  /** The sandbox runner; without it, or when it cannot start a site, the change is not tested here. */
  sandbox?: Sandbox;
  log: Logger;
  engineModel: (model: ModelConfig) => Promise<{ providerId: string; modelId: string }>;
  stopping: () => boolean;
  workspaceOptions: () => WorkspaceOptions;
};

/** A branch git and GitHub take, and nothing that could read as an option or a range. */
export function usableBranch(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock")
  );
}

/** What the worker needs from the job: the repository as git reaches it, and the findings to show. */
export function checkPrContext(context: PrFixContext, allowLocal = false): { repository: string; shown: PrFinding[]; left: PrFinding[] } | string {
  const repository = normalizeRepository(String(context?.repo ?? ""), allowLocal);
  if (!repository) return "the hub sent a repository the worker cannot use";
  if (!APP.test(String(context.app ?? ""))) return "the hub sent an app name the worker cannot use";
  if (!SHA.test(String(context.head_sha ?? ""))) return "the hub sent a head_sha that is not a full commit id";
  if (!usableBranch(context.head_branch)) return "the hub sent a head_branch the worker cannot push to";
  if (context.base_branch && context.base_branch === context.head_branch) return "the pull request's head and base are the same branch";
  if (!EMAIL.test(String(context.commit_email ?? ""))) return "the hub sent no usable commit email";
  const findings = Array.isArray(context.findings) ? context.findings : [];
  if (!findings.length) return "the hub sent no findings to fix";
  const ids = new Set<string>();
  for (const finding of findings) {
    const id = String(finding?.id ?? "");
    if (!FINDING_ID.test(id)) return `the hub sent a finding id the worker cannot use (${JSON.stringify(id.slice(0, 60))})`;
    if (ids.has(id)) return `the hub sent finding ${id} twice`;
    ids.add(id);
  }
  return { repository, shown: findings.slice(0, MAX_FINDINGS), left: findings.slice(MAX_FINDINGS) };
}

/** The branch's head on the remote now, or undefined when the branch is gone. */
export async function remoteHead(cwd: string, repository: string, branch: string, homeDir: string, token?: string): Promise<string | undefined> {
  const env = token ? pushEnv(homeDir, repository, token) : gitEnv(homeDir);
  const ref = `refs/heads/${branch}`;
  const out = await runGit(cwd, ["ls-remote", "--heads", "--end-of-options", repository, ref], env, 60_000);
  const found = out.split("\n").map((row) => row.split("\t")).find(([, name]) => name?.trim() === ref);
  return found?.[0]?.trim().toLowerCase() || undefined;
}

function moved(branch: string, now: string | undefined, expected: string): string {
  return `the branch moved: ${branch} is ${now ? `at ${now.slice(0, 12)}` : "gone"}, not at ${expected.slice(0, 12)}; nothing was pushed`;
}

function tail(output: string, count = 6, limit = 500): string {
  return output.trim().split("\n").slice(-count).join("\n").slice(-limit);
}

/** The commit's message: which reviewers' findings it fixes, then one line per finding. */
export function commitMessage(context: PrFixContext, done: PrFixDone, findings: PrFinding[]): { title: string; body: string } {
  const sources = new Set(done.fixed.map((item) => findings.find((finding) => finding.id === item.id)?.source));
  const who = sources.has("coderabbit") && sources.has("ci") ? "CodeRabbit and CI" : sources.has("ci") ? "CI" : "CodeRabbit";
  const one = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const body = [
    ...done.fixed.map((item) => `- ${item.id}: ${item.note}`),
    "",
    ...(context.task?.name ? [`Refs ${one(context.task.name)}`] : []),
    `Pull request: ${one(context.url) || `#${Number(context.number) || ""}`}`,
  ];
  return { title: `fix: ${who} round ${Number(context.round) || 1} (TBO Copilot)`, body: body.join("\n") };
}

/**
 * The worker's own checks of the change, from the runner's results, never from the model's words:
 * nothing secret-shaped added, the copy still migrates, the app's tests pass. A failure is only the
 * change's when the same step passes on the pull request's code without it.
 */
async function ownChecks(state: PrFixToolState, base: string, changed: string[]): Promise<{ tests: PrTests; problems: PrCheckProblem[] }> {
  const problems: PrCheckProblem[] = [];
  const diff = await runGit(state.dir, ["diff", "--no-ext-diff", "--no-color", "-U0"], gitEnv(state.homeDir));
  const added = diff.split("\n").filter((row) => row.startsWith("+") && !row.startsWith("+++")).join("\n");
  if (SECRET.test(added)) problems.push({ what: "a secret-shaped value is in your change: take it out (a key or password never goes into code)" });
  const { sandbox, sandboxId } = state;
  if (!sandbox || !sandboxId) return { tests: { ran: false, passed: false, detail: `not run: ${state.noSandbox ?? "no sandbox"}` }, problems };
  const withoutTheChange = async <T>(step: () => Promise<T>): Promise<T> => {
    const restore = await codeAsTheSiteRunsIt(state.dir, base, changed, state.homeDir);
    try {
      return await step();
    } finally {
      await restore();
    }
  };
  const migrate = await sandbox.migrate(sandboxId);
  if (!migrate.ok) {
    if ((await withoutTheChange(() => sandbox.migrate(sandboxId))).ok) {
      problems.push({ what: "bench migrate fails with your change and passes without it", output: tail(migrate.output, 40, 4_000) });
      return { tests: { ran: false, passed: false, detail: `not run: bench migrate fails with the change: ${tail(migrate.output, 3)}` }, problems };
    }
    return { tests: { ran: false, passed: false, detail: `not run: bench migrate fails on the pull request's code, with or without Copilot's change: ${tail(migrate.output, 3)}` }, problems };
  }
  const tests = await sandbox.tests(sandboxId, state.app);
  if (tests.skipped) return { tests: { ran: false, passed: false, detail: "not run: the app has no tests" }, problems };
  if (tests.ok) return { tests: { ran: true, passed: true, detail: tail(tests.output, 3) }, problems };
  const before = await withoutTheChange(() => sandbox.tests(sandboxId, state.app));
  if (!before.ok && !before.skipped) {
    return { tests: { ran: true, passed: false, detail: `the app's tests fail with and without Copilot's change: ${tail(tests.output)}` }, problems };
  }
  problems.push({ what: "the app's tests fail with your change and pass without it", output: tail(tests.output, 40, 4_000) });
  return { tests: { ran: true, passed: false, detail: `the app's tests fail with Copilot's change: ${tail(tests.output)}` }, problems };
}

export async function runPrFixJob(job: PrFixJob, deps: PrFixDeps): Promise<PrFixReport> {
  const { cfg, hub, engine, router, log } = deps;
  const context = job.context;
  const pr = job.pull_request;
  const token = job.lease_token;
  const limits = cfg.fixLimits ?? DEFAULT_FIX_LIMITS;
  // Copilot's own fix's models and fallback, and the job's dollar cap
  const models = new StageModels("fix", stageModels(cfg, "fix", context));
  const budget = new RunBudget(
    { maxToolCalls: limits.maxToolCalls, maxMinutes: limits.maxMinutes, maxTokens: limits.maxTokens, maxUsd: smallestCap(context?.dollar_cap) },
    Date.now,
    models.current,
  );
  const flags = { cancelled: false, leaseLost: false, stopped: false, finished: false, budgetReason: "", denied: 0, pushed: "" };
  const counts = { fixed: 0, notFixed: 0 };
  const sessions: string[] = [];
  const suspicious: string[] = [];
  const root = workspaceRoot(cfg.runsDir, `pr-${pr}`);
  let tests: PrTests | undefined;
  let sandboxId: string | undefined;
  const report = (outcome: PrFixOutcome, reason?: string): PrFixReport => ({
    pull_request: pr,
    outcome,
    ...(reason ? { reason } : {}),
    ...(flags.pushed ? { pushed: flags.pushed } : {}),
    fixed: counts.fixed,
    not_fixed: counts.notFixed,
    ...(tests ? { tests } : {}),
    suspicious,
    toolCalls: budget.spend.toolCalls,
    denied: flags.denied,
    tokensIn: budget.spend.tokensIn,
    tokensCached: budget.spend.tokensCached,
    tokensOut: budget.spend.tokensOut,
    costUsd: Number(budget.cost().usd ?? 0),
    model: String(budget.cost().model ?? ""),
    minutes: Math.round(budget.minutes() * 10) / 10,
  });
  const fail = async (reason: string): Promise<PrFixReport> => {
    flags.finished = true;
    try {
      await hub.prResult(pr, token, { kind: "failure", reason });
    } catch (error) {
      log("warn", "pull request fix failure not reported", { pull_request: pr, error: String(error) });
    }
    return report("failed", reason);
  };
  const ended = (): PrFixReport => {
    if (flags.cancelled) return report("cancelled", "TBO Support cancelled the fix (a new commit on the pull request, or it closed)");
    if (flags.leaseLost) return report("lease_lost", "the lease ended before the result");
    return report("stopped", "the worker was stopped; the lease will expire and the pull request goes back to the queue");
  };
  const stopIfAsked = () => {
    if (!deps.stopping() || flags.stopped) return;
    flags.stopped = true;
    for (const id of sessions) engine.abort(id).catch(() => undefined);
  };
  const heartbeat = setInterval(() => {
    void (async () => {
      if (flags.finished) return;
      try {
        if ((await hub.prHeartbeat(pr, token)).action === "cancel") flags.cancelled = true;
      } catch (error) {
        if (error instanceof HubError && error.leaseGone) flags.leaseLost = true;
        else log("warn", "pull request heartbeat failed", { pull_request: pr, error: String(error) });
      }
      if (flags.cancelled || flags.leaseLost) for (const id of sessions) await engine.abort(id);
      else stopIfAsked();
    })();
  }, cfg.limits.heartbeatIntervalMs);
  const mayGoOn = () => !flags.cancelled && !flags.leaseLost && !deps.stopping();
  const watch = new SuspiciousWatch();
  // text that tries to instruct the AI: recorded for the team, whatever the model makes of it
  const flagSuspicious = (where: string, text: string) => {
    for (const line of watch.check(text)) {
      suspicious.push(line);
      log("warn", "suspicious instruction", { pull_request: pr, where, text: line });
    }
  };
  const observer: TurnObserver & { check: () => void } = {
    check: () => {
      stopIfAsked();
      const reason = budget.exceeded();
      if (reason && !flags.budgetReason) {
        flags.budgetReason = reason;
        for (const id of sessions) void engine.abort(id);
      }
    },
    onToolStart: () => {
      budget.toolCall();
      observer.check();
    },
    onToolEnd: ({ toolName, result, text }) => flagSuspicious(toolName, text ?? result),
    onPermissionDenied: (request) => {
      flags.denied += 1;
      log("info", "pull request fix: permission denied", { pull_request: pr, tool: request.toolName });
    },
    onUsage: (usage) => {
      budget.usage(usage);
      observer.check();
    },
  };
  const watchdog = setInterval(() => observer.check(), 15_000);
  log("info", "pull request fix claimed", { pull_request: pr, repo: context?.repo, number: context?.number, round: context?.round });

  try {
    const plan = checkPrContext(context, cfg.allowLocalRepos);
    if (typeof plan === "string") return await fail(plan);
    if (!models.current) return await fail(noModelReason("fix"));
    if (!engine.hasProfile(PR_FIX_PROFILE_NAME)) return await fail("this worker's engine has no pr_fix profile");
    const { repository, shown, left } = plan;
    const branch = context.head_branch;
    const base = context.head_sha.toLowerCase();
    flagSuspicious("findings", JSON.stringify(context.findings));

    // the branch as the remote has it now: Copilot builds only on the commit TBO Support named
    const options = deps.workspaceOptions();
    await removeWorkspace(root);
    await mkdir(join(root, "apps"), { recursive: true, mode: 0o700 });
    await mkdir(options.homeDir, { recursive: true, mode: 0o700 });
    const head = await remoteHead(root, repository, branch, cfg.homeDir, context.repo_token || options.githubToken);
    if (head !== base) return await fail(moved(branch, head, base));
    const dir = join(root, "apps", context.app);
    await checkoutCommit(repository, base, dir, context.repo_token ? { ...options, githubToken: context.repo_token } : options);
    const env = gitEnv(cfg.homeDir);
    const checkedOut = (await runGit(dir, ["rev-parse", "HEAD"], env)).trim().toLowerCase();
    if (checkedOut !== base) return await fail(moved(branch, checkedOut, base));
    await runGit(dir, ["config", "user.name", "TBO Copilot"], env);
    await runGit(dir, ["config", "user.email", context.commit_email], env);
    await runGit(dir, ["config", "commit.gpgsign", "false"], env);
    await writeFile(
      join(root, "INDEX.md"),
      `# Pull request #${Number(context.number) || ""}\n\n- \`apps/${context.app}/\`: the pull request's code, branch ${branch} at ${base.slice(0, 12)}. The one folder you may edit (never its .git or CI files).\n\nThe findings are in your first message.\n`,
    );
    await chmod(join(root, "INDEX.md"), 0o444);
    await chmod(join(root, "apps"), 0o555);

    // a site with the customer's apps, this app at the working tree, when the runner can start one
    let testedOn: string | undefined;
    let noSandbox: string | undefined = deps.sandbox ? undefined : "this worker has no sandbox runner";
    if (deps.sandbox) {
      try {
        const started = await deps.sandbox.start({
          run: pr,
          customer: null,
          site: null,
          apps: (context.apps ?? []).map((app) => ({ app: app.app, repository: app.repository ?? null, branch: app.branch ?? null, commit: app.commit ?? null })),
          mount: { app: context.app, dir },
        });
        sandboxId = started.id;
        testedOn = started.tested_on || "a sandbox site";
      } catch (error) {
        noSandbox = `the sandbox could not start: ${String((error as Error).message ?? error).slice(0, 200)}`;
        log("warn", "pull request fix without a sandbox", { pull_request: pr, error: String(error) });
      }
    }
    const state: PrFixToolState = {
      app: context.app,
      dir,
      homeDir: cfg.homeDir,
      ...(sandboxId && deps.sandbox ? { sandbox: deps.sandbox, sandboxId } : { noSandbox }),
      checks: [],
      findingIds: shown.map((finding) => finding.id),
    };
    tests = { ran: false, passed: false, detail: `not run: ${noSandbox ?? "nothing was changed"}` };
    const openOn = async (model: StageModel): Promise<string> => {
      budget.use(model);
      const id = await engine.openSession(root, `Copilot pull request ${pr}`, await deps.engineModel(model), {
        profile: PR_FIX_PROFILE_NAME,
        decide: pullRequestEdits(root, dir),
      });
      sessions.push(id);
      router.prFixSessions.set(id, state);
      return id;
    };
    // the turn and, when it ended without pr_fix_done, one reminder; none once a limit was passed
    // (the sandbox's own checks may pass the time limit while no turn runs to be stopped)
    const turns = async (session: string, prompt: string): Promise<TurnResult> => {
      let turn: TurnResult = mayGoOn() && !flags.budgetReason ? await engine.runTurn(session, prompt, observer) : { reason: "aborted", text: "" };
      if (!state.done && mayGoOn() && !flags.budgetReason && turn.reason === "completed") turn = await engine.runTurn(session, PR_FIX_NUDGE, observer);
      return turn;
    };
    const first = prFixPrompt(context, shown, { left: left.length, ...(testedOn ? { testedOn } : { noSandbox: noSandbox ?? "" }) });
    let session = await openOn(models.current);
    let changed: string[] = [];
    let problems: PrCheckProblem[] = [];
    // pr_fix_done fills state.done from a tool call, out of TypeScript's sight
    const answer = () => state.done as PrFixDone | undefined;
    for (let round = 1; ; round += 1) {
      state.done = undefined;
      const prompt = round === 1 ? first : prFixAgainPrompt(problems);
      let turn = await turns(session, prompt);
      // the provider failed: the fix starts again once, in a fresh session on the fallback model
      const fallback = !answer() && mayGoOn() && !flags.budgetReason ? models.next(turn) : undefined;
      if (fallback) {
        log("warn", "pull request fix moves to the fallback model", { pull_request: pr, model: fallback.modelId, error: turn.errorCode });
        session = await openOn(fallback);
        turn = await turns(session, restartPrompt(first, round > 1 ? prompt : undefined));
      }
      if (!mayGoOn()) return ended();
      if (flags.budgetReason) return await fail(`${flags.budgetReason} before the fix was ready`);
      if (!answer()) {
        return await fail(turn.reason === "error" ? `the model failed (${turn.errorCode ?? "unknown error"})` : "the model ended without answering the findings (pr_fix_done)");
      }
      changed = await changedPaths(dir, cfg.homeDir);
      // the session's rule refuses these; this is the worker's own look before anything is committed
      const ci = changed.filter(isCiPath);
      if (ci.length) return await fail(`the change touches CI or git files, which a fix never changes (${ci.slice(0, 5).join(", ")}); nothing was pushed`);
      if (!changed.length) {
        tests = { ran: false, passed: false, detail: "not run: nothing was changed" };
        break;
      }
      const checked = await ownChecks(state, base, changed);
      tests = checked.tests;
      if (!checked.problems.length) break;
      if (round >= limits.maxRounds) {
        return await fail(`still not right after ${round} rounds: ${checked.problems.map((problem) => problem.what).join("; ")}; nothing was pushed`);
      }
      problems = checked.problems;
    }
    if (!mayGoOn()) return ended();

    const done = answer()!;
    let pushedHead = base;
    let commit = "";
    if (changed.length) {
      const message = commitMessage(context, done, shown);
      await runGit(dir, ["add", "--all"], env);
      await runGit(dir, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", message.title, "-m", message.body], env);
      commit = (await runGit(dir, ["rev-parse", "HEAD"], env)).trim().toLowerCase();
      if ((await runGit(dir, ["rev-parse", "HEAD^"], env)).trim().toLowerCase() !== base) return await fail("the commit is not on top of the pull request's head; nothing was pushed");
      // TBO Support's last word before anything leaves this machine: the developer may have pushed meanwhile
      if ((await hub.prHeartbeat(pr, token)).action === "cancel") {
        flags.cancelled = true;
        return ended();
      }
      const key = await hub.prPushKey(pr, token);
      if (!key?.token) return await fail("TBO Support gave no push key; nothing was pushed");
      if (String(key.branch ?? "") !== branch) return await fail(`the push key is for branch ${String(key.branch ?? "").slice(0, 200)}, not ${branch}; nothing was pushed`);
      if (repoName(String(key.repository ?? ""), cfg.allowLocalRepos) !== repoName(repository, cfg.allowLocalRepos)) {
        return await fail(`the push key is for ${String(key.repository ?? "").slice(0, 200)}, not this pull request's repository; nothing was pushed`);
      }
      const now = await remoteHead(root, repository, branch, cfg.homeDir, key.token);
      if (now !== base) return await fail(moved(branch, now, base));
      try {
        // a plain refspec, never `+` or --force: the remote takes it only as a fast-forward of the branch
        await runGit(dir, ["-c", "core.hooksPath=/dev/null", "push", "--quiet", "--end-of-options", repository, `HEAD:refs/heads/${branch}`], pushEnv(cfg.homeDir, repository, key.token), 300_000);
      } catch (error) {
        const text = String((error as Error).message ?? error);
        if (!/rejected|non-fast-forward|fetch first|cannot lock ref/i.test(text)) return await fail(`the push failed: ${text.slice(0, 300)}`);
        // the remote refused a non-fast-forward: someone pushed between the check and the push
        const after = await remoteHead(root, repository, branch, cfg.homeDir, key.token).catch(() => undefined);
        return await fail(moved(branch, after, base));
      }
      pushedHead = commit;
      flags.pushed = commit;
      log("info", "pull request fix pushed", { pull_request: pr, branch, commit });
    }
    const result: PrFixResult = {
      kind: "done",
      head_sha: pushedHead,
      fixed: done.fixed.map((item) => ({ id: item.id, commit, note: item.note })),
      not_fixed: [...done.not_fixed, ...left.map((finding) => ({ id: finding.id, why: `Not read: more than ${MAX_FINDINGS} findings came in one round.` }))],
      tests: tests ?? { ran: false, passed: false, detail: "not run" },
      cost: budget.cost(),
    };
    counts.fixed = result.fixed.length;
    counts.notFixed = result.not_fixed.length;
    flags.finished = true;
    await hub.prResult(pr, token, result);
    return report("done");
  } catch (error) {
    flags.finished = true;
    if (error instanceof HubError && error.leaseGone) return report("lease_lost", error.message);
    if (deps.stopping()) return report("stopped", "the worker was stopped");
    if (flags.pushed) {
      // the change is on the branch: a failure now would tell TBO Support the opposite
      log("error", "pull request fix pushed but not reported", { pull_request: pr, commit: flags.pushed, error: String(error) });
      return report("not_reported", `pushed ${flags.pushed}, but TBO Support did not take the result: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
    }
    log("error", "pull request fix failed", { pull_request: pr, error: String(error) });
    return await fail(`the worker failed: ${String((error as Error)?.message ?? error).slice(0, 500)}`);
  } finally {
    clearInterval(heartbeat);
    clearInterval(watchdog);
    if (sandboxId && deps.sandbox) await deps.sandbox.stop(sandboxId).catch(() => undefined);
    for (const id of sessions) {
      router.prFixSessions.delete(id);
      await engine.closeSession(id, root).catch(() => undefined);
    }
    if (!cfg.keepRuns) await removeWorkspace(root).catch(() => undefined);
  }
}
