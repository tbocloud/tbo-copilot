import { describe, expect, it } from "vitest";

import { CANNOT_FIX_CHARS, runFixTool, type FixToolState } from "./fix-tools.js";
import { FakeSandbox } from "./test-support/fake-sandbox.js";

function state(): FixToolState {
  return { app: "demo_app", dir: "/tmp/none", homeDir: "/tmp/none", apps: {}, sandbox: new FakeSandbox(), sandboxId: "sbx-1", checks: [] };
}

describe("fix_done with cannot_fix", () => {
  it("records a stop with the explanation, which needs no test module", async () => {
    const s = state();
    const reply = await runFixTool(s, "fix_done", { summary: "", test_module: "", explanation: "No test fails on the unchanged code.", cannot_fix: true });

    expect(reply.ok).toBe(true);
    expect(s.done).toMatchObject({ cannot_fix: true, explanation: "No test fails on the unchanged code.", test_module: "" });
  });

  it("refuses an explanation longer than the developer would get whole, and keeps nothing", async () => {
    const s = state();
    const reply = await runFixTool(s, "fix_done", { explanation: "x".repeat(CANNOT_FIX_CHARS + 1), cannot_fix: true });

    expect(reply.ok).toBe(false);
    expect(String(reply.ok ? "" : reply.content)).toContain(`within ${CANNOT_FIX_CHARS} characters`);
    expect(s.done).toBeUndefined();
  });

  it("fits whole within TBO Support's 1,000 characters with both prefixes", () => {
    const longest = `Copilot could not fix it: it stopped by itself and explains: ${"x".repeat(CANNOT_FIX_CHARS)}`;
    expect(longest.length - "Copilot could not fix it: ".length).toBeLessThanOrEqual(1000);
  });

  it("refuses a stop without an explanation", async () => {
    const s = state();
    const reply = await runFixTool(s, "fix_done", { explanation: " ", cannot_fix: true });

    expect(reply.ok).toBe(false);
    expect(s.done).toBeUndefined();
  });
});

describe("fix_done for a build covers every Done-when check", () => {
  const build = {
    scope: "A Sales Invoice cannot be submitted without a Sales Team row.",
    checks: ["an invoice without a Sales Team row is refused", "a credit note without one is not", "submitting tells the user what to add"],
  };
  const done = (check_results: unknown) => ({
    summary: "require a Sales Team row",
    test_module: "demo_app.tests.test_copilot_sales_team",
    explanation: "A validate hook refuses the submit.",
    check_results,
  });
  const built = () => ({ ...state(), build });

  it("records each check with its test module, or why it cannot be tested", async () => {
    const s = built();
    const reply = await runFixTool(
      s,
      "fix_done",
      done([
        { check: "An invoice without a Sales Team row is refused ", test_module: "demo_app.tests.test_copilot_sales_team" },
        { check: "a credit note without one is not", test_module: "demo_app.tests.test_copilot_sales_team" },
        { check: "submitting tells the user what to add", not_testable: "the message is only shown in the browser" },
      ]),
    );

    expect(reply.ok).toBe(true);
    expect(s.done?.check_results).toEqual([
      { check: build.checks[0], test_module: "demo_app.tests.test_copilot_sales_team" },
      { check: build.checks[1], test_module: "demo_app.tests.test_copilot_sales_team" },
      { check: build.checks[2], test_module: "", not_testable: "the message is only shown in the browser" },
    ]);
  });

  it.each([
    [[{ check: "an invoice without a Sales Team row is refused", test_module: "demo_app.tests.t" }], "no row for"],
    [
      [
        ...build.checks.map((check) => ({ check, test_module: "demo_app.tests.t" })),
        { check: "POS invoices are refused too", test_module: "demo_app.tests.t" },
      ],
      "not a Done-when check",
    ],
    [build.checks.map((check) => ({ check, test_module: "other_app.tests.t" })), "needs test_module"],
    [build.checks.map((check) => ({ check, not_testable: "manual" })), "at least one check needs a test"],
  ])("refuses %j", async (rows, word) => {
    const s = built();
    const reply = await runFixTool(s, "fix_done", done(rows));

    expect(reply.ok).toBe(false);
    expect(String(reply.ok ? "" : reply.content)).toContain(word);
    expect(s.done).toBeUndefined();
  });

  it("leaves a fix without check results", async () => {
    const s = state();
    expect((await runFixTool(s, "fix_done", done(undefined))).ok).toBe(true);
    expect(s.done?.check_results).toBeUndefined();
  });
});
