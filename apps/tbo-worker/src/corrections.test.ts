import { describe, expect, it } from "vitest";

import type { RunContext } from "./hub.js";
import { RULES, turnPrompt } from "./prompt.js";
import { MAX_CHANGE_RECORDS, TOOL_DEFINITIONS, checkChangeSet, checkReport } from "./tools.js";
import type { Workspace } from "./workspace.js";

const report = { root_cause_category: "wrong_setting", confidence: 0.9, summary: "The default price list is wrong.", evidence: [] };
const setting = { doctype: "Selling Settings", name: "Selling Settings", values: { selling_price_list: "Standard Selling" } };

describe("a correction in the report (Phase 3)", () => {
  it("is offered to the model as part of hub_submit_investigation", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "hub_submit_investigation")!;
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toContain("change_set");
  });

  it("accepts records to update or create, with rows, and records set aside", () => {
    const changes = [
      setting,
      { action: "create", doctype: "Item Price", values: { item_code: "ITEM-1", price_list_rate: 15 } },
      { doctype: "Mode of Payment", name: "Cash", values: {}, add_rows: [{ table: "accounts", values: { company: "Acme", default_account: "Cash - A" } }] },
    ];
    expect(checkReport({ ...report, change_set: { changes, set_aside: [{ doctype: "Sales Invoice", name: "SINV-1", why: "submitted" }] } })).toBeUndefined();
  });

  it.each([
    [{ changes: [{ ...setting, action: "delete" }] }, "never delete"],
    [{ changes: [{ doctype: "User", name: "a@example.com", values: { enabled: 0 } }] }, "never changes User"],
    [{ changes: [{ doctype: "Item Price", values: { price_list_rate: 1 } }] }, "name the record"],
    [{ changes: [{ doctype: "Item Price", name: "IP-1", values: {} }] }, "must change something"],
    [{ changes: [{ doctype: "Item Price", name: "IP-1", values: "15" }] }, "values must be an object"],
    [{ changes: Array.from({ length: MAX_CHANGE_RECORDS + 1 }, (_, i) => ({ doctype: "Item Price", name: `IP-${i}`, values: { price_list_rate: 1 } })) }, "data patch"],
    ["fix it", "must be an object"],
    [{}, "at least one record"],
    [{ changes: [], set_aside: [] }, "at least one record"],
  ])("refuses what the hub would refuse: %#", (changeSet, words) => {
    expect(checkChangeSet(changeSet)).toContain(words);
  });

  it("is optional", () => expect(checkReport(report)).toBeUndefined());

  it("goes only with the causes a correction belongs to", () => {
    const changeSet = { changes: [setting] };
    expect(checkReport({ ...report, root_cause_category: "bug", change_set: changeSet })).toContain("leave it out for bug");
    expect(checkReport({ ...report, root_cause_category: "question", change_set: changeSet })).toContain("leave it out");
    expect(checkReport({ ...report, root_cause_category: "data_damaged_by_bug", change_set: changeSet })).toBeUndefined();
  });

  it("corrects a customer's mistake only when an agent asked for it", () => {
    const mistake = { ...report, root_cause_category: "customer_mistake", change_set: { changes: [setting] } };
    expect(checkReport(mistake)).toContain("unless an agent asked");
    expect(checkReport(mistake, true)).toBeUndefined();
  });

  it("names each record it leaves to a person, at most 200", () => {
    expect(checkChangeSet({ changes: [], set_aside: [{ doctype: "Sales Invoice", why: "submitted" }] })).toContain("name its doctype and record");
    const many = Array.from({ length: 201 }, (_, i) => ({ doctype: "Sales Invoice", name: `SINV-${i}` }));
    expect(checkChangeSet({ changes: [], set_aside: many })).toContain("at most 200");
  });
});

describe("the instructions", () => {
  const workspace = { apps: [], problems: [] } as unknown as Workspace;
  const context = { run: "R-1", kind: "followup", ticket: { name: "0001" } } as RunContext;

  it("say how to prepare a correction, and what never to touch", () => {
    expect(RULES).toContain("## Corrections");
    expect(RULES).toContain("Never delete anything");
    expect(RULES).toContain("set_aside");
    expect(RULES).toContain("At most 200 there");
  });

  it("tell the model when an agent asked for the correction of the customer's mistake", () => {
    expect(turnPrompt({ ...context, prepare_correction: true }, workspace)).toContain("report customer_mistake with a change_set");
    expect(turnPrompt({ ...context, prepare_correction: true }, workspace)).toContain("if it shows another cause, report that cause");
    expect(turnPrompt(context, workspace)).not.toContain("change_set");
  });

  it("point at the ticket's earlier corrections, so only what they missed is prepared", () => {
    const prompt = turnPrompt({ ...context, corrections: [{ change_set: "TBO-CHG-2026-00001", status: "Applied" }] }, workspace);
    expect(prompt).toContain("TBO-CHG-2026-00001: Applied");
    expect(prompt).toContain("only the records they missed");
  });
});
