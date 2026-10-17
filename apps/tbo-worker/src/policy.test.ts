import { describe, expect, it } from "vitest";

import { EventOutbox, boundPayload } from "./events.js";
import { INPUT_ANSWER, PERMISSION_DECISION, RunBudget, answersFor } from "./policy.js";

describe("the read-only policy", () => {
  it("refuses every permission prompt and answers every question itself", () => {
    expect(PERMISSION_DECISION).toBe("deny");
    const answers = answersFor({ questions: [{ question: "Which invoice?", options: [] }, { question: "Proceed?", options: [] }] });
    expect(answers).toEqual([[INPUT_ANSWER], [INPUT_ANSWER]]);
  });
});

describe("RunBudget", () => {
  const limits = { maxToolCalls: 2, maxMinutes: 10, maxTokens: 5_000 };

  it("counts each model request once and names the first limit passed", () => {
    let now = 0;
    const budget = new RunBudget(limits, () => now);
    budget.usage({ inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, operationId: "op1" });
    budget.usage({ inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, operationId: "op1" });
    expect(budget.spend).toMatchObject({ tokensIn: 1_000, tokensOut: 100 });
    budget.toolCall();
    budget.toolCall();
    expect(budget.exceeded()).toBeUndefined();
    budget.toolCall();
    expect(budget.exceeded()).toContain("more than 2 tool calls");

    const slow = new RunBudget(limits, () => now);
    now = 11 * 60_000;
    expect(slow.exceeded()).toContain("longer than 10 minutes");
  });

  it("prices cached input at its own rate", () => {
    const budget = new RunBudget(limits, Date.now, { job: "investigate", modelId: "kimi-k2.6", priceInPerMillion: 0.6, priceCachedPerMillion: 0.15, priceOutPerMillion: 2.5 });
    budget.usage({ inputTokens: 1_000_000, cacheReadTokens: 4_000_000, outputTokens: 100_000, totalTokens: 5_100_000 });
    expect(budget.cost()).toMatchObject({ tokens_in: 5_000_000, tokens_cached: 4_000_000, tokens_out: 100_000, usd: 1.45 });
  });

  it("stops at a dollar limit when prices are known", () => {
    const prices = { job: "investigate", modelId: "kimi-k2.6", priceInPerMillion: 1, priceOutPerMillion: 4 };
    const budget = new RunBudget({ ...limits, maxTokens: 10_000_000, maxUsd: 0.5 }, Date.now, prices);
    budget.usage({ inputTokens: 300_000, outputTokens: 50_000, totalTokens: 350_000 });
    expect(budget.exceeded()).toBeUndefined();
    budget.usage({ inputTokens: 200_000, outputTokens: 10_000, totalTokens: 210_000 });
    expect(budget.exceeded()).toBe("the investigation cost more than 0.5 USD");
    const unpriced = new RunBudget({ ...limits, maxTokens: 10_000_000, maxUsd: 0.5 });
    unpriced.usage({ inputTokens: 9_000_000, outputTokens: 0, totalTokens: 9_000_000 });
    expect(unpriced.exceeded()).toBeUndefined();
  });

  it("prices the run with the configured rates", () => {
    const budget = new RunBudget(limits, Date.now, { job: "investigate", section: "OpenAI", modelId: "gpt-5.6-luna", priceInPerMillion: 0.6, priceOutPerMillion: 2.5 });
    budget.usage({ inputTokens: 2_000_000, outputTokens: 1_000_000, totalTokens: 3_000_000 });
    expect(budget.cost()).toEqual({
      tokens_in: 2_000_000,
      tokens_cached: 0,
      tokens_out: 1_000_000,
      tokens: 3_000_000,
      usd: 3.7,
      model: "gpt-5.6-luna",
      stages: [{ job: "investigate", model: "gpt-5.6-luna", section: "OpenAI", fallback: false, tokens_in: 2_000_000, tokens_cached: 0, tokens_out: 1_000_000, usd: 3.7 }],
    });
    expect(budget.exceeded()).toContain("tokens");
  });

  it("counts the input a provider reports as written to its cache as fresh input", () => {
    const budget = new RunBudget(limits, Date.now, { job: "investigate", modelId: "gpt-5.6-luna", priceInPerMillion: 0.2, priceCachedPerMillion: 0.02, priceOutPerMillion: 1.2 });
    // the Responses API's first request: nearly all of its input is written to the cache
    budget.usage({ inputTokens: 3, cacheWriteTokens: 9_997, cacheReadTokens: 0, outputTokens: 100, totalTokens: 10_100 });
    budget.usage({ inputTokens: 3, cacheWriteTokens: 997, cacheReadTokens: 10_000, outputTokens: 100, totalTokens: 11_100 });
    expect(budget.cost()).toMatchObject({ tokens_in: 21_000, tokens_cached: 10_000, tokens_out: 200 });
    const [stage] = (budget.cost() as { stages: Array<{ usd: number }> }).stages;
    expect(stage!.usd).toBeCloseTo((11_000 * 0.2 + 10_000 * 0.02 + 200 * 1.2) / 1_000_000, 6);
  });

  it("counts each stage and model apart, so a switch to the fallback keeps the cost right", () => {
    const luna = { modelId: "gpt-5.6-luna", section: "OpenAI", priceInPerMillion: 1, priceOutPerMillion: 2 };
    const kimi = { modelId: "kimi-k2.6", section: "Anthropic-compatible", priceInPerMillion: 0.5, priceCachedPerMillion: 0.1, priceOutPerMillion: 4 };
    const budget = new RunBudget({ ...limits, maxTokens: 100_000_000, maxUsd: 10 }, Date.now, { ...luna, job: "fix" });
    budget.usage({ inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
    budget.use({ ...kimi, job: "fix", fallback: true });
    budget.usage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 3_000_000 });
    budget.use({ ...kimi, job: "review", fallback: true });
    budget.usage({ inputTokens: 0, outputTokens: 500_000, totalTokens: 500_000 });
    budget.use({ ...kimi, job: "fix", fallback: true }); // the next round adds to the same share
    budget.usage({ inputTokens: 0, outputTokens: 250_000, totalTokens: 250_000 });
    const cost = budget.cost() as { usd: number; model: string; stages: Array<Record<string, unknown>> };
    expect(cost.stages.map((stage) => [stage.job, stage.model, stage.fallback, stage.usd])).toEqual([
      ["fix", "gpt-5.6-luna", false, 1],
      ["fix", "kimi-k2.6", true, 5.6],
      ["review", "kimi-k2.6", true, 2],
    ]);
    expect(cost.usd).toBe(8.6);
    expect(cost.model).toBe("gpt-5.6-luna, kimi-k2.6");
    budget.usage({ inputTokens: 0, outputTokens: 400_000, totalTokens: 400_000 });
    expect(budget.exceeded()).toBe("the investigation cost more than 10 USD");
  });
});

