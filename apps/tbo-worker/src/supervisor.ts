import type { LocalToolResult } from "@pi-desktop/host-runtime";

import type { ModelConfig, WorkerConfig } from "./config.js";
import { preview, type Engine, type TurnObserver, type TurnResult } from "./engine.js";
import { EventOutbox } from "./events.js";
import { runFixJob } from "./fix.js";
import { runFixTool, type FixToolState } from "./fix-tools.js";
import { HubError, type HubClient, type Job } from "./hub.js";
import type { Logger } from "./log.js";
import { StageModels, noModelReason, stageModels, type StageModel } from "./models.js";
import { RunBudget } from "./policy.js";
import { NUDGE, finalPrompt, turnPrompt } from "./prompt.js";
import type { Sandbox } from "./sandbox.js";
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

/** Routes the engine's local tool calls to the run that owns the session. */
export class RunToolRouter {
  readonly sessions = new Map<string, RunTools>();
  /** A fix job's fix and review sessions. */
  readonly fixSessions = new Map<string, FixToolState>();

  constructor(private readonly hub: HubClient) {}

  readonly run = async (sessionId: string, name: string, args: unknown): Promise<LocalToolResult> => {
    const fix = this.fixSessions.get(sessionId);
    if (fix) return runFixTool(fix, name, args);
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

  /** What the worker tells the hub it can do when claiming. */
  capabilities(): string {
    return this.sandbox ? "investigate,fix" : "investigate";
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
      let job: Job | null = null;
      try {
        job = await this.hub.claimJob(this.cfg.workerId, undefined, this.capabilities());
      } catch (error) {
        this.log("warn", "claim failed", { error: String(error) });
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
    const job = await this.hub.claimJob(this.cfg.workerId, run, this.capabilities());
    return job ? this.process(job) : null;
  }

  /** The engine's provider and model for a stage's model, set up once. */
  private async engineModel(model: ModelConfig): Promise<{ providerId: string; modelId: string }> {
    const key = `${model.providerName}|${model.modelId}`;
    let known = this.models.get(key);
    if (!known) {
      known = await this.engine.configureModel(model);
      this.models.set(key, known);
    }
    return known;
  }

  async process(job: Job): Promise<RunReport> {
    if (job.context.kind === "fix") return this.processFix(job);
    const ticket = job.context.ticket.name;
    const models = new StageModels("investigate", stageModels(this.cfg, "investigate", job.context));
    const budget = new RunBudget(this.cfg.limits, Date.now, models.current);
    const outbox = new EventOutbox((events) => this.hub.postEvents(job.run, job.lease_token, events), { log: this.log });
    const state: RunState = {
      stage: "workspace",
      submitted: false,
      submission: "",
      cancelled: false,
      leaseLost: false,
      budgetReason: "",
      finalTurn: false,
      finalToolCalls: 0,
      denied: 0,
    };
    let sessionId: string | undefined;
    const sessions: string[] = [];
    let workspace: Workspace | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    const report = (outcome: RunOutcome, reason?: string): RunReport => ({
      run: job.run,
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
      problems: workspace?.problems ?? [],
    });
    this.log("info", "run claimed", { run: job.run, ticket });
    const heartbeat = setInterval(() => void this.beat(job, state, () => sessionId), this.cfg.limits.heartbeatIntervalMs);

    try {
      if (!models.current) {
        const reason = noModelReason("investigate");
        await this.fail(job, outbox, reason);
        return report("failed", reason);
      }
      workspace = await prepareWorkspace(job, this.workspaceOptions());
      outbox.push("workspace", {
        apps: workspace.apps.map(({ app, repository, commit, source, note }) => ({ app, repository, commit, source, note })),
        problems: workspace.problems,
      });
      const root = workspace.root;
      const tools: RunTools = {
        runToken: `${job.run}:${job.lease_token}`,
        apps: Object.fromEntries(workspace.apps.map((app) => [app.app, app.dir])),
        homeDir: this.cfg.homeDir,
        cost: () => budget.cost(),
        beforeSubmit: () => outbox.flush(),
        submitted: (text) => {
          state.submitted = true;
          state.submission = text.slice(0, 500);
          outbox.close(); // the lease ended with the report: the hub accepts nothing more
          // nothing more is needed from the model: a closing reply only costs tokens, and a
          // provider failing at that point would be retried for minutes (as in the evaluation)
          const id = sessionId;
          if (id) setImmediate(() => void this.engine.abort(id));
        },
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
      const mayGoOn = () => !state.submitted && !state.cancelled && !state.leaseLost && !this.stopping;
      // the investigation: one turn, a reminder if it ended without a report, and after a limit one short turn to report
      const investigate = async (id: string): Promise<TurnResult> => {
        // a cancel, a lost lease or a stop can arrive while the clones and the session are prepared
        let turn: TurnResult = { reason: "aborted", text: "" };
        if (mayGoOn()) turn = await this.engine.runTurn(id, turnPrompt(job.context, workspace!), observer);
        if (mayGoOn() && !state.budgetReason && turn.reason === "completed") {
          outbox.push("reminder", { note: "the turn ended without a report" });
          turn = await this.engine.runTurn(id, NUDGE, observer);
        }
        if (mayGoOn() && state.budgetReason) {
          // a limit stopped the work: one short turn to report what was found, rather than nothing
          outbox.push("final_turn", { reason: state.budgetReason });
          state.finalTurn = true;
          const timer = setTimeout(() => void this.engine.abort(id), FINAL_TURN_MS);
          try {
            turn = await this.engine.runTurn(id, finalPrompt(state.budgetReason), observer);
          } finally {
            clearTimeout(timer);
          }
        }
        return turn;
      };
      let turn = await investigate(sessionId!);
      // the provider failed: the investigation starts again once, in a fresh session on the fallback model
      const fallback = mayGoOn() && !state.budgetReason ? models.next(turn) : undefined;
      if (fallback) {
        outbox.push("fallback", { job: "investigate", model: fallback.modelId, section: fallback.section, after: turn.errorCode });
        this.log("warn", "investigation moves to the fallback model", { run: job.run, model: fallback.modelId, error: turn.errorCode });
        turn = await investigate(await openOn(fallback));
      }
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
    } catch (error) {
      if (state.submitted) return report("submitted");
      if (error instanceof HubError && error.leaseGone) return report("lease_lost", error.message);
      if (this.stopping) return report("stopped", "the worker was stopped");
      const reason = `the worker failed: ${String((error as Error)?.message ?? error).slice(0, 500)}`;
      this.log("error", "run failed", { run: job.run, error: String(error) });
      await this.fail(job, outbox, reason);
      return report("failed", reason);
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
      onToolEnd: ({ toolName, isError, ms, result }) => {
        outbox.push("tool_result", { tool: toolName, is_error: isError, ms, ...(isError ? { error: result.slice(0, 500) } : {}) });
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
          tokens_out: usage.outputTokens ?? 0,
        });
        if (!state.finalTurn) check();
      },
      onAssistantText: (text) => {
        outbox.push("assistant", { text: text.slice(0, 1_000) });
      },
    };
  }

  private async beat(job: Job, state: RunState, session: () => string | undefined): Promise<void> {
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

  private async fail(job: Job, outbox: EventOutbox, reason: string): Promise<void> {
    await outbox.flush().catch(() => undefined);
    try {
      await this.hub.submitFailure(job.run, job.lease_token, reason);
    } catch (error) {
      this.log("warn", "failure not reported", { run: job.run, error: String(error) });
    }
  }
}
