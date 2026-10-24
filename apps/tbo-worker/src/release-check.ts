import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { CheckRow, HubClient, ReleaseCheckJob } from "./hub.js";
import type { Logger } from "./log.js";
import { APP, type Sandbox, type SandboxResult } from "./sandbox.js";
import { checkoutCommit, normalizeRepository, removeWorkspace, workspaceRoot, type WorkspaceOptions } from "./workspace.js";

/**
 * A release's check on the sandbox (Phase 7, W11), before the release's approval.
 *
 * No AI: TBO Support hands out a release whose CI is green; the worker checks
 * out the released app at the release's commit, starts a fresh site with the
 * site card's apps at the commits they run and this app mounted over its own,
 * then asks the sandbox runner for its fixed operations: migrate, the app's
 * tests, and the errors logged on the copy since it started. The evidence
 * goes back to the hub, which decides. When the check cannot be done at all
 * (the runner or GitHub unreachable), every line is `not_run`, so the hub asks
 * a senior instead of blaming the code.
 */
export type ReleaseCheckDeps = {
  hub: HubClient;
  sandbox: Sandbox;
  workspaceOptions: () => WorkspaceOptions;
  log: Logger;
};

export type ReleaseCheckReport = {
  release: string;
  outcome: "reported" | "not_reported";
  rows: CheckRow[];
};

const COMMIT = /^[0-9a-f]{7,40}$/i;

function lastLines(output: string, count = 6): string {
  return output.trim().split("\n").slice(-count).join("\n").slice(0, 500);
}

function migrateRow(result: SandboxResult): CheckRow {
  return result.ok
    ? { check: "migrate", result: "pass", detail: `${Math.round(result.ms / 1000)} s` }
    : { check: "migrate", result: "fail", detail: lastLines(result.output) };
}

function testsRow(app: string, result: SandboxResult): CheckRow {
  if (result.skipped) return { check: `${app} tests`, result: "not_run", detail: "the app has no tests" };
  if (result.ok) return { check: `${app} tests`, result: "pass", detail: lastLines(result.output, 3) };
  return {
    check: `${app} tests`,
    result: "fail",
    detail: `${result.failure === "assertion" ? "a test failed" : "an error"}: ${lastLines(result.output)}`,
  };
}

export async function runReleaseCheck(job: ReleaseCheckJob, deps: ReleaseCheckDeps): Promise<ReleaseCheckReport> {
  const { hub, sandbox, log } = deps;
  const context = job.context;
  const rows: CheckRow[] = [];
  const options = deps.workspaceOptions();
  const root = workspaceRoot(options.runsDir, `release-${context.release}`);
  let sandboxId: string | undefined;
  let testedOn = "";
  log("info", "release check claimed", { release: context.release, app: context.app, commit: context.commit });
  try {
    const repository = normalizeRepository(context.repository, options.allowLocalRepos);
    if (!APP.test(context.app) || !COMMIT.test(context.commit) || !repository) {
      rows.push({ check: "the release", result: "not_run", detail: "the hub sent an app, commit or repository the worker cannot use" });
    } else {
      await removeWorkspace(root);
      await mkdir(join(root, "apps"), { recursive: true, mode: 0o700 });
      const dir = join(root, "apps", context.app);
      await checkoutCommit(repository, context.commit, dir, context.repo_token ? { ...options, githubToken: context.repo_token } : options);
      const started = await sandbox.start({
        run: context.release,
        customer: context.customer ?? null,
        site: context.site ?? null,
        apps: context.apps.map((app) => ({
          app: app.app,
          repository: app.repository ?? null,
          branch: app.branch ?? null,
          commit: app.commit ?? null,
        })),
        mount: { app: context.app, dir },
      });
      sandboxId = started.id;
      testedOn = started.tested_on || "a sandbox site";
      const since = new Date().toISOString();
      const migrate = await sandbox.migrate(started.id);
      rows.push(migrateRow(migrate));
      if (migrate.ok) rows.push(testsRow(context.app, await sandbox.tests(started.id, context.app)));
      else rows.push({ check: `${context.app} tests`, result: "not_run", detail: "migrate failed first" });
      const errors = await sandbox.errorsSince(started.id, since);
      rows.push({
        check: "no new errors on the copy",
        result: errors.length ? "fail" : "pass",
        ...(errors.length ? { detail: errors.slice(0, 3).join("; ").slice(0, 500) } : {}),
      });
    }
  } catch (error) {
    // the check could not be done: not the code's fault, so nothing passes or fails
    log("warn", "release check could not run", { release: context.release, error: String(error) });
    rows.splice(0, rows.length, { check: "the sandbox check", result: "not_run", detail: String((error as Error).message ?? error).slice(0, 300) });
  } finally {
    if (sandboxId) await sandbox.stop(sandboxId).catch(() => undefined);
    await removeWorkspace(root).catch(() => undefined);
  }
  try {
    await hub.releaseCheckResult(context.release, job.lease_token, rows, testedOn);
    return { release: context.release, outcome: "reported", rows };
  } catch (error) {
    // the lease ended meanwhile (new commits, or it expired): the hub no longer wants this result
    log("warn", "release check not reported", { release: context.release, error: String(error) });
    return { release: context.release, outcome: "not_reported", rows };
  }
}
