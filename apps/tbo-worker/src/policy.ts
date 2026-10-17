import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { AskToolRequest, MessageUsage, ToolPermissionRequest } from "@pi-desktop/shared";

import type { Limits, ModelConfig } from "./config.js";

/**
 * The read-only rule, as the worker enforces it on top of host-core: every
 * permission prompt is refused. In `ask` mode host-core prompts for Bash,
 * Write, Edit, unknown tools and any path outside the run's folder, so all of
 * those end here; Read, Glob and Grep inside the folder never prompt.
 */
export const PERMISSION_DECISION = "deny" as const;

export type PermissionAnswer = "allow-once" | "deny";
export type PermissionDecider = (request: ToolPermissionRequest) => PermissionAnswer;

/** The tools that change a file; a fix session may use them inside its app, nothing else is ever allowed. */
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The fix stage's rule: Edit, Write and MultiEdit, by the session itself (not
 * a delegate), on a path inside `writableDir` but outside its `.git`, and not
 * through a symbolic link that leads elsewhere. Everything else is refused.
 */
export function editsInside(root: string, writableDir: string): PermissionDecider {
  const realDir = realpathSync(writableDir);
  return (request) => {
    if (!EDIT_TOOLS.has(request.toolName) || request.agentName) return "deny";
    const args = (request.argsPreview ?? {}) as Record<string, unknown>;
    const raw = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
    if (!raw) return "deny";
    const target = resolve(root, raw);
    if (!within(writableDir, target)) return "deny";
    // any .git folder, at any depth and in any case (macOS file systems ignore case)
    if (relative(writableDir, target).split(sep).some((part) => part.toLowerCase() === ".git")) return "deny";
    // the nearest existing folder must really be inside, and an existing target must not be a link
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) return "deny";
    let parent = dirname(target);
    while (!existsSync(parent)) parent = dirname(parent);
    return within(realDir, realpathSync(parent)) ? "allow-once" : "deny";
  };
}

export const INPUT_ANSWER =
  "No person is available during this investigation. Take the safest assumption, say so in your evidence, and continue.";

/** One answer per question, as the runtime expects them. */
export function answersFor(request: Pick<AskToolRequest, "questions">): string[][] {
  return request.questions.map(() => [INPUT_ANSWER]);
}

/** `tokensIn` counts every input token, `tokensCached` the part the provider served from its cache. */
export type Spend = { toolCalls: number; tokensIn: number; tokensCached: number; tokensOut: number; startedAt: number };
export type Prices = Pick<ModelConfig, "modelId" | "priceInPerMillion" | "priceOutPerMillion" | "priceCachedPerMillion">;
/** A stage on one model: what the run's tokens are counted against from `use()` on. */
export type StagePrices = Prices & { job: string; section?: string; fallback?: boolean };

type Segment = StagePrices & { tokensIn: number; tokensCached: number; tokensOut: number };

function dollars(segment: Segment): number {
  const cachedPrice = segment.priceCachedPerMillion ?? segment.priceInPerMillion;
  return ((segment.tokensIn - segment.tokensCached) * segment.priceInPerMillion + segment.tokensCached * cachedPrice + segment.tokensOut * segment.priceOutPerMillion) / 1_000_000;
}

/**
 * Tool calls, tokens and time for one run. `exceeded()` names the first limit
 * passed, so the turn can be stopped and the run failed with that reason.
 * Tokens are also counted per stage and model (`use()`), so the cost stays
 * right after a stage moves to its fallback model.
 */
export class RunBudget {
  readonly spend: Spend;
  private readonly seenOperations = new Set<string>();
  private readonly segments: Segment[] = [];
  private current: Segment | undefined;

  constructor(
    private readonly limits: Pick<Limits, "maxToolCalls" | "maxMinutes" | "maxTokens"> & Partial<Pick<Limits, "maxUsd">>,
    private readonly now: () => number = Date.now,
    first?: StagePrices,
  ) {
    this.spend = { toolCalls: 0, tokensIn: 0, tokensCached: 0, tokensOut: 0, startedAt: now() };
    if (first) this.use(first);
  }

