import type { AskToolRequest, MessageUsage } from "@pi-desktop/shared";

import type { Limits, ModelConfig } from "./config.js";

/**
 * The read-only rule, as the worker enforces it on top of host-core: every
 * permission prompt is refused. In `ask` mode host-core prompts for Bash,
 * Write, Edit, unknown tools and any path outside the run's folder, so all of
 * those end here; Read, Glob and Grep inside the folder never prompt.
 */
export const PERMISSION_DECISION = "deny" as const;

export const INPUT_ANSWER =
  "No person is available during this investigation. Take the safest assumption, say so in your evidence, and continue.";

/** One answer per question, as the runtime expects them. */
export function answersFor(request: Pick<AskToolRequest, "questions">): string[][] {
  return request.questions.map(() => [INPUT_ANSWER]);
}

export type Spend = { toolCalls: number; tokensIn: number; tokensOut: number; startedAt: number };

/**
 * Tool calls, tokens and time for one run. `exceeded()` names the first limit
 * passed, so the turn can be stopped and the run failed with that reason.
 */
export class RunBudget {
  readonly spend: Spend;
  private readonly seenOperations = new Set<string>();

  constructor(
    private readonly limits: Pick<Limits, "maxToolCalls" | "maxMinutes" | "maxTokens">,
    private readonly now: () => number = Date.now,
  ) {
    this.spend = { toolCalls: 0, tokensIn: 0, tokensOut: 0, startedAt: now() };
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
    this.spend.tokensIn += Math.max(0, usage.inputTokens || 0) + Math.max(0, usage.cacheReadTokens || 0);
    this.spend.tokensOut += Math.max(0, usage.outputTokens || 0);
  }

  minutes(): number {
    return (this.now() - this.spend.startedAt) / 60_000;
  }

  exceeded(): string | undefined {
    if (this.spend.toolCalls > this.limits.maxToolCalls) return `the investigation used more than ${this.limits.maxToolCalls} tool calls`;
    if (this.spend.tokensIn + this.spend.tokensOut > this.limits.maxTokens) return `the investigation used more than ${this.limits.maxTokens} tokens`;
    if (this.minutes() > this.limits.maxMinutes) return `the investigation took longer than ${this.limits.maxMinutes} minutes`;
    return undefined;
  }

  /** What the run cost, for the hub: tokens, dollars at the configured prices, and the model. */
  cost(model: Pick<ModelConfig, "modelId" | "priceInPerMillion" | "priceOutPerMillion">): Record<string, unknown> {
    const usd = (this.spend.tokensIn * model.priceInPerMillion + this.spend.tokensOut * model.priceOutPerMillion) / 1_000_000;
    return {
      tokens_in: this.spend.tokensIn,
      tokens_out: this.spend.tokensOut,
      tokens: this.spend.tokensIn + this.spend.tokensOut,
      usd: Math.round(usd * 10_000) / 10_000,
      model: model.modelId,
    };
  }
}
