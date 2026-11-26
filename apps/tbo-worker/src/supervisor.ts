import { mkdir } from "node:fs/promises";

import type { LocalToolResult } from "@pi-desktop/host-runtime";

import type { ModelConfig, WorkerConfig } from "./config.js";
import { preview, type Engine, type TurnObserver, type TurnResult } from "./engine.js";
import { EventOutbox } from "./events.js";
import { runFixJob } from "./fix.js";
import { runFixTool, type FixToolState } from "./fix-tools.js";
import { HubError, isInfraJob, isPrFix, isReleaseCheck, type ClaimedJob, type HubClient, type InfraJob, type Job, type PrFixJob, type ReleaseCheckJob } from "./hub.js";
import { INFRA_NUDGE, infraFinalPrompt, infraTurnPrompt } from "./infra-prompt.js";
import { runInfraTool, type InfraTools } from "./infra-tools.js";
import type { Logger } from "./log.js";
import { StageModels, noModelReason, stageModels, type StageModel } from "./models.js";
import { RunBudget, smallestCap } from "./policy.js";
import { siteAppNames } from "./references.js";
import { runPrFixJob, type PrFixReport } from "./pr-fix.js";
import { runPrFixTool, type PrFixToolState } from "./pr-fix-tools.js";
import { runReleaseCheck, type ReleaseCheckReport } from "./release-check.js";
import { NUDGE, finalPrompt, turnPrompt } from "./prompt.js";
import type { Sandbox } from "./sandbox.js";
import { SuspiciousWatch } from "./suspicious.js";
import { runTool, type RunTools } from "./tools.js";
import { prepareWorkspace, removeWorkspace, workspaceRoot, type Workspace, type WorkspaceOptions } from "./workspace.js";

export type RunOutcome = "submitted" | "failed" | "cancelled" | "lease_lost" | "stopped";

/** After a limit stops the investigation, the model gets one short turn to report: at most this many tool calls and minutes. */
export const FINAL_TURN_TOOL_CALLS = 3;
export const FINAL_TURN_MS = 3 * 60_000;

export type RunReport = {
  run: string;
  ticket: string;
  outcome: RunOutcome;
  reason?: string;
  submission?: string;
  toolCalls: number;
  denied: number;
  tokensIn: number;
  /** The part of tokensIn the provider served from its cache. */
  tokensCached: number;
  tokensOut: number;
  costUsd: number;
  /** The models that answered, in the order used (a fallback comes second). */
  model?: string;
  minutes: number;
  problems: string[];
};

/** The engine profile an infrastructure run's sessions use (cli.ts registers it). */
export const INFRA_PROFILE_NAME = "infra";

type RunState = {
  stage: string;
  submitted: boolean;
  submission: string;
  cancelled: boolean;
  leaseLost: boolean;
  budgetReason: string;
  /** The last-chance turn after a limit: tool calls in it are counted, not checked against the limits again. */
  finalTurn: boolean;
  finalToolCalls: number;
  denied: number;
};

function newRunState(stage: string): RunState {
  return { stage, submitted: false, submission: "", cancelled: false, leaseLost: false, budgetReason: "", finalTurn: false, finalToolCalls: 0, denied: 0 };
}

/** The run and its lease: what the worker API's calls need. */
type Lease = Pick<Job, "run" | "lease_token">;
type Reporter = (outcome: RunOutcome, reason?: string) => RunReport;

/** The run's report so far: the outcome with the spend measured by its budget. */
function reporter(run: string, ticket: string, budget: RunBudget, state: RunState, problems: () => string[]): Reporter {
  return (outcome, reason) => ({
    run,
    ticket,
    outcome,
    ...(reason ? { reason } : {}),
    ...(state.submission ? { submission: state.submission } : {}),
    toolCalls: budget.spend.toolCalls,
    denied: state.denied,
    tokensIn: budget.spend.tokensIn,
    tokensCached: budget.spend.tokensCached,
    tokensOut: budget.spend.tokensOut,
    costUsd: Number(budget.cost().usd ?? 0),
    model: String(budget.cost().model ?? ""),
    minutes: Math.round(budget.minutes() * 10) / 10,
    problems: problems(),
  });
}

