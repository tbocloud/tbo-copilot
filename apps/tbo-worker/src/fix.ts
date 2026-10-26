import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { FixLimits, ModelConfig, WorkerConfig } from "./config.js";
import { preview, type Engine, type TurnObserver, type TurnResult } from "./engine.js";
import { EventOutbox } from "./events.js";
import { againPrompt, FIX_NUDGE, fixPrompt, restartPrompt, REVIEW_NUDGE, reviewPrompt } from "./fix-prompt.js";
import type { Finding, FixDone, FixToolState } from "./fix-tools.js";
import { GitHubRest } from "./github.js";
import { HubError, type HubClient, type Job, type RunContext, type SiteApp } from "./hub.js";
import type { Logger } from "./log.js";
import { StageModels, noModelReason, stageModels, type StageModel } from "./models.js";
import { RunBudget, editsInside } from "./policy.js";
import { SuspiciousWatch } from "./suspicious.js";
import { gitEnv, runGit } from "./repo-git.js";
import type { Sandbox, SandboxResult } from "./sandbox.js";
import type { RunOutcome, RunReport } from "./supervisor.js";
import { SKIPPED_APPS, normalizeRepository, prepareWorkspace, removeWorkspace, workspaceRoot, type AppCheckout, type Workspace, type WorkspaceOptions } from "./workspace.js";

