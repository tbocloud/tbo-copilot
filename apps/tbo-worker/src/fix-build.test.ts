import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { changedSources, usableBuild, verifyBuild } from "./fix.js";
import type { FixToolState } from "./fix-tools.js";
import { FakeSandbox } from "./test-support/fake-sandbox.js";
import { makeFixtureRepo } from "./test-support/git-fixture.js";
import { removeWorkspace } from "./workspace.js";

describe("usableBuild: the scope TBO Support sent", () => {
  it("is none for a fix, the scope when usable, and a reason otherwise", () => {
    const build = { scope: "Require a Sales Team row.", checks: ["an invoice without one is refused"] };
    expect(usableBuild(undefined)).toBeUndefined();
    expect(usableBuild(null)).toBeUndefined();
    expect(usableBuild(build)).toBe(build);
    for (const broken of [{ ...build, checks: [] }, { ...build, checks: "an invoice" }, { ...build, checks: [" "] }, { ...build, scope: 4 }, { ...build, scope: " " }, "scope"]) {
      expect(usableBuild(broken)).toBe("the approved build has no scope text or no Done-when checks");
    }
  });
});

describe("verifyBuild keeps every declared test module on the code the site runs", () => {
  it("runs a check module outside tests/ before the change instead of removing it", async () => {
    const repo = makeFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "tbo-worker-home-"));
    try {
      mkdirSync(join(repo.dir, "demo_app", "checks"), { recursive: true });
      writeFileSync(join(repo.dir, "demo_app", "checks", "done_when.py"), "# the Done-when checks\n");
      writeFileSync(join(repo.dir, "demo_app", "invoice.py"), "def validate(doc, method=None):\n    require(doc.sales_team)\n");
      const sandbox = new FakeSandbox();
      // the module must be there to run; it passes once invoice.py requires the row
      sandbox.judge = (module, mount) => {
        const path = join(mount, ...module.split(".")) + ".py";
        let present = true;
        try {
          readFileSync(path);
        } catch {
          present = false;
        }
        if (!present) return { ok: false, exit_code: 1, output: `ModuleNotFoundError: ${module}`, ms: 10, failure: "error" };
        const built = readFileSync(join(mount, "demo_app", "invoice.py"), "utf8").includes("sales_team");
        return built ? { ok: true, exit_code: 0, output: "OK", ms: 10 } : { ok: false, exit_code: 1, output: "AssertionError", ms: 10, failure: "assertion" };
      };
      await sandbox.start({ run: "r", customer: null, site: null, apps: [], mount: { app: "demo_app", dir: repo.dir } });
      const state: FixToolState = {
        app: "demo_app",
        dir: repo.dir,
        homeDir: home,
        apps: {},
        sandbox,
        sandboxId: "sbx-1",
        checks: [],
        build: { scope: "Require a Sales Team row.", checks: ["an invoice without one is refused"] },
        done: {
          summary: "require a Sales Team row",
          test_module: "demo_app.checks.done_when",
          explanation: "validate() requires it.",
          people_checks: [],
          risk_notes: "",
          check_results: [{ check: "an invoice without one is refused", test_module: "demo_app.checks.done_when" }],
        },
      };

      expect(await changedSources(state, ["demo_app.checks.done_when"])).toEqual(["demo_app/invoice.py"]);
      const checked = await verifyBuild(state, repo.commits[2]!, new Date().toISOString());

      expect(checked.failures).toEqual([]);
      expect(checked.checkResults).toEqual([
        { check: "an invoice without one is refused", test: "demo_app.checks.done_when", before: "fail", after: "pass", note: "" },
      ]);
    } finally {
      await removeWorkspace(repo.dir);
      await removeWorkspace(home);
    }
  });
});
