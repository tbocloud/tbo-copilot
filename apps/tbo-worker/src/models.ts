import type { ModelConfig, WorkerConfig } from "./config.js";
import type { TurnResult } from "./engine.js";
import type { RunContext } from "./hub.js";

export type WorkerJob = "investigate" | "fix" | "review";

/** A model a stage may use: the engine's settings for it, its prices, and where it came from. */
export type StageModel = ModelConfig & {
  job: WorkerJob;
  /** The TBO Support section it came from; empty for the older single model. */
  section: string;
  fallback: boolean;
};

const price = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * The models a stage may use, main first and at most one fallback: TBO Support's list for the
 * job (`run_context.models`), keeping only the sections this worker has a key for. A section it
 * does not know is never used. With none left, the older single model, when it is set.
 */
export function stageModels(cfg: Pick<WorkerConfig, "providers" | "model">, job: WorkerJob, context: Pick<RunContext, "models">): StageModel[] {
  const listed = context.models?.[job];
  const plans: StageModel[] = [];
  for (const entry of Array.isArray(listed) ? listed : []) {
    const provider = cfg.providers.find((candidate) => candidate.section === entry?.section);
    const modelId = typeof entry?.model === "string" ? entry.model.trim() : "";
    if (!provider || !modelId || plans.some((plan) => plan.section === provider.section && plan.modelId === modelId)) continue;
    const { section, ...settings } = provider;
    const cached = price(entry.price_cached);
    plans.push({
      ...settings,
      modelId,
      priceInPerMillion: price(entry.price_in),
      priceOutPerMillion: price(entry.price_out),
      // an unpriced cache read costs the input price, never nothing
      ...(cached ? { priceCachedPerMillion: cached } : {}),
      job,
      section,
      fallback: plans.length > 0,
    });
    if (plans.length === 2) break;
  }
  if (!plans.length && cfg.model) plans.push({ ...cfg.model, job, section: "", fallback: false });
  return plans;
}

/** Failures another provider may not have: a key, billing or quota, a wrong model, the server, the network, a timeout. */
const PROVIDER_FAILURES = new Set(["PROVIDER_UNAUTHORIZED", "PROVIDER_RATE_LIMITED", "MODEL_NOT_CONFIGURED", "TIMEOUT", "NETWORK_ERROR", "STREAM_FAILED"]);

/**
 * Whether a failed turn may restart on the fallback model. A request the provider refused as
 * invalid (400, 422, or a setting the adapter cannot send) fails the same way everywhere, and
 * an abort, a limit or a context too large is not the provider's failure.
 */
export function shouldFallBack(turn: TurnResult): boolean {
  if (turn.reason !== "error" || !turn.errorCode) return false;
  if (PROVIDER_FAILURES.has(turn.errorCode)) return true;
  if (turn.errorCode !== "PROVIDER_ERROR") return false;
  if (turn.providerStatus !== undefined) return turn.providerStatus !== 400 && turn.providerStatus !== 422;
  return turn.retriable !== false;
}

/** One stage's models: the main one, then the fallback once, for the rest of the run. */
export class StageModels {
  private index = 0;

  constructor(
    readonly job: WorkerJob,
    private readonly plans: StageModel[],
  ) {}

  get current(): StageModel | undefined {
    return this.plans[this.index];
  }

  /** The fallback after a turn that failed on the provider; undefined when there is none or it was used already. */
  next(turn: TurnResult): StageModel | undefined {
    if (!shouldFallBack(turn) || this.index + 1 >= this.plans.length) return undefined;
    this.index += 1;
    return this.plans[this.index];
  }
}

/** Why a stage has no model, for the run's failure. */
export function noModelReason(job: WorkerJob): string {
  return `TBO Support names no ${job} model this worker has a key for (set TBO_PROVIDER_OPENAI_API_KEY or TBO_PROVIDER_MOONSHOT_API_KEY)`;
}