  /** The stage and model the next tokens belong to; the same stage on the same model adds to its earlier share. */
  use(stage: StagePrices): void {
    const { job, modelId, priceInPerMillion, priceOutPerMillion, priceCachedPerMillion } = stage;
    const section = stage.section ?? "";
    const fallback = Boolean(stage.fallback);
    this.current = this.segments.find((item) => item.job === job && item.modelId === modelId && (item.section ?? "") === section && Boolean(item.fallback) === fallback);
    if (this.current) return;
    this.current = {
      job, modelId, section, fallback, priceInPerMillion, priceOutPerMillion,
      ...(priceCachedPerMillion !== undefined ? { priceCachedPerMillion } : {}),
      tokensIn: 0, tokensCached: 0, tokensOut: 0,
    };
    this.segments.push(this.current);
  }

  toolCall(): void {
    this.spend.toolCalls += 1;
  }

  /** Counts one model request's usage once, even when it is reported again. */
  usage(usage: MessageUsage | undefined): void {
    if (!usage) return;
    if (usage.operationId) {
      if (this.seenOperations.has(usage.operationId)) return;
      this.seenOperations.add(usage.operationId);
    }
    const cached = Math.max(0, usage.cacheReadTokens || 0);
    // OpenAI's Responses API reports the input it writes to its cache apart, outside inputTokens: it is fresh input
    const tokensIn = Math.max(0, usage.inputTokens || 0) + Math.max(0, usage.cacheWriteTokens || 0) + cached;
    const tokensOut = Math.max(0, usage.outputTokens || 0);
    for (const total of [this.spend, this.current]) {
      if (!total) continue;
      total.tokensIn += tokensIn;
      total.tokensCached += cached;
      total.tokensOut += tokensOut;
    }
  }

  minutes(): number {
    return (this.now() - this.spend.startedAt) / 60_000;
  }

  /** Dollars so far, at each stage's model prices. */
  usd(): number {
    return this.segments.reduce((sum, segment) => sum + dollars(segment), 0);
  }

  exceeded(): string | undefined {
    if (this.spend.toolCalls > this.limits.maxToolCalls) return `the investigation used more than ${this.limits.maxToolCalls} tool calls`;
    if (this.spend.tokensIn + this.spend.tokensOut > this.limits.maxTokens) return `the investigation used more than ${this.limits.maxTokens} tokens`;
    if (this.minutes() > this.limits.maxMinutes) return `the investigation took longer than ${this.limits.maxMinutes} minutes`;
    const maxUsd = this.limits.maxUsd ?? 0;
    if (maxUsd > 0 && this.usd() > maxUsd) return `the investigation cost more than ${maxUsd} USD`;
    return undefined;
  }

  /**
   * What the run cost, for the hub: the run's tokens and dollars, the models, and one entry
   * per stage and model (`stages`), which TBO Support logs as one usage row each.
   */
  cost(): Record<string, unknown> {
    const used = this.segments.filter((segment) => segment.tokensIn || segment.tokensOut);
    return {
      tokens_in: this.spend.tokensIn,
      tokens_cached: this.spend.tokensCached,
      tokens_out: this.spend.tokensOut,
      tokens: this.spend.tokensIn + this.spend.tokensOut,
      usd: Math.round(this.usd() * 10_000) / 10_000,
      model: [...new Set((used.length ? used : this.segments.slice(0, 1)).map((segment) => segment.modelId))].join(", "),
      stages: used.map((segment) => ({
        job: segment.job,
        model: segment.modelId,
        ...(segment.section ? { section: segment.section } : {}),
        fallback: Boolean(segment.fallback),
        tokens_in: segment.tokensIn,
        tokens_cached: segment.tokensCached,
        tokens_out: segment.tokensOut,
        usd: Math.round(dollars(segment) * 1_000_000) / 1_000_000,
      })),
    };
  }
}