export const DEFAULT_FIX_LIMITS: FixLimits = { maxToolCalls: 120, maxMinutes: 60, maxTokens: 8_000_000, maxRounds: 3 };
/** Test files, as helpdesk.copilot.risk sees them. */
export const TEST_PATH = /(^|\/)tests?\/|(^|\/)test_[^/]+\.py$|\.test\.[jt]s$|_test\.py$/;
/** Shapes of secrets that must never be pushed. */
export const SECRET =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(password|passwd|secret|api_key|apikey|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i;

export type EvidenceRow = { check: string; result: "pass" | "fail" | "not_run"; detail: string };

/** The router's view of the sessions a fix job opens. */
export type FixSessions = { fixSessions: Map<string, FixToolState> };

export type FixDeps = {
  cfg: WorkerConfig;
  hub: HubClient;
  engine: Engine;
  router: FixSessions;
  sandbox: Sandbox;
  log: Logger;
  /** The engine's provider and model for a stage's model. */
  engineModel: (model: ModelConfig) => Promise<{ providerId: string; modelId: string }>;
  stopping: () => boolean;
  workspaceOptions: () => WorkspaceOptions;
  github?: GitHubRest;
};

/** `owner/name` of a GitHub repository; a local folder (tests only) is `local/<folder>`. */
export function repoName(repository: string, allowLocal = false): string | undefined {
  const url = normalizeRepository(repository, allowLocal);
  if (!url) return undefined;
  if (!url.startsWith("https://")) return `local/${basename(url.replace(/^file:\/\//, "")).replace(/\.git$/, "")}`.toLowerCase();
  const [, , , owner, name] = url.split("/");
  return `${owner}/${name!.replace(/\.git$/, "")}`.toLowerCase();
}

function namedFiles(context: RunContext): string[] {
  const diagnosis = context.diagnosis ?? {};
  const files = Array.isArray(diagnosis.proposal?.files) ? (diagnosis.proposal!.files as unknown[]) : [];
  const refs = Array.isArray(diagnosis.evidence) ? (diagnosis.evidence as Array<{ ref?: unknown }>).map((item) => item?.ref) : [];
  return [...files, ...refs].filter((value): value is string => typeof value === "string");
}

/** The app to fix: one of the site's apps Copilot may push to, the one the diagnosis names when there are several. */
export function chooseApp(context: RunContext, allowLocal = false): { app: SiteApp; repo: string } | string {
  const allowed = new Set((context.fix?.repositories ?? []).map((repo) => repo.toLowerCase()));
  const candidates = (context.site?.apps ?? [])
    .filter((app) => app.app && app.repository && !SKIPPED_APPS.has(app.app))
    .map((app) => ({ app, repo: repoName(app.repository!, allowLocal) ?? "" }))
    .filter((candidate) => candidate.repo && allowed.has(candidate.repo));
  if (!candidates.length) return "none of the site's apps is a repository Copilot may push to";
  if (candidates.length === 1) return candidates[0]!;
  const files = namedFiles(context);
  const named = candidates.filter(({ app }) => files.some((path) => path.startsWith(`${app.app}/`) || path.startsWith(`apps/${app.app}/`)));
  return named.length === 1 ? named[0]! : "the diagnosis does not say which of the site's apps to fix";
}

function firstLines(text: string, count = 3): string {
  return text.trim().split("\n").filter(Boolean).slice(-count).join(" ").slice(0, 300);
}

function row(check: string, run: SandboxResult, expectOk = true): EvidenceRow {
  const ok = expectOk ? run.ok : !run.ok;
  return { check, result: run.skipped ? "not_run" : ok ? "pass" : "fail", detail: firstLines(run.output) };
}

/** Puts the code as the site runs it back for the changed source files (tests stay), and returns how to undo that. */
async function codeAsTheSiteRunsIt(dir: string, base: string, sources: string[], homeDir: string): Promise<() => Promise<void>> {
  const env = gitEnv(homeDir);
  const saved = new Map<string, string | null>();
  for (const path of sources) {
    const file = join(dir, path);
    saved.set(path, existsSync(file) ? await readFile(file, "utf8") : null);
    let original: string | undefined;
    try {
      original = await runGit(dir, ["show", `${base}:${path}`], env);
    } catch {
      original = undefined; // a new file: the site has none
    }
    if (original === undefined) await rm(file, { force: true });
    else await writeFile(file, original);
  }
  return async () => {
    for (const [path, content] of saved) {
      const file = join(dir, path);
      if (content === null) await rm(file, { force: true });
      else {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
      }
    }
  };
}

/**
 * The worker's own checks, from the sandbox's results, never from the AI's
 * words: the test fails on the code the site runs and passes on the fix; the
 * copy still migrates; the app's tests pass; no new error appeared; nothing
 * secret-shaped is in the change.
 */
export async function verify(
  state: FixToolState,
  base: string,
  since: string,
): Promise<{ evidence: EvidenceRow[]; failures: string[]; fatal?: string }> {
  const env = gitEnv(state.homeDir);
  await runGit(state.dir, ["add", "--intent-to-add", "--all"], env);
  const changed = (await runGit(state.dir, ["diff", "--no-ext-diff", "--name-only"], env)).split("\n").map((line) => line.trim()).filter(Boolean);
  const sources = changed.filter((path) => !TEST_PATH.test(path));
  if (!sources.length) return { evidence: [], failures: [], fatal: "the change touches no code, only tests" };
  const module = state.done!.test_module;
  const restore = await codeAsTheSiteRunsIt(state.dir, base, sources, state.homeDir);
  let before: SandboxResult;
  try {
    before = await state.sandbox.check(state.sandboxId, state.app, module);
  } finally {
    await restore();
  }
  if (before.ok) {
    // another round may still show it: a test that mocked away the code the diagnosis names passes too
    return {
      evidence: [row("the bug shows before the fix", before, false)],
      failures: [
        `the bug does not show before the fix: ${module} passes on the code the site runs. Make it call the real code the diagnosis names and fail there; a mock, stub or patch of that code hides the bug`,
      ],
    };
  }
  if (before.failure !== "assertion") {
    // an import error or a crash proves nothing about the bug (a test calling a function only
    // the fix adds errors too); the runner's test report says which, never the output's words
    const how = before.failure === "error" ? "errored" : "failed without a test report saying how";
    return {
      evidence: [{ check: `the bug shows before the fix (${module})`, result: "fail", detail: `${how}: ${firstLines(before.output)}` }],
      failures: [
        `${module} ${how} on the code the site runs instead of failing an assertion: it must run on that code and fail on the wrong result, so it shows the bug. When the bug is itself an exception in the app's code, keep calling that code and turn the exception into a failed assertion (try/except, then self.fail with the exception); do not mock it away`,
      ],
    };
  }
  const after = await state.sandbox.check(state.sandboxId, state.app, module);
  const migrate = await state.sandbox.migrate(state.sandboxId);
  const tests = await state.sandbox.tests(state.sandboxId, state.app);
  const errors = await state.sandbox.errorsSince(state.sandboxId, since);
  const secret = SECRET.test(await runGit(state.dir, ["diff", "--no-ext-diff"], env));
  const evidence: EvidenceRow[] = [
    row(`the bug shows before the fix (${module})`, before, false),
    row(`the check passes after the fix (${module})`, after),
    row("bench migrate", migrate),
    row("the app's own tests", tests),
    { check: "no new errors on the copy", result: errors.length ? "fail" : "pass", detail: errors.slice(0, 3).join("; ").slice(0, 300) },
    { check: "no secrets in the change", result: secret ? "fail" : "pass", detail: secret ? "a secret-shaped value is in the diff" : "" },
  ];
  const failures = evidence.filter((item) => item.result === "fail").map((item) => `${item.check}${item.detail ? `: ${item.detail}` : ""}`);
  return { evidence, failures };
}

const MARK: Record<EvidenceRow["result"], string> = { pass: "✅", fail: "❌", not_run: "–" };

export function pullBody(input: {
  context: RunContext;
  done: FixDone;
  evidence: EvidenceRow[];
  findings: Finding[];
  testedOn: string;
}): string {
  const { context, done, evidence, findings, testedOn } = input;
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    "## Summary",
    "",
    done.summary,
    "",
    "## Root cause",
    "",
    String(context.diagnosis?.summary ?? "").slice(0, 2000) || "See the ticket.",
    "",
    "## The change",
    "",
    done.explanation,
    "",
    `## Tested by Copilot on ${testedOn}`,
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...evidence.map((item) => `| ${cell(item.check)} | ${MARK[item.result]} | ${cell(item.detail)} |`),
    "",
  ];
  if (findings.length) {
    lines.push("## Review", "", ...findings.map((finding) => `- ${finding.severity === "must_fix" ? "**Must fix:** " : ""}${finding.file ? `\`${finding.file}\`: ` : ""}${finding.note}`), "");
  }
  if (done.people_checks.length) lines.push("## Worth checking by a person", "", ...done.people_checks.map((item) => `- ${item}`), "");
  if (done.risk_notes) lines.push("## Risk", "", done.risk_notes, "");
  lines.push(
    "This pull request is held with `no-auto-merge`: TBO Support merges it after one person approves it on the ticket.",
    "",
    context.fix!.closes,
    `Ticket: ${context.ticket.name}`,
    `Copilot-Run: ${context.run}`,
  );
  return lines.join("\n");
}

function pushEnv(homeDir: string, repository: string, token: string): NodeJS.ProcessEnv {
  if (!repository.startsWith("https://github.com/")) return gitEnv(homeDir);
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return gitEnv(homeDir, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  });
}

async function commitAndPush(target: AppCheckout, branch: string, done: FixDone, task: string, token: string, homeDir: string): Promise<string> {
  const env = gitEnv(homeDir);
  await runGit(target.dir, ["add", "--all"], env);
  await runGit(target.dir, ["commit", "--quiet", "-m", `fix: ${done.summary}`, "-m", `${done.explanation}\n\nRefs ${task}`], env);
  const head = (await runGit(target.dir, ["rev-parse", "HEAD"], env)).trim();
  await runGit(target.dir, ["push", "--quiet", "--end-of-options", target.repository, `HEAD:refs/heads/${branch}`], pushEnv(homeDir, target.repository, token), 300_000);
  return head;
}

/**
 * One fix job: the push key, a writable clone on Copilot's branch, a sandbox
 * copy of the customer's site, the AI's rounds of change and check, the
 * worker's own checks, one review by a fresh session, then the commit, the
 * push, the pull request and the report to TBO Support. Any failure is
 * reported, and the hub hands the fix to the developer.
 */
export async function runFixJob(job: Job, deps: FixDeps): Promise<RunReport> {
  const { cfg, hub, engine, router, sandbox, log } = deps;
  const context = job.context;
  const run = job.run;
  const limits = cfg.fixLimits ?? DEFAULT_FIX_LIMITS;
  // each stage on its own model from TBO Support's list, moving once to the fallback after a provider failure
  const fixModels = new StageModels("fix", stageModels(cfg, "fix", context));
  const reviewModels = new StageModels("review", stageModels(cfg, "review", context));
  const budget = new RunBudget(
    { maxToolCalls: limits.maxToolCalls, maxMinutes: limits.maxMinutes, maxTokens: limits.maxTokens, maxUsd: Number(context.fix?.max_usd ?? 0) },
    Date.now,
    fixModels.current,
  );
  const outbox = new EventOutbox((events) => hub.postEvents(run, job.lease_token, events), { log });
  const flags = { cancelled: false, leaseLost: false, budgetReason: "", denied: 0, stopped: false };
  const sessions: string[] = [];
  let workspace: Workspace | undefined;
  let sandboxId: string | undefined;
  const report = (outcome: RunOutcome, reason?: string, submission?: string): RunReport => ({
    run,
    ticket: context.ticket.name,
    outcome,
    ...(reason ? { reason } : {}),
    ...(submission ? { submission } : {}),
    toolCalls: budget.spend.toolCalls,
    denied: flags.denied,
    tokensIn: budget.spend.tokensIn,
    tokensCached: budget.spend.tokensCached,
    tokensOut: budget.spend.tokensOut,
    costUsd: Number(budget.cost().usd ?? 0),
    model: String(budget.cost().model ?? ""),
    minutes: Math.round(budget.minutes() * 10) / 10,
    problems: workspace?.problems ?? [],
  });
  const fail = async (reason: string): Promise<RunReport> => {
    await outbox.flush().catch(() => undefined);
    try {
      await hub.submitFailure(run, job.lease_token, reason);
    } catch (error) {
      log("warn", "fix failure not reported", { run, error: String(error) });
    }
    return report("failed", reason);
  };
  // the worker is shutting down (SIGINT, SIGTERM): end the running turn now, not at its time limit
  const stopIfAsked = () => {
    if (!deps.stopping() || flags.stopped) return;
    flags.stopped = true;
    for (const id of sessions) engine.abort(id).catch(() => undefined);
  };
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const answer = await hub.heartbeat(run, job.lease_token, "fix");
        if (answer.action === "cancel") flags.cancelled = true;
      } catch (error) {
        if (error instanceof HubError && error.leaseGone) flags.leaseLost = true;
      }
      if (flags.cancelled || flags.leaseLost) for (const id of sessions) await engine.abort(id);
      else stopIfAsked();
    })();
  }, cfg.limits.heartbeatIntervalMs);
  const mayGoOn = () => !flags.cancelled && !flags.leaseLost && !deps.stopping();
  const watch = new SuspiciousWatch();
  const observer: TurnObserver & { check: () => void } = {
    check: () => {
      stopIfAsked();
      const reason = budget.exceeded();
      if (reason && !flags.budgetReason) {
        flags.budgetReason = reason;
        outbox.push("budget", { reason });
        for (const id of sessions) void engine.abort(id);
      }
    },
    onToolStart: ({ toolName, args }) => {
      budget.toolCall();
      outbox.push("tool_call", { tool: toolName, args: preview(args, 500) });
      observer.check();
    },
    onToolEnd: ({ toolName, isError, ms, result, text }) => {
      outbox.push("tool_result", { tool: toolName, is_error: isError, ms, ...(isError ? { error: result.slice(0, 500) } : {}) });
      for (const line of watch.check(text ?? result)) outbox.push("suspicious_instruction", { tool: toolName, text: line });
    },
    onPermissionDenied: (request) => {
      flags.denied += 1;
      outbox.push("permission_denied", { tool: request.toolName, args: preview(request.argsPreview, 300) });
    },
    onPermissionAllowed: (request) => outbox.push("permission_allowed", { tool: request.toolName, args: preview(request.argsPreview, 200) }),
    onUsage: (usage) => {
      budget.usage(usage);
      outbox.push("usage", {
        tokens_in: usage.inputTokens ?? 0,
        cached: usage.cacheReadTokens ?? 0,
        ...(usage.cacheWriteTokens ? { cache_write: usage.cacheWriteTokens } : {}),
        tokens_out: usage.outputTokens ?? 0,
      });
      observer.check();
    },
    onAssistantText: (text) => outbox.push("assistant", { text: text.slice(0, 1_000) }),
  };
  const watchdog = setInterval(() => observer.check(), 15_000);
  log("info", "fix job claimed", { run, ticket: context.ticket.name });

  try {
    const fix = context.fix;
    if (!fix) return await fail("the run has no fix context");
    if (!fixModels.current) return await fail(noModelReason("fix"));
    if (!reviewModels.current) return await fail(noModelReason("review"));
    const chosen = chooseApp(context, cfg.allowLocalRepos);
    if (typeof chosen === "string") return await fail(chosen);
    const key = await hub.repoToken(run, job.lease_token, chosen.repo);
    workspace = await prepareWorkspace(job, {
      ...deps.workspaceOptions(),
      writable: { app: chosen.app.app, branch: fix.branch, email: fix.commit_email, token: key.token },
      fetchFile: (fileUrl) => hub.ticketFile(run, job.lease_token, fileUrl),
    });
    const target = workspace.writable;
    if (!target) return await fail(`${chosen.repo} could not be cloned: ${workspace.problems.join("; ") || "no reason given"}`);
    outbox.push("workspace", { app: target.app, repository: chosen.repo, commit: target.commit, branch: fix.branch, problems: workspace.problems });

    const started = await sandbox.start({
      run,
      customer: context.ticket.customer ?? null,
      site: context.site?.site_url ?? null,
      apps: (context.site?.apps ?? []).map((app) => ({ app: app.app, repository: app.repository ?? null, branch: app.branch ?? null, commit: app.deployed_commit ?? null })),
      mount: { app: target.app, dir: target.dir },
    });
    sandboxId = started.id;
    const testedOn = started.tested_on || "a sandbox site";
    const since = new Date().toISOString();
    outbox.push("sandbox", { id: started.id, tested_on: testedOn, ...(started.note ? { note: started.note } : {}) });

    const state: FixToolState = {
      app: target.app,
      dir: target.dir,
      homeDir: cfg.homeDir,
      apps: Object.fromEntries(workspace.apps.map((app) => [app.app, app.dir])),
      sandbox,
      sandboxId: started.id,
      checks: [],
    };
    const root = workspace.root;
    const openFix = async (plan: StageModel): Promise<string> => {
      const id = await engine.openSession(root, `Copilot fix ${run}`, await deps.engineModel(plan), { profile: "fix", decide: editsInside(root, target.dir) });
      sessions.push(id);
      router.fixSessions.set(id, state);
      return id;
    };
    // the fix's turn and, when it ended without fix_done, one reminder
    const fixTurns = async (session: string, prompt: string): Promise<TurnResult> => {
      budget.use(fixModels.current!);
      let turn: TurnResult = mayGoOn() ? await engine.runTurn(session, prompt, observer) : { reason: "aborted", text: "" };
      if (!state.done && mayGoOn() && !flags.budgetReason && turn.reason === "completed") turn = await engine.runTurn(session, FIX_NUDGE, observer);
      return turn;
    };
    // a review in a fresh session: its turn and, without a verdict, one reminder
    const reviewTurns = async (): Promise<TurnResult> => {
      const plan = reviewModels.current!;
      budget.use(plan);
      const session = await engine.openSession(root, `Copilot review ${run}`, await deps.engineModel(plan), { profile: "review" });
      sessions.push(session);
      router.fixSessions.set(session, state);
      let review = await engine.runTurn(session, reviewPrompt(target.app, String(context.diagnosis?.summary ?? "")), observer);
      if (!state.findings && mayGoOn() && !flags.budgetReason && review.reason === "completed") review = await engine.runTurn(session, REVIEW_NUDGE, observer);
      return review;
    };
    const movedOn = (stage: StageModels, to: StageModel, turn: TurnResult) => {
      outbox.push("fallback", { job: stage.job, model: to.modelId, section: to.section, after: turn.errorCode });
      log("warn", `${stage.job} moves to the fallback model`, { run, model: to.modelId, error: turn.errorCode });
    };
    let fixSession = await openFix(fixModels.current);

    let evidence: EvidenceRow[] = [];
    let findings: Finding[] = [];
    let failures: string[] = [];
    for (let round = 1; round <= limits.maxRounds; round += 1) {
      state.done = undefined;
      const prompt = round === 1 ? fixPrompt(context, target.app, fix.branch, testedOn) : againPrompt(findings.filter((item) => item.severity === "must_fix"), failures);
      let turn = await fixTurns(fixSession, prompt);
      // the provider failed: the fix starts again once, in a fresh session on the fallback model
      const fixFallback = !state.done && mayGoOn() && !flags.budgetReason ? fixModels.next(turn) : undefined;
      if (fixFallback) {
        movedOn(fixModels, fixFallback, turn);
        fixSession = await openFix(fixFallback);
        turn = await fixTurns(fixSession, restartPrompt(fixPrompt(context, target.app, fix.branch, testedOn), round > 1 ? prompt : undefined));
      }
      if (!mayGoOn()) break;
      if (flags.budgetReason) return await fail(`${flags.budgetReason} before the fix was ready`);
      if (!state.done) {
        return await fail(turn.reason === "error" ? `the model failed (${turn.errorCode ?? "unknown error"})` : "the model ended without saying the fix is ready");
      }
      // Copilot could not show the bug, or could not fix it: no check round is spent, and the
      // developer gets its explanation
      // (the hub prefixes "Copilot could not fix it:")
      // fix_done fills state.done from a tool call, out of TypeScript's sight
      const said = state.done as FixDone | undefined;
      // whole: fix_done keeps it within CANNOT_FIX_CHARS, so with these words it fits TBO Support's 1,000
      if (said?.cannot_fix) return await fail(`it stopped by itself and explains: ${said.explanation}`);
      const checked = await verify(state, target.commit, since);
      evidence = checked.evidence;
      failures = checked.failures;
      outbox.push("verified", { round, evidence: evidence.map((item) => [item.check, item.result]) });
      if (checked.fatal) return await fail(checked.fatal);
      findings = [];
      if (!failures.length) {
        state.findings = undefined;
        let review = await reviewTurns();
        const reviewFallback = !state.findings && mayGoOn() && !flags.budgetReason ? reviewModels.next(review) : undefined;
        if (reviewFallback) {
          movedOn(reviewModels, reviewFallback, review);
          review = await reviewTurns();
        }
        if (!mayGoOn()) break;
        if (flags.budgetReason) return await fail(`${flags.budgetReason} during the review`);
        // no verdict is no review: the pull request would say it was reviewed
        if (!state.findings) return await fail(review.reason === "error" ? `the review failed (${review.errorCode ?? "unknown error"})` : "the review ended without a verdict");
        findings = state.findings;
        outbox.push("review", { round, findings: findings.length, must_fix: findings.filter((item) => item.severity === "must_fix").length });
        if (!findings.some((item) => item.severity === "must_fix")) break;
      }
      if (round === limits.maxRounds) {
        const open = [...failures, ...findings.filter((item) => item.severity === "must_fix").map((item) => `review: ${item.note}`)];
        return await fail(`still not right after ${round} rounds: ${open.join("; ").slice(0, 900)}`);
      }
    }
    if (!mayGoOn()) {
      if (flags.cancelled) return report("cancelled", "the run was cancelled on TBO Support");
      if (flags.leaseLost) return report("lease_lost", "the lease ended before the fix was reported");
      return report("stopped", "the worker was stopped; the lease will expire and the fix goes back to the queue");
    }

    const done = state.done!;
    await commitAndPush(target, fix.branch, done, fix.task, key.token, cfg.homeDir);
    const github = deps.github ?? new GitHubRest(cfg.githubApi ?? "https://api.github.com");
    const pull = await github.createPull(chosen.repo, key.token, {
      title: `${fix.task}: ${done.summary}`.slice(0, 250),
      head: fix.branch,
      base: chosen.app.branch || "main",
      body: pullBody({ context, done, evidence, findings, testedOn }),
    });
    try {
      await github.addLabels(chosen.repo, key.token, pull.number, ["copilot", "no-auto-merge"]);
    } catch (error) {
      outbox.push("labels_not_added", { error: String((error as Error).message).slice(0, 300) }); // the hub adds the hold label when it follows the pull request
    }
    await outbox.flush();
    const reply = await hub.callTool(`${run}:${job.lease_token}`, "submit_change", {
      repository: chosen.repo,
      number: pull.number,
      head_sha: pull.head.sha,
      branch: fix.branch,
      summary: done.summary,
      evidence,
      tested_on: testedOn,
      people_checks: done.people_checks,
      risk_notes: [done.risk_notes, ...findings.map((item) => `${item.severity}: ${item.note}`)].filter(Boolean).join("\n").slice(0, 2000),
      cost: budget.cost(),
    });
    if (reply.isError) return await fail(`TBO Support refused the change: ${reply.text.slice(0, 300)}`);
    outbox.close();
    return report("submitted", undefined, `${chosen.repo}#${pull.number}`);
  } catch (error) {
    if (error instanceof HubError && error.leaseGone) return report("lease_lost", error.message);
    if (deps.stopping()) return report("stopped", "the worker was stopped");
    log("error", "fix job failed", { run, error: String(error) });
    return await fail(`the worker failed: ${String((error as Error)?.message ?? error).slice(0, 500)}`);
  } finally {
    clearInterval(heartbeat);
    clearInterval(watchdog);
    outbox.close();
    if (sandboxId) await sandbox.stop(sandboxId).catch(() => undefined);
    for (const id of sessions) {
      router.fixSessions.delete(id);
      await engine.closeSession(id, workspace?.root).catch(() => undefined);
    }
    if (!cfg.keepRuns) await removeWorkspace(workspaceRoot(cfg.runsDir, run)).catch(() => undefined);
  }
}
