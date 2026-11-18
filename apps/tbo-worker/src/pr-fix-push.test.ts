import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { afterPushError } from "./pr-fix.js";
import type { SandboxResult } from "./sandbox.js";
import { FakeSandbox } from "./test-support/fake-sandbox.js";
import { BRANCH, DEVELOPER_COMMIT, DONE, FIXED, PASSED, PrFixHarness, developerPushes, git, gitEnv, prRepo, remoteHook, sleep } from "./test-support/pr-fix-harness.js";

describe("a developer's pull request: the push to its branch", () => {
  const h = new PrFixHarness();

  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it("does not start when the branch has moved past the commit TBO Support named", async () => {
    const repo = prRepo();
    const moved = developerPushes(repo);
    const sandbox = new FakeSandbox();
    const { report, scripted, results } = await h.runWith([[{ tool: "pr_fix_done", args: DONE }]], { repo, sandbox });

    expect(report.outcome).toBe("failed");
    expect(report.reason).toMatch(/^the branch moved: feature\/margin is at [0-9a-f]{12}, not at [0-9a-f]{12}; nothing was pushed$/);
    expect(results()).toEqual([{ kind: "failure", reason: report.reason }]);
    expect(scripted.sessions).toHaveLength(0);
    expect(sandbox.started).toEqual([]);
    expect(git(repo, "rev-parse", BRANCH)).toBe(moved);
  });

  it("does not push when the developer pushed while Copilot worked", async () => {
    const repo = prRepo();
    const sandbox = new FakeSandbox();
    let developer = "";
    // the worker's own test run is when the developer pushes
    sandbox.tests = async (): Promise<SandboxResult> => {
      developer = developerPushes(repo);
      return { ok: true, exit_code: 0, output: "OK", ms: 1 };
    };
    const { report, results } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], {
      repo,
      sandbox,
    });

    expect(report.outcome).toBe("failed");
    expect(report.reason).toContain("the branch moved");
    expect(report.pushed).toBeUndefined();
    expect(results()).toEqual([{ kind: "failure", reason: report.reason }]);
    // the developer's commit stays the head; Copilot's is nowhere on the remote
    expect(git(repo, "rev-parse", BRANCH)).toBe(developer);
    expect(git(repo, "log", "--format=%ae", BRANCH)).not.toContain("copilot@example.com");
  });

  it("pushes only to the pull request's branch: a key for another branch pushes nothing", async () => {
    h.stub.prPushBranch = "main";
    try {
      const { report, repo } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]]);
      expect(report).toMatchObject({ outcome: "failed", reason: "the push key is for branch main, not feature/margin; nothing was pushed" });
      expect(git(repo, "rev-parse", "main")).toBe(repo.commits[2]);
      expect(git(repo, "rev-parse", BRANCH)).toBe(repo.commits[1]);
    } finally {
      h.stub.prPushBranch = undefined;
    }
  });

  // CodeRabbit on #31: no failure once TBO Support cancelled
  it("reports nothing once TBO Support cancelled, even when the branch moved meanwhile", async () => {
    const repo = prRepo();
    const sandbox = new FakeSandbox();
    // the developer pushes while Copilot checks its change, and TBO Support cancels as the worker gets the push key
    sandbox.tests = async (): Promise<SandboxResult> => {
      developerPushes(repo);
      return PASSED;
    };
    h.stub.prPushKeyHook = async () => {
      h.stub.prHeartbeatAction = "cancel";
      await sleep(150);
    };
    try {
      const { report, mine } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], {
        repo,
        sandbox,
        limits: { heartbeatIntervalMs: 20 },
      });
      expect(report.outcome).toBe("cancelled");
      expect(mine("pr_result")).toHaveLength(0);
    } finally {
      h.stub.prPushKeyHook = undefined;
      h.stub.prHeartbeatAction = "continue";
    }
  });

  // CodeRabbit on #31: the last look comes right before the push
  it("does not push when TBO Support cancels while the worker gets ready to push", async () => {
    h.stub.prPushKeyHook = async () => {
      h.stub.prHeartbeatAction = "cancel";
      await sleep(150);
    };
    try {
      const { report, repo, mine } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], {
        limits: { heartbeatIntervalMs: 20 },
      });
      expect(report.outcome).toBe("cancelled");
      expect(report.pushed).toBeUndefined();
      expect(git(repo, "rev-parse", BRANCH)).toBe(repo.commits[1]);
      expect(mine("pr_result")).toHaveLength(0);
    } finally {
      h.stub.prPushKeyHook = undefined;
      h.stub.prHeartbeatAction = "continue";
    }
  });

  // CodeRabbit on #31: after a push error, the branch says what happened
  it("reports the fix as pushed when the push errs after the remote took the commit", async () => {
    const repo = prRepo();
    remoteHook(repo, "post-receive", "kill -9 $PPID"); // the remote takes the commit, then the connection dies before the pusher hears so
    const { report, results } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], { repo });

    const head = git(repo, "rev-parse", BRANCH);
    expect(git(repo, "rev-parse", `${BRANCH}^`)).toBe(repo.commits[1]);
    expect(report).toMatchObject({ outcome: "done", pushed: head });
    expect(results()).toEqual([expect.objectContaining({ kind: "done", head_sha: head, fixed: [{ id: "CR-1", commit: head, note: DONE.fixed[0]!.note }] })]);
  });

  // CodeRabbit on #31 (again): another head does not prove the push failed; the branch's history decides
  it("reports the fix as pushed when the developer pushed on top of it before the worker looked", async () => {
    const repo = prRepo();
    // the remote takes Copilot's commit, the developer's next commit lands on top, and the connection dies
    remoteHook(repo, "post-receive", ["read old new ref", DEVELOPER_COMMIT("$new"), 'git update-ref "$ref" "$next" "$new"', "kill -9 $PPID"].join("\n"));
    const { report, results } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], { repo });

    const copilot = git(repo, "rev-parse", `${BRANCH}^`);
    expect(git(repo, "log", "-1", "--format=%ae", BRANCH)).toBe("dev@example.com");
    expect(git(repo, "log", "-1", "--format=%ae", copilot)).toBe("copilot@example.com");
    expect(git(repo, "rev-parse", `${copilot}^`)).toBe(repo.commits[1]);
    expect(report).toMatchObject({ outcome: "done", pushed: copilot });
    expect(results()).toEqual([expect.objectContaining({ kind: "done", head_sha: copilot, fixed: [{ id: "CR-1", commit: copilot, note: DONE.fixed[0]!.note }] })]);
  });

  it("reports nothing when the push errs and the branch is then at a commit without Copilot's", async () => {
    const repo = prRepo();
    // the remote takes Copilot's commit, the developer replaces the branch with one of theirs, and the connection dies
    remoteHook(repo, "post-receive", ["read old new ref", DEVELOPER_COMMIT("$old"), 'git update-ref "$ref" "$next" "$new"', "kill -9 $PPID"].join("\n"));
    const { report, mine } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], { repo });

    const developer = git(repo, "rev-parse", BRANCH);
    expect(git(repo, "rev-parse", `${BRANCH}^`)).toBe(repo.commits[1]);
    expect(report.outcome).toBe("not_reported");
    expect(report.reason).toMatch(/^push outcome unknown: the push of [0-9a-f]{12} failed \(.*\) and the branch is at [0-9a-f]{12}, which does not hold it; nothing was reported$/s);
    expect(report.reason).toContain(developer.slice(0, 12));
    expect(mine("pr_result")).toHaveLength(0);
  });

  // CodeRabbit on #31 (a third look): the branch back at its head does not prove the push failed either
  it("reports nothing when the remote took the push and the branch was reset to the head before the answer came", async () => {
    const repo = prRepo();
    remoteHook(repo, "post-receive", ["read old new ref", 'git update-ref "$ref" "$old" "$new"', "kill -9 $PPID"].join("\n"));
    const { report, mine } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], { repo });

    expect(git(repo, "rev-parse", BRANCH)).toBe(repo.commits[1]);
    expect(report.outcome).toBe("not_reported");
    expect(report.reason).toMatch(/^push outcome unknown: the push of [0-9a-f]{12} failed \(.*\) and the branch is at the pull request's head again, without Copilot's commit; nothing was reported$/s);
    expect(mine("pr_result")).toHaveLength(0);
  });

  it("fails when the remote refuses the push and the branch stays at the head", async () => {
    const repo = prRepo();
    remoteHook(repo, "pre-receive", "exit 1");
    const { report, results } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], { repo });

    expect(report.outcome).toBe("failed");
    expect(report.reason).toMatch(/^the push failed: the remote refused it \(.*pre-receive hook declined.*\); nothing was pushed$/s);
    expect(results()).toEqual([{ kind: "failure", reason: report.reason }]);
    expect(git(repo, "rev-parse", BRANCH)).toBe(repo.commits[1]);
  });

  it("still fails as a moved branch when the remote refuses the push", async () => {
    const repo = prRepo();
    const developer = git(repo, "commit-tree", `${repo.commits[1]}^{tree}`, "-p", repo.commits[1]!, "-m", "the developer's push");
    // the developer's commit lands first, and the remote refuses Copilot's
    remoteHook(repo, "pre-receive", `printf '%s\\n' ${developer} > refs/heads/${BRANCH}\nexit 1`);
    const { report, results } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], { repo });

    expect(report).toMatchObject({
      outcome: "failed",
      reason: `the branch moved: ${BRANCH} is at ${developer.slice(0, 12)}, not at ${repo.commits[1]!.slice(0, 12)}; nothing was pushed`,
    });
    expect(report.pushed).toBeUndefined();
    expect(results()).toEqual([{ kind: "failure", reason: report.reason }]);
    expect(git(repo, "rev-parse", BRANCH)).toBe(developer);
  });

  it("reports nothing when the push errs and the branch cannot be read afterwards", async () => {
    const repo = prRepo();
    remoteHook(repo, "post-receive", 'mv "$(pwd)" "$(pwd).gone"\nkill -9 $PPID'); // and the repository is gone from where it was
    const { report, mine } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], { repo });

    expect(report.outcome).toBe("not_reported");
    expect(report.reason).toMatch(/^push outcome unknown: the push of [0-9a-f]{12} failed/);
    expect(mine("pr_result")).toHaveLength(0);
  });

  // CodeRabbit on #31 (review 2): only git's own refusal of our ref counts, never a hook's words
  it("reports nothing when a hook's message says rejected, the remote took the push and the branch was reset", async () => {
    const repo = prRepo();
    remoteHook(repo, "pre-receive", [`echo " ! [remote rejected] HEAD -> ${BRANCH} (policy check)" >&2`, 'echo "Deployment rejected: non-fast-forward" >&2', "exit 0"].join("\n"));
    remoteHook(repo, "post-receive", ["read old new ref", 'echo "rejected nothing" >&2', 'git update-ref "$ref" "$old" "$new"', "kill -9 $PPID"].join("\n"));
    const { report, mine } = await h.runWith([[{ write: "apps/demo_app/demo_app/invoice.py", content: FIXED }, { tool: "pr_fix_done", args: DONE }]], { repo });

    expect(report.outcome).toBe("not_reported");
    expect(report.reason).toContain("remote:  ! [remote rejected]"); // git's stderr had the hook's words, and they were not taken for a refusal
    expect(report.reason).toContain("the branch is at the pull request's head again, without Copilot's commit; nothing was reported");
    expect(mine("pr_result")).toHaveLength(0);
  });

  it("takes a non-fast-forward refusal of the push as a moved branch", async () => {
    const repo = prRepo();
    const base = repo.commits[1]!;
    // Copilot's clone with its commit on the head, while the developer's commit lands on the branch first
    const local = mkdtempSync(join(tmpdir(), "tbo-worker-prfix-local-"));
    execFileSync("git", ["clone", "--quiet", "--branch", BRANCH, repo.dir, local], { env: gitEnv });
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "fix: CodeRabbit round 1 (TBO Copilot)"], { cwd: local, env: gitEnv });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: local, encoding: "utf8" }).trim();
    const developer = developerPushes(repo);
    let stderr = "";
    try {
      execFileSync("git", ["push", "--quiet", "--end-of-options", repo.dir, `HEAD:refs/heads/${BRANCH}`], { cwd: local, env: gitEnv, stdio: "pipe" });
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    }
    expect(stderr).toMatch(/! \[rejected\] +HEAD -> feature\/margin \((fetch first|non-fast-forward)\)/);

    const outcome = await afterPushError({ dir: local, root: local, repository: repo.dir, branch: BRANCH, base, commit, homeDir: local, token: "unused", stderr });
    expect(outcome).toEqual({ kind: "not_landed", reason: `the branch moved: ${BRANCH} is at ${developer.slice(0, 12)}, not at ${base.slice(0, 12)}; nothing was pushed` });
  });
});
