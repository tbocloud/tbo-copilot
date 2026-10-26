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
