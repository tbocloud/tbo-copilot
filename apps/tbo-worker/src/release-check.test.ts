import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CheckRow, HubClient, ReleaseCheckJob } from "./hub.js";
import { runReleaseCheck } from "./release-check.js";
import type { SandboxResult } from "./sandbox.js";
import { Worker } from "./supervisor.js";
import { FakeSandbox } from "./test-support/fake-sandbox.js";
import { makeFixtureRepo } from "./test-support/git-fixture.js";

const quiet = () => undefined;

function setup(options: { refuse?: boolean } = {}) {
  const repo = makeFixtureRepo();
  const base = mkdtempSync(join(tmpdir(), "tbo-worker-release-"));
  const reported: Array<{ release: string; token: string; rows: CheckRow[]; testedOn: string }> = [];
  const hub = {
    releaseCheckResult: async (release: string, token: string, rows: CheckRow[], testedOn: string) => {
      if (options.refuse) throw new Error("This check's lease is no longer valid.");
      reported.push({ release, token, rows, testedOn });
      return { staging_status: "Passed" };
    },
  } as unknown as HubClient;
  const workspaceOptions = () => ({
    runsDir: join(base, "runs"),
    reposDir: join(base, "repos"),
    homeDir: join(base, "home"),
    repoMap: {},
    allowLocalRepos: true,
  });
  const job = (commit: string): ReleaseCheckJob => ({
    kind: "release_check",
    release: "TBO-DEP-2026-00009",
    lease_token: "lease",
    context: {
      release: "TBO-DEP-2026-00009",
      repository: repo.dir,
      branch: "main",
      app: "demo_app",
      commit,
      customer: "Alpha Trading",
      site: "alpha.example.com",
      apps: [
        { app: "frappe", repository: "frappe/frappe", branch: "version-15", commit: "f".repeat(40) },
        { app: "demo_app", repository: repo.dir, branch: "main", commit },
      ],
    },
  });
  return { repo, base, hub, reported, workspaceOptions, job };
}

describe("a release's sandbox check", () => {
  it("builds the release's code on a fresh site and reports migrate, the tests and new errors", async () => {
    const { repo, hub, reported, workspaceOptions, job } = setup();
    const sandbox = new FakeSandbox();
    let mounted = "";
    const start = sandbox.start.bind(sandbox);
    sandbox.start = async (spec) => {
      mounted = readFileSync(join(spec.mount.dir, "demo_app", "invoice.py"), "utf8");
      return start(spec);
    };

    const report = await runReleaseCheck(job(repo.commits[2]!), { hub, sandbox, workspaceOptions, log: quiet });

    expect(report.outcome).toBe("reported");
    expect(mounted).toContain("(doc.selling - doc.buying) / doc.selling");
    expect(sandbox.started[0]).toMatchObject({ run: "TBO-DEP-2026-00009", mount: { app: "demo_app" } });
    expect(sandbox.started[0]!.apps.map((app) => app.app)).toEqual(["frappe", "demo_app"]);
    expect(reported[0]!.rows.map((row) => [row.check, row.result])).toEqual([
      ["migrate", "pass"],
      ["demo_app tests", "not_run"],
      ["no new errors on the copy", "pass"],
    ]);
    expect(reported[0]!.testedOn).toBe("a fake sandbox site");
    expect(sandbox.stopped).toEqual(["sbx-1"]);
    expect(existsSync(join(workspaceOptions().runsDir, "release-TBO-DEP-2026-00009"))).toBe(false);
  });

  it("a failed migrate fails the check and skips the tests", async () => {
    const { repo, hub, reported, workspaceOptions, job } = setup();
    const sandbox = new FakeSandbox();
    sandbox.migrate = async (): Promise<SandboxResult> => ({ ok: false, exit_code: 1, output: "Patch demo_app.patches.v1 failed\nKeyError: 'rate'", ms: 900 });

    await runReleaseCheck(job(repo.commits[2]!), { hub, sandbox, workspaceOptions, log: quiet });

    const rows = reported[0]!.rows;
    expect(rows[0]).toMatchObject({ check: "migrate", result: "fail" });
    expect(rows[0]!.detail).toContain("KeyError");
    expect(rows[1]).toMatchObject({ result: "not_run", detail: "migrate failed first" });
  });

  it("failing tests and new errors fail it", async () => {
    const { repo, hub, reported, workspaceOptions, job } = setup();
    const sandbox = new FakeSandbox();
    sandbox.tests = async (): Promise<SandboxResult> => ({ ok: false, exit_code: 1, output: "AssertionError: 20 != 25\nFAILED (failures=1)", ms: 800, failure: "assertion" });
    sandbox.errorsSince = async () => ["demo_app | demo_app.invoice.validate | ZeroDivisionError"];

    await runReleaseCheck(job(repo.commits[2]!), { hub, sandbox, workspaceOptions, log: quiet });

    const rows = reported[0]!.rows;
    expect(rows[1]).toMatchObject({ check: "demo_app tests", result: "fail" });
    expect(rows[1]!.detail).toContain("a test failed");
    expect(rows[2]).toMatchObject({ result: "fail", detail: "demo_app | demo_app.invoice.validate | ZeroDivisionError" });
  });

  it("a check that cannot be done is not run, never failed, and starts no site", async () => {
    const { hub, reported, workspaceOptions, job } = setup();
    const sandbox = new FakeSandbox();

    await runReleaseCheck(job("1234567890abcdef1234567890abcdef12345678"), { hub, sandbox, workspaceOptions, log: quiet });

    expect(reported[0]!.rows).toEqual([expect.objectContaining({ check: "the sandbox check", result: "not_run" })]);
    expect(sandbox.started).toEqual([]);
  });

  it("an app or commit the worker cannot use is not run", async () => {
    const { hub, reported, workspaceOptions, job } = setup();
    const bad = job("not a commit; rm -rf /");

    await runReleaseCheck(bad, { hub, sandbox: new FakeSandbox(), workspaceOptions, log: quiet });

    expect(reported[0]!.rows).toEqual([expect.objectContaining({ check: "the release", result: "not_run" })]);
  });

  it("a result the hub no longer wants is dropped quietly", async () => {
    const { repo, hub, workspaceOptions, job } = setup({ refuse: true });
    const sandbox = new FakeSandbox();

    const report = await runReleaseCheck(job(repo.commits[2]!), { hub, sandbox, workspaceOptions, log: quiet });

    expect(report.outcome).toBe("not_reported");
    expect(sandbox.stopped).toEqual(["sbx-1"]);
  });

  it("only a worker with the sandbox offers releases' checks", () => {
    const make = (sandbox?: FakeSandbox) =>
      new Worker({} as never, {} as never, {} as never, {} as never, quiet, sandbox);
    expect(make(new FakeSandbox()).capabilities()).toBe("investigate,fix,release_check");
    expect(make().capabilities()).toBe("investigate");
  });
});
