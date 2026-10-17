import { describe, expect, it } from "vitest";

import type { ModelConfig, ProviderConfig } from "./config.js";
import type { TurnResult } from "./engine.js";
import { StageModels, shouldFallBack, stageModels } from "./models.js";

const openai: ProviderConfig = {
  section: "OpenAI",
  providerName: "TBO Worker · OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-o",
  apiStyle: "responses",
  contextWindow: 256_000,
  maxOutputTokens: 16_000,
};
const moonshot: ProviderConfig = { ...openai, section: "Anthropic-compatible", providerName: "TBO Worker · Moonshot", baseUrl: "https://api.moonshot.ai/v1", apiKey: "sk-m", apiStyle: "chat_completions" };
const older: ModelConfig = { ...openai, providerName: "TBO Worker model", modelId: "gpt-5.6-luna", priceInPerMillion: 0.2, priceOutPerMillion: 1 };

const listed = {
  investigate: [
    { section: "OpenAI", model: "gpt-5.6-luna", price_in: 0.25, price_out: 2, price_cached: 0.025 },
    { section: "Anthropic-compatible", model: "kimi-k2.6", price_in: 0.6, price_out: 2.5, price_cached: 0 },
  ],
  review: [{ section: "Gemini", model: "gemini-9" }, { section: "Anthropic-compatible", model: "kimi-k2.7" }],
};

const failed = (errorCode: string, extra: Partial<TurnResult> = {}): TurnResult => ({ reason: "error", errorCode, text: "", ...extra });

describe("stageModels", () => {
  it("takes TBO Support's order and prices, with the worker's own address and key", () => {
    const plans = stageModels({ providers: [openai, moonshot] }, "investigate", { models: listed });
    expect(plans.map((plan) => [plan.section, plan.modelId, plan.baseUrl, plan.apiKey, plan.fallback])).toEqual([
      ["OpenAI", "gpt-5.6-luna", "https://api.openai.com/v1", "sk-o", false],
      ["Anthropic-compatible", "kimi-k2.6", "https://api.moonshot.ai/v1", "sk-m", true],
    ]);
    expect(plans[0]).toMatchObject({ job: "investigate", priceInPerMillion: 0.25, priceOutPerMillion: 2, priceCachedPerMillion: 0.025 });
    // an unpriced cache read is left out, so it costs the input price
    expect(plans[1]!.priceCachedPerMillion).toBeUndefined();
  });

  it("never uses a section the worker has no key for", () => {
    expect(stageModels({ providers: [openai] }, "investigate", { models: listed }).map((plan) => plan.modelId)).toEqual(["gpt-5.6-luna"]);
    // an unknown section is skipped, not sent to another provider's address
    expect(stageModels({ providers: [openai, moonshot] }, "review", { models: listed }).map((plan) => [plan.section, plan.modelId, plan.fallback])).toEqual([
      ["Anthropic-compatible", "kimi-k2.7", false],
    ]);
  });

  it("falls back to the older single model, or to nothing", () => {
    expect(stageModels({ providers: [], model: older }, "fix", { models: listed })).toMatchObject([{ modelId: "gpt-5.6-luna", job: "fix", section: "", fallback: false }]);
    expect(stageModels({ providers: [openai], model: older }, "fix", {})).toMatchObject([{ providerName: "TBO Worker model" }]);
    expect(stageModels({ providers: [openai] }, "fix", {})).toEqual([]);
  });
});

describe("shouldFallBack", () => {
  it("moves on a key, billing, wrong-model, server, network or timeout failure", () => {
    for (const code of ["PROVIDER_UNAUTHORIZED", "PROVIDER_RATE_LIMITED", "MODEL_NOT_CONFIGURED", "TIMEOUT", "NETWORK_ERROR", "STREAM_FAILED"]) {
      expect(shouldFallBack(failed(code)), code).toBe(true);
    }
    expect(shouldFallBack(failed("PROVIDER_ERROR", { providerStatus: 503, retriable: true }))).toBe(true);
    expect(shouldFallBack(failed("PROVIDER_ERROR", { providerStatus: 402 }))).toBe(true);
  });

  it("never on a request refused as invalid, or on what is not the provider's failure", () => {
    expect(shouldFallBack(failed("PROVIDER_ERROR", { providerStatus: 400, retriable: false }))).toBe(false);
    expect(shouldFallBack(failed("PROVIDER_ERROR", { providerStatus: 422 }))).toBe(false);
    expect(shouldFallBack(failed("PROVIDER_ERROR", { retriable: false }))).toBe(false);
    for (const code of ["CONTEXT_TOO_LARGE", "TURN_ABORTED", "INTERNAL", "PROMPT_FAILED"]) expect(shouldFallBack(failed(code)), code).toBe(false);
    expect(shouldFallBack({ reason: "aborted", text: "" })).toBe(false);
    expect(shouldFallBack({ reason: "completed", text: "done" })).toBe(false);
  });
});

describe("StageModels", () => {
  it("moves to the fallback once, and stays there", () => {
    const stage = new StageModels("investigate", stageModels({ providers: [openai, moonshot] }, "investigate", { models: listed }));
    expect(stage.next(failed("PROVIDER_ERROR", { providerStatus: 400 }))).toBeUndefined();
    expect(stage.current?.modelId).toBe("gpt-5.6-luna");
    expect(stage.next(failed("PROVIDER_UNAUTHORIZED"))?.modelId).toBe("kimi-k2.6");
    expect(stage.current?.modelId).toBe("kimi-k2.6");
    expect(stage.next(failed("PROVIDER_UNAUTHORIZED"))).toBeUndefined();
    expect(stage.current?.modelId).toBe("kimi-k2.6");
  });

  it("has no fallback with one model", () => {
    const stage = new StageModels("fix", stageModels({ providers: [openai] }, "fix", { models: { fix: [listed.investigate[0]!] } }));
    expect(stage.next(failed("TIMEOUT"))).toBeUndefined();
    expect(stage.current?.modelId).toBe("gpt-5.6-luna");
  });
});