describe("EventOutbox", () => {
  it("numbers events, sends them in batches and keeps them when sending fails", async () => {
    const sent: number[][] = [];
    let fail = true;
    const outbox = new EventOutbox(
      async (events) => {
        if (fail) throw new Error("hub down");
        sent.push(events.map((event) => event.seq));
        return events.map((event) => event.seq);
      },
      { log: () => undefined, flushMs: 60_000, maxBatch: 2 },
    );
    outbox.push("tool_call", { tool: "Read" });
    await outbox.flush();
    expect(sent).toEqual([]);
    fail = false;
    outbox.push("tool_call", { tool: "Grep" });
    outbox.push("tool_call", { tool: "Glob" });
    await outbox.flush();
    expect(sent.flat()).toEqual([1, 2, 3]);
    outbox.close();
    outbox.push("late", {});
    await outbox.flush();
    expect(sent.flat()).toEqual([1, 2, 3]);
  });

  it("keeps payloads under the hub's limit", () => {
    const bounded = boundPayload({ text: "x".repeat(5_000), list: Array.from({ length: 80 }, (_, i) => i) });
    expect(String(bounded.text).length).toBeLessThanOrEqual(2_001);
    expect((bounded.list as number[]).length).toBe(50);
    expect(JSON.stringify(boundPayload({ a: "y".repeat(1_900), b: "y".repeat(1_900), c: "y".repeat(1_900), d: "y".repeat(1_900), e: "y".repeat(1_900) }))).toContain('"cut":true');
  });
});
