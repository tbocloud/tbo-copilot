import { describe, expect, it } from "vitest";

import type { WorkerConfig } from "./config.js";
import { filesNamed, reportMarkdown, runEvaluation, score, type EvalCase, type EvalResult } from "./evaluate.js";
import type { HubClient } from "./hub.js";
import type { Worker } from "./supervisor.js";

const bug: EvalCase = {
  id: "A6",
  ticket: "0001",
  kind: "bug",
  app: "billing_app",
  repository: "acme/billing-app",
  base_commit: "abc1234",
  expected_root_cause: "bug",
  fix_files: ["billing_app/doc_events/sales_invoice.py", "billing_app/hooks.py"],
};

describe("scoring", () => {
  it("finds the fix's files by path, by the path below the app, or by name", () => {
    expect(filesNamed(bug.fix_files, "see doc_events/sales_invoice.py:40")).toEqual(["billing_app/doc_events/sales_invoice.py"]);
    expect(filesNamed(bug.fix_files, "hooks.py registers it")).toEqual(["billing_app/hooks.py"]);
    expect(filesNamed(bug.fix_files, "nothing here")).toEqual([]);
  });

  it("scores a bug on its root cause and a customization on not calling it a defect", () => {
    expect(score(bug, { run: "r", root_cause: "bug", summary: "", evidence: [{ ref: "billing_app/doc_events/sales_invoice.py:12" }] })).toEqual({
      right: true,
      filesFound: ["billing_app/doc_events/sales_invoice.py"],
    });
    expect(score(bug, { run: "r", root_cause: "customer_mistake" }).right).toBe(false);
    const either: EvalCase = { ...bug, accepted_root_causes: ["bug", "data_damaged_by_bug"] };
    expect(score(either, { run: "r", root_cause: "data_damaged_by_bug" }).right).toBe(true);
    const custom: EvalCase = { ...bug, id: "B1", kind: "customization", expected_root_cause: undefined, fix_files: [] };
    expect(score(custom, { run: "r", root_cause: "question" }).right).toBe(true);
    expect(score(custom, { run: "r", root_cause: "bug" }).right).toBe(false);
    expect(score(custom, { run: "r", root_cause: null }).right).toBe(false);
  });
});

describe("runEvaluation", () => {
  it("stops after a case the worker was stopped in", async () => {
    const calls: string[] = [];
    const hub = {
      getRun: async (ticket: string) => ({ run: null, ticket }),
      cancelRun: async () => ({ run: null }),
      startRun: async (ticket: string) => {
        calls.push(ticket);
        return { run: `RUN-${ticket}`, state: "Queued" };
      },
    } as unknown as HubClient;
    const worker = { runOnce: async () => ({ outcome: "stopped" }) } as unknown as Pick<Worker, "runOnce">;
    const cfg = { repoMap: {} } as unknown as WorkerConfig;
    const results = await runEvaluation([bug, { ...bug, id: "A7", ticket: "0002" }], { cfg, hub, worker, log: () => undefined });
    expect(calls).toEqual(["0001"]);
    expect(results.map((r) => r.outcome)).toEqual(["stopped"]);
  });
});

describe("reportMarkdown", () => {
  it("puts the totals first and one row per case", () => {
    const result: EvalResult = {
      case: bug,
      run: "CPR-1",
      outcome: "submitted",
      rootCause: "bug",
      confidence: 0.8,
      right: true,
      filesFound: ["billing_app/hooks.py"],
      summary: "The margin | formula divides by the buying price.",
      toolCalls: 12,
      tokens: 40_000,
      costUsd: 0.05,
      minutes: 3.5,
    };
    const markdown = reportMarkdown([result], { model: "kimi-k2.6", date: "2026-10-09 12:00" });
    expect(markdown).toContain("| Bugs: root cause right | 1 of 1 |");
    expect(markdown).toContain("| Fix files named (all cases) | 1 of 2 |");
    expect(markdown).toContain("| A6 | 0001 | bug | bug | 0.8 | yes | 1 of 2 | 12 | 40000 | 3.5 | submitted |");
    expect(markdown).toContain("The margin / formula");
  });
});
