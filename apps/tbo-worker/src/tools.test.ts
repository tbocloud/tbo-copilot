import { describe, expect, it, vi } from "vitest";

import { HubError, type HubClient } from "./hub.js";
import { RUN_TOOL_NAMES, TOOL_DEFINITIONS, TOOL_SEARCH_QUERY, checkReport, runTool, type RunTools } from "./tools.js";

function fakeHub(reply: (name: string, args: Record<string, unknown>) => { text: string; isError: boolean } | Error) {
  const calls: Array<{ name: string; args: Record<string, unknown>; token: string }> = [];
  const hub = {
    callTool: vi.fn(async (token: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args, token });
      const value = reply(name, args);
      if (value instanceof Error) throw value;
      return value;
    }),
  } as unknown as HubClient;
  return { hub, calls };
}

function runTools(overrides: Partial<RunTools> = {}): RunTools & { state: { submitted: string | null } } {
  const state = { submitted: null as string | null };
  return {
    state,
    runToken: "CPR-1:token",
    apps: {},
    homeDir: "/tmp",
    cost: () => ({ tokens_in: 1200, tokens_out: 300, usd: 0.01, model: "kimi-k2.6" }),
    beforeSubmit: vi.fn(async () => undefined),
    submitted: (text) => {
      state.submitted = text;
    },
    isSubmitted: () => state.submitted !== null,
    ...overrides,
  };
}

const report = { root_cause_category: "bug", confidence: 0.8, summary: "The hook divides by the buying price.", evidence: [{ type: "code", ref: "demo_app/invoice.py:2" }] };

describe("the run's tools", () => {
  it("are four, all found by one ToolSearch query", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...RUN_TOOL_NAMES]);
    expect(TOOL_SEARCH_QUERY.split(" ")).toHaveLength(4);
  });

  it("submit the report with the measured cost, after the events", async () => {
    const { hub, calls } = fakeHub(() => ({ text: "Run CPR-1 is now Preparing Fix.", isError: false }));
    const tools = runTools();

    const result = await runTool(hub, tools, "hub_submit_investigation", { ...report, cost: { usd: 999 } });

    expect(result.ok).toBe(true);
    expect(tools.beforeSubmit).toHaveBeenCalledOnce();
    expect(calls[0]).toMatchObject({ name: "submit_investigation", token: "CPR-1:token" });
    expect(calls[0]!.args.cost).toEqual({ tokens_in: 1200, tokens_out: 300, usd: 0.01, model: "kimi-k2.6" });
    expect(tools.state.submitted).toContain("Preparing Fix");
    expect((await runTool(hub, tools, "hub_submit_investigation", report)).content).toContain("Already submitted");
    expect(calls).toHaveLength(1);
  });

  it("tell the model what to fix in a report before sending it", async () => {
    const { hub, calls } = fakeHub(() => ({ text: "", isError: false }));
    const result = await runTool(hub, runTools(), "hub_submit_investigation", { ...report, root_cause_category: "maybe" });
    expect(result).toMatchObject({ ok: false, isError: true });
    expect(String(result.content)).toContain("root_cause_category must be one of");
    expect(calls).toHaveLength(0);
  });

  it("pass on the hub's refusal of a report", async () => {
    const { hub } = fakeHub(() => ({ text: "Unknown root cause category", isError: true }));
    const tools = runTools();
    const result = await runTool(hub, tools, "hub_submit_investigation", report);
    expect(result.ok).toBe(false);
    expect(tools.state.submitted).toBeNull();
  });

  it("read the customer's ERP only with an allow-listed read tool", async () => {
    const { hub, calls } = fakeHub(() => ({ text: "3 errors", isError: false }));
    expect((await runTool(hub, runTools(), "hub_customer_erp_read", { tool: "set_value" })).ok).toBe(false);
    const read = await runTool(hub, runTools(), "hub_customer_erp_read", { tool: "get_error_log", arguments: { limit: 3 } });
    expect(read).toEqual({ ok: true, content: "3 errors" });
    expect(calls).toEqual([{ name: "customer_erp_read", args: { tool: "get_error_log", arguments: { limit: 3 } }, token: "CPR-1:token" }]);
  });

  it("say plainly when the lease has ended", async () => {
    const { hub } = fakeHub(() => new HubError("The run token is not valid", 401));
    const result = await runTool(hub, runTools(), "hub_get_run_context", {});
    expect(String(result.content)).toContain("lease has ended");
  });
});

describe("checkReport", () => {
  it.each([
    [{ ...report, confidence: 1.5 }, "confidence"],
    [{ ...report, summary: " " }, "summary"],
    [{ ...report, evidence: "file.py" }, "evidence"],
  ])("refuses %j", (args, word) => expect(checkReport(args)).toContain(word));

  it("accepts a complete report", () => expect(checkReport(report)).toBeUndefined());

  it("needs a kind message for a customization request; its hours are optional but must be hours", () => {
    const request = { ...report, root_cause_category: "customization_request", customer_message: "This is a change, not a fault." };
    expect(checkReport({ ...request, customer_message: " " })).toContain("customer_message");
    expect(checkReport({ ...request, proposal: { estimate_hours: "four" } })).toContain("estimate_hours");
    expect(checkReport({ ...request, proposal: { estimate_hours: -2 } })).toContain("estimate_hours");
    expect(checkReport({ ...request, proposal: { estimate_hours: 4 } })).toBeUndefined();
    expect(checkReport({ ...request, proposal: {} })).toBeUndefined();
  });
});
