import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Sandbox, SandboxResult, SandboxSpec } from "../sandbox.js";

/**
 * A sandbox runner that judges the code it is given: `check` passes when the
 * mounted app's invoice.py computes the margin as a share of the selling price.
 * `alwaysPasses` plays a test that never showed the bug.
 */
export class FakeSandbox implements Sandbox {
  readonly started: SandboxSpec[] = [];
  readonly stopped: string[] = [];
  readonly calls: string[] = [];
  alwaysPasses = false;
  private mount = "";

  async start(spec: SandboxSpec): Promise<{ id: string; tested_on: string }> {
    this.started.push(spec);
    this.mount = spec.mount.dir;
    return { id: `sbx-${this.started.length}`, tested_on: "a fake sandbox site" };
  }

  private run(ok: boolean, output: string): SandboxResult {
    return { ok, exit_code: ok ? 0 : 1, output, ms: 120 };
  }

  async check(_id: string, _app: string, module: string): Promise<SandboxResult> {
    this.calls.push(`check ${module}`);
    const code = readFileSync(join(this.mount, "demo_app", "invoice.py"), "utf8");
    const fixed = this.alwaysPasses || code.includes("(doc.selling - doc.buying) / doc.selling");
    return this.run(fixed, fixed ? "Ran 1 test\nOK" : "AssertionError: 1.25 != 0.2\nFAILED (failures=1)");
  }

  async migrate(): Promise<SandboxResult> {
    this.calls.push("migrate");
    return this.run(true, "Migrating sandbox.localhost\nDone");
  }

  async tests(): Promise<SandboxResult> {
    this.calls.push("tests");
    return { ...this.run(true, "the app has no tests"), skipped: true };
  }

  async errorsSince(): Promise<string[]> {
    return [];
  }

  async stop(id: string): Promise<void> {
    this.stopped.push(id);
  }
}