/** Routes the engine's local tool calls to the run that owns the session. */
export class RunToolRouter {
  readonly sessions = new Map<string, RunTools>();
  /** A fix job's fix and review sessions. */
  readonly fixSessions = new Map<string, FixToolState>();
  /** An infrastructure alert's sessions (Phase 25): Press reads and the infra report, nothing else. */
  readonly infraSessions = new Map<string, InfraTools>();
  /** A developer's pull request's fix sessions (Phase 26). */
  readonly prFixSessions = new Map<string, PrFixToolState>();

  constructor(private readonly hub: HubClient) {}

  readonly run = async (sessionId: string, name: string, args: unknown): Promise<LocalToolResult> => {
    const fix = this.fixSessions.get(sessionId);
    if (fix) return runFixTool(fix, name, args);
    const pr = this.prFixSessions.get(sessionId);
    if (pr) return runPrFixTool(pr, name, args);
    const infra = this.infraSessions.get(sessionId);
    if (infra) return runInfraTool(this.hub, infra, name, args);
    const tools = this.sessions.get(sessionId);
    if (!tools) return { ok: false, isError: true, content: "This session has no active Copilot run." };
    return runTool(this.hub, tools, name, args);
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * The worker's job loop: claim a run, keep its lease alive, prepare the
 * read-only workspace, run one investigation turn (and one reminder if the
 * model forgot to report), then report a failure if there is no diagnosis.
 * A worker that is stopped mid-run reports nothing: the lease expires and the
 * hub puts the run back in the queue.
 */
export class Worker {
  private stopping = false;
  private currentSession: string | undefined;
  /** The engine's provider and model for each model a run has used, by provider and model. */
  private readonly models = new Map<string, { providerId: string; modelId: string }>();

  constructor(
    private readonly cfg: WorkerConfig,
    private readonly hub: HubClient,
    private readonly engine: Engine,
    private readonly router: RunToolRouter,
    private readonly log: Logger,
    /** The sandbox runner; with it the worker also takes fix jobs. */
    private readonly sandbox?: Sandbox,
  ) {}

  /**
   * What the worker tells the hub it can do when claiming: investigations and infrastructure
   * alerts (which need no sandbox); with the sandbox, fixes, releases' checks and developers'
   * pull requests too.
   */
  capabilities(): string {
    return this.sandbox ? "investigate,fix,release_check,infra,pr_fix" : "investigate,infra";
  }

  workspaceOptions(): WorkspaceOptions {
    return {
      runsDir: this.cfg.runsDir,
      reposDir: this.cfg.reposDir,
      homeDir: this.cfg.homeDir,
      ...(this.cfg.githubToken ? { githubToken: this.cfg.githubToken } : {}),
      repoMap: this.cfg.repoMap,
      ...(this.cfg.allowLocalRepos ? { allowLocalRepos: true } : {}),
      log: (message, data) => this.log("warn", message, data),
    };
  }

  /** Stops after the current run; the current turn is interrupted and its lease left to expire. */
  stop(): void {
    this.stopping = true;
    if (this.currentSession) void this.engine.abort(this.currentSession);
  }

  async runForever(signal: AbortSignal): Promise<void> {
    this.log("info", "worker started", {
      workerId: this.cfg.workerId,
      hub: this.cfg.hubUrl,
      providers: this.cfg.providers.map((provider) => provider.section),
      ...(this.cfg.model ? { model: this.cfg.model.modelId } : {}),
    });
    while (!signal.aborted && !this.stopping) {
      let job: ClaimedJob | null = null;
      try {
        job = await this.hub.claimJob(this.cfg.workerId, undefined, this.capabilities());
      } catch (error) {
        this.log("warn", "claim failed", { error: String(error) });
      }
      if (job && isReleaseCheck(job)) {
        const report = await this.processReleaseCheck(job);
        this.log("info", "release check finished", report as unknown as Record<string, unknown>);
        continue;
      }
      if (job && isPrFix(job)) {
        const report = await this.processPrFix(job);
        this.log("info", "pull request fix finished", report as unknown as Record<string, unknown>);
        continue;
      }
      if (job) {
        const report = await this.process(job);
        this.log("info", "run finished", report as unknown as Record<string, unknown>);
        continue;
      }
      await sleep(this.cfg.limits.claimIntervalMs, signal);
    }
    this.log("info", "worker stopped");
  }

  /** Claims one run (the named one, when given and queued) and investigates it; null when there is none. */
  async runOnce(run?: string): Promise<RunReport | null> {
    // runs only: releases' checks and pull requests are taken by the worker's loop (`start`)
    const runsOnly = this.capabilities().split(",").filter((capability) => capability !== "release_check" && capability !== "pr_fix");
    const job = await this.hub.claimJob(this.cfg.workerId, run, runsOnly.join(","));
    if (!job) return null;
    if (isReleaseCheck(job)) {
      await this.processReleaseCheck(job);
      return null;
    }
    if (isPrFix(job)) {
      await this.processPrFix(job);
      return null;
    }
    return this.process(job);
  }

  /** A release's check on the sandbox: no model, only the runner's fixed operations. */
  async processReleaseCheck(job: ReleaseCheckJob): Promise<ReleaseCheckReport> {
    if (!this.sandbox) {
      // never asked for without the sandbox; the hub's lease expires and another worker takes it
      return { release: job.release, outcome: "not_reported", rows: [] };
    }
    return runReleaseCheck(job, {
      hub: this.hub,
      sandbox: this.sandbox,
      workspaceOptions: () => this.workspaceOptions(),
      log: this.log,
    });
  }

  /**
   * A developer's pull request (Phase 26): fix what CodeRabbit and CI found and push it to the pull
   * request's own branch. See pr-fix.ts.
   */
  async processPrFix(job: PrFixJob): Promise<PrFixReport> {
    return runPrFixJob(job, {
      cfg: this.cfg,
      hub: this.hub,
      engine: this.engine,
      router: this.router,
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
      log: this.log,
      engineModel: (model) => this.engineModel(model),
      stopping: () => this.stopping,
      workspaceOptions: () => this.workspaceOptions(),
    });
  }

  /** The engine's provider and model for a stage's model, set up once. A provider name has one address and key (config.ts). */
  private async engineModel(model: ModelConfig): Promise<{ providerId: string; modelId: string }> {
    const key = `${model.providerName}|${model.modelId}`;
    let known = this.models.get(key);
    if (!known) {
      known = await this.engine.configureModel(model);
      this.models.set(key, known);
    }
    return known;
  }

  async process(job: Job | InfraJob): Promise<RunReport> {
    if (isInfraJob(job)) return this.processInfra(job);
    if (job.context.kind === "fix") return this.processFix(job);
    const ticket = job.context.ticket.name;
    const models = new StageModels("investigate", stageModels(this.cfg, "investigate", job.context));
    // the worker's own dollar limit, or TBO Support's cap per diagnosis when it is lower
    const maxUsd = smallestCap(this.cfg.limits.maxUsd, job.context.limits?.max_usd);
    const budget = new RunBudget({ ...this.cfg.limits, maxUsd }, Date.now, models.current);
    const outbox = new EventOutbox((events) => this.hub.postEvents(job.run, job.lease_token, events), { log: this.log });
    const state = newRunState("workspace");
    let sessionId: string | undefined;
    const sessions: string[] = [];
    let workspace: Workspace | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    const report = reporter(job.run, ticket, budget, state, () => workspace?.problems ?? []);
    this.log("info", "run claimed", { run: job.run, ticket });
    const heartbeat = setInterval(() => void this.beat(job, state, () => sessionId), this.cfg.limits.heartbeatIntervalMs);

    try {
      if (!models.current) {
        const reason = noModelReason("investigate");
        await this.fail(job, outbox, reason);
        return report("failed", reason);
      }
      workspace = await prepareWorkspace(job, {
        ...this.workspaceOptions(),
        // the ticket's pictures and videos, through the hub while the lease holds
        fetchFile: (fileUrl) => this.hub.ticketFile(job.run, job.lease_token, fileUrl),
      });
      outbox.push("workspace", {
        apps: workspace.apps.map(({ app, repository, commit, source, note }) => ({ app, repository, commit, source, note })),
        problems: workspace.problems,
      });
      const root = workspace.root;
      const tools: RunTools = {
        runToken: `${job.run}:${job.lease_token}`,
        apps: Object.fromEntries(workspace.apps.map((app) => [app.app, app.dir])),
        installedApps: siteAppNames(job.context),
        homeDir: this.cfg.homeDir,
        cost: () => budget.cost(),
        beforeSubmit: () => outbox.flush(),
        submitted: this.onSubmitted(state, outbox, () => sessionId),
        isSubmitted: () => state.submitted,
        prepareCorrection: job.context.prepare_correction === true,
      };
      // a fresh session on the stage's model; the run's tools follow it
      const openOn = async (plan: StageModel): Promise<string> => {
        budget.use(plan);
        const id = await this.engine.openSession(root, `Copilot ${job.run}, ticket ${ticket}`, await this.engineModel(plan));
        sessions.push(id);
        sessionId = id;
        this.currentSession = id;
        this.router.sessions.set(id, tools);
        return id;
      };
      await openOn(models.current);
      state.stage = "investigate";
      const observer = this.observer(outbox, budget, state, () => sessionId);
      // the time limit holds even while the model thinks without any event
      watchdog = setInterval(() => {
        if (!state.finalTurn) observer.check();
      }, 15_000);
      const turn = await this.investigationTurns(
        job.run,
        { first: turnPrompt(job.context, workspace), nudge: NUDGE, final: finalPrompt },
        { session: sessionId!, openOn, models, state, outbox, observer },
      );
      return await this.ending(job, outbox, state, turn, report);
    } catch (error) {
      return await this.crashed(job, outbox, state, error, report);
    } finally {
      clearInterval(heartbeat);
      if (watchdog) clearInterval(watchdog);
      outbox.close();
      for (const id of sessions) {
        this.router.sessions.delete(id);
        await this.engine.closeSession(id, workspace?.root).catch(() => undefined);
      }
      this.currentSession = undefined;
      if (!this.cfg.keepRuns) await removeWorkspace(workspaceRoot(this.cfg.runsDir, job.run)).catch(() => undefined);
    }
  }

  /**
   * An infrastructure alert (Phase 25): no clone, no sandbox and no customer site. The model gets
   * the alert, Press's facts and the earlier repairs in its first message, may read Press again
   * through TBO Support, and reports with submit_infra_investigation, proposing at most one action
   * from the run's list. TBO Support checks the proposal and asks a person before anything runs.
   */
  async processInfra(job: InfraJob): Promise<RunReport> {
    const context = job.context;
    const ticket = String(context.alert?.ticket ?? "");
    // the same models as an investigation (TBO Support's `investigate` job)
    const models = new StageModels("investigate", stageModels(this.cfg, "investigate", context));
    // the worker's own dollar limit, or TBO Support's cap per infra diagnosis when it is lower
    const maxUsd = smallestCap(this.cfg.limits.maxUsd, context.dollar_cap);
    const budget = new RunBudget({ ...this.cfg.limits, maxUsd }, Date.now, models.current);
    const outbox = new EventOutbox((events) => this.hub.postEvents(job.run, job.lease_token, events), { log: this.log });
    const state = newRunState("investigate");
    let sessionId: string | undefined;
    const sessions: string[] = [];
    let watchdog: NodeJS.Timeout | undefined;
    // a session needs a folder: an empty one, since an alert has no code or files to read
    const root = workspaceRoot(this.cfg.runsDir, job.run);
    const report = reporter(job.run, ticket, budget, state, () => []);
    this.log("info", "infra run claimed", { run: job.run, ticket });
    const heartbeat = setInterval(() => void this.beat(job, state, () => sessionId), this.cfg.limits.heartbeatIntervalMs);

    try {
      if (!models.current) {
        const reason = noModelReason("investigate");
        await this.fail(job, outbox, reason);
        return report("failed", reason);
      }
      if (!this.engine.hasProfile(INFRA_PROFILE_NAME)) {
        // without its own profile the session would get the ticket investigation's tools and rules
        const reason = "this worker's engine has no infra profile";
        await this.fail(job, outbox, reason);
        return report("failed", reason);
      }
      await removeWorkspace(root);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const actions = (context.actions ?? []).map((action) => String(action?.name ?? "")).filter(Boolean);
      const mayTarget = (context.may_target ?? []).map(String).filter(Boolean);
      outbox.push("workspace", { kind: "infra", target: context.target ?? null, actions, may_target: mayTarget });
      // text in the alert or the facts that tries to instruct the AI: recorded for the team, as a ticket's files are
      const watch = new SuspiciousWatch();
      for (const line of watch.check(JSON.stringify([context.alert, context.press, context.hub_health, context.repairs]))) {
        outbox.push("suspicious_instruction", { tool: "alert", text: line });
      }
      const tools: InfraTools = {
        runToken: `${job.run}:${job.lease_token}`,
        actions,
        mayTarget,
        cost: () => budget.cost(),
        note: (text) => outbox.push("note", { text }),
        beforeSubmit: () => outbox.flush(),
        submitted: this.onSubmitted(state, outbox, () => sessionId),
        isSubmitted: () => state.submitted,
      };
      const openOn = async (plan: StageModel): Promise<string> => {
        budget.use(plan);
        const id = await this.engine.openSession(root, `Copilot ${job.run}, alert ${ticket}`, await this.engineModel(plan), { profile: INFRA_PROFILE_NAME });
        sessions.push(id);
        sessionId = id;
        this.currentSession = id;
        this.router.infraSessions.set(id, tools);
        return id;
      };
      await openOn(models.current);
      const observer = this.observer(outbox, budget, state, () => sessionId);
      watchdog = setInterval(() => {
        if (!state.finalTurn) observer.check();
      }, 15_000);
      const turn = await this.investigationTurns(
        job.run,
        { first: infraTurnPrompt(context), nudge: INFRA_NUDGE, final: infraFinalPrompt },
        { session: sessionId!, openOn, models, state, outbox, observer },
      );
      return await this.ending(job, outbox, state, turn, report);
    } catch (error) {
      return await this.crashed(job, outbox, state, error, report);
    } finally {
      clearInterval(heartbeat);
      if (watchdog) clearInterval(watchdog);
      outbox.close();
      for (const id of sessions) {
        this.router.infraSessions.delete(id);
        await this.engine.closeSession(id, root).catch(() => undefined);
      }
      this.currentSession = undefined;
      if (!this.cfg.keepRuns) await removeWorkspace(root).catch(() => undefined);
    }
  }

  /** The hub took the report: the run is done, and the model is stopped. */
  private onSubmitted(state: RunState, outbox: EventOutbox, session: () => string | undefined): (text: string) => void {
    return (text) => {
      state.submitted = true;
      state.submission = text.slice(0, 500);
      outbox.close(); // the lease ended with the report: the hub accepts nothing more
      // nothing more is needed from the model: a closing reply only costs tokens, and a
      // provider failing at that point would be retried for minutes (as in the evaluation)
      const id = session();
      if (id) setImmediate(() => void this.engine.abort(id));
    };
  }

  /**
   * An investigation's turns, a ticket's or an alert's: one turn, a reminder if it ended without
   * a report, and after a limit one short turn to report. When the provider failed, the same
   * again once, in a fresh session on the fallback model.
   */
  private async investigationTurns(
    run: string,
    prompts: { first: string; nudge: string; final: (reason: string) => string },
    on: {
      session: string;
      openOn: (plan: StageModel) => Promise<string>;
      models: StageModels;
      state: RunState;
      outbox: EventOutbox;
      observer: TurnObserver;
    },
  ): Promise<TurnResult> {
    const { state, outbox, observer } = on;
    const mayGoOn = () => !state.submitted && !state.cancelled && !state.leaseLost && !this.stopping;
    const investigate = async (id: string): Promise<TurnResult> => {
      // a cancel, a lost lease or a stop can arrive while the clones and the session are prepared
      let turn: TurnResult = { reason: "aborted", text: "" };
      if (mayGoOn()) turn = await this.engine.runTurn(id, prompts.first, observer);
      if (mayGoOn() && !state.budgetReason && turn.reason === "completed") {
        outbox.push("reminder", { note: "the turn ended without a report" });
        turn = await this.engine.runTurn(id, prompts.nudge, observer);
      }
      if (mayGoOn() && state.budgetReason) {
        // a limit stopped the work: one short turn to report what was found, rather than nothing
        outbox.push("final_turn", { reason: state.budgetReason });
        state.finalTurn = true;
        const timer = setTimeout(() => void this.engine.abort(id), FINAL_TURN_MS);
        try {
          turn = await this.engine.runTurn(id, prompts.final(state.budgetReason), observer);
        } finally {
          clearTimeout(timer);
        }
      }
      return turn;
    };
    let turn = await investigate(on.session);
    // the provider failed: the investigation starts again once, in a fresh session on the fallback model
    const fallback = mayGoOn() && !state.budgetReason ? on.models.next(turn) : undefined;
    if (fallback) {
      outbox.push("fallback", { job: on.models.job, model: fallback.modelId, section: fallback.section, after: turn.errorCode });
      this.log("warn", "investigation moves to the fallback model", { run, model: fallback.modelId, error: turn.errorCode });
      turn = await investigate(await on.openOn(fallback));
    }
    return turn;
  }

  /** How a run ended after its turns: the report the hub took, or the failure reported to it. */
  private async ending(job: Lease, outbox: EventOutbox, state: RunState, turn: TurnResult, report: Reporter): Promise<RunReport> {
    if (state.submitted) return report("submitted");
    if (state.cancelled) return report("cancelled", "the run was cancelled on TBO Support");
    if (state.leaseLost) return report("lease_lost", "the lease ended before a report");
    if (this.stopping) return report("stopped", "the worker was stopped; the lease will expire and the run goes back to the queue");
    const reason =
      (state.budgetReason && `${state.budgetReason}, and no report came after a last request to submit`) ||
      (turn.reason === "error"
        ? `the model failed (${turn.errorCode ?? "unknown error"})${turn.text ? `: ${turn.text.slice(0, 300)}` : ""}`
        : "the model ended without a diagnosis");
    await this.fail(job, outbox, reason);
    return report("failed", reason);
  }

  /** The worker itself failed during a run; a report the hub already took still stands. */
  private async crashed(job: Lease, outbox: EventOutbox, state: RunState, error: unknown, report: Reporter): Promise<RunReport> {
    if (state.submitted) return report("submitted");
    if (error instanceof HubError && error.leaseGone) return report("lease_lost", error.message);
    if (this.stopping) return report("stopped", "the worker was stopped");
    const reason = `the worker failed: ${String((error as Error)?.message ?? error).slice(0, 500)}`;
    this.log("error", "run failed", { run: job.run, error: String(error) });
    await this.fail(job, outbox, reason);
    return report("failed", reason);
  }

  /** A fix job (Phase 1c-2): see fix.ts. */
  private async processFix(job: Job): Promise<RunReport> {
    if (!this.sandbox) {
      const reason = "this worker has no sandbox runner, so it cannot fix";
      await this.hub.submitFailure(job.run, job.lease_token, reason).catch(() => undefined);
      return { run: job.run, ticket: job.context.ticket.name, outcome: "failed", reason, toolCalls: 0, denied: 0, tokensIn: 0, tokensCached: 0, tokensOut: 0, costUsd: 0, minutes: 0, problems: [] };
    }
    return runFixJob(job, {
      cfg: this.cfg,
      hub: this.hub,
      engine: this.engine,
      router: this.router,
      sandbox: this.sandbox,
      log: this.log,
      engineModel: (model) => this.engineModel(model),
      stopping: () => this.stopping,
      workspaceOptions: () => this.workspaceOptions(),
    });
  }

  private observer(
    outbox: EventOutbox,
    budget: RunBudget,
    state: RunState,
    session: () => string | undefined,
  ): TurnObserver & { check: () => void } {
    const watch = new SuspiciousWatch();
    const check = () => {
      const reason = budget.exceeded();
      const id = session();
      if (reason && !state.budgetReason && !state.submitted && id) {
        state.budgetReason = reason;
        outbox.push("budget", { reason });
        void this.engine.abort(id);
      }
    };
    return {
      check,
      onToolStart: ({ toolName, args, delegate }) => {
        budget.toolCall();
        outbox.push("tool_call", { tool: toolName, args: preview(args, 500), ...(delegate ? { delegate } : {}) });
        if (!state.finalTurn) return check();
        state.finalToolCalls += 1;
        const id = session();
        if (state.finalToolCalls > FINAL_TURN_TOOL_CALLS && !state.submitted && id) void this.engine.abort(id);
      },
      onToolEnd: ({ toolName, isError, ms, result, text }) => {
        outbox.push("tool_result", { tool: toolName, is_error: isError, ms, ...(isError ? { error: result.slice(0, 500) } : {}) });
        // text that tries to instruct the AI: recorded for the team, whatever the model makes of it
        for (const line of watch.check(text ?? result)) outbox.push("suspicious_instruction", { tool: toolName, text: line });
      },
      onPermissionDenied: (request) => {
        state.denied += 1;
        outbox.push("permission_denied", { tool: request.toolName, reason: request.reason, args: preview(request.argsPreview, 300) });
      },
      onInputAnswered: (request) => {
        outbox.push("input_answered", { questions: request.questions.slice(0, 5).map((question) => question.question) });
      },
      onUsage: (usage) => {
        budget.usage(usage);
        outbox.push("usage", {
          tokens_in: usage.inputTokens ?? 0,
          cached: usage.cacheReadTokens ?? 0,
          ...(usage.cacheWriteTokens ? { cache_write: usage.cacheWriteTokens } : {}),
          tokens_out: usage.outputTokens ?? 0,
        });
        if (!state.finalTurn) check();
      },
      onAssistantText: (text) => {
        outbox.push("assistant", { text: text.slice(0, 1_000) });
      },
    };
  }

  private async beat(job: Lease, state: RunState, session: () => string | undefined): Promise<void> {
    if (state.submitted) return;
    try {
      const answer = await this.hub.heartbeat(job.run, job.lease_token, state.stage);
      if (answer.action === "cancel") state.cancelled = true;
    } catch (error) {
      if (state.submitted) return;
      if (error instanceof HubError && error.leaseGone) state.leaseLost = true;
      else this.log("warn", "heartbeat failed", { run: job.run, error: String(error) });
    }
    const id = session();
    if ((state.cancelled || state.leaseLost) && id) await this.engine.abort(id);
  }

  private async fail(job: Lease, outbox: EventOutbox, reason: string): Promise<void> {
    await outbox.flush().catch(() => undefined);
    try {
      await this.hub.submitFailure(job.run, job.lease_token, reason);
    } catch (error) {
      this.log("warn", "failure not reported", { run: job.run, error: String(error) });
    }
  }
}
