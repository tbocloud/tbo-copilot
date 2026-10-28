import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolPermissionRequest } from "@pi-desktop/shared";
import { afterAll, describe, expect, it } from "vitest";

import type { Job } from "./hub.js";
import { editsInside } from "./policy.js";
import { gitEnv, runGit } from "./repo-git.js";
import { SandboxError, SocketSandbox } from "./sandbox.js";
import { makeFixtureRepo } from "./test-support/git-fixture.js";
import { prepareWorkspace, removeWorkspace } from "./workspace.js";

function request(toolName: string, path: string, agentName?: string): ToolPermissionRequest {
  return {
    requestId: "r1",
    sessionId: "s1",
    toolCallId: "t1",
    toolName,
    argsPreview: { path },
    risk: "medium",
    reason: "write",
    ...(agentName ? { agentName } : {}),
  } as ToolPermissionRequest;
}

describe("editsInside: a fix session edits its app and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "tbo-fix-policy-"));
  const app = join(root, "apps", "demo_app");
  mkdirSync(join(app, "demo_app"), { recursive: true });
  mkdirSync(join(app, ".git"), { recursive: true });
  mkdirSync(join(root, "apps", "other_app"), { recursive: true });
  writeFileSync(join(app, "demo_app", "invoice.py"), "x = 1\n");
  const outside = mkdtempSync(join(tmpdir(), "tbo-fix-outside-"));
  symlinkSync(outside, join(app, "escape"));
  const decide = editsInside(root, app);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("allows Edit, Write and MultiEdit inside the app, also on new files", () => {
    expect(decide(request("Edit", "apps/demo_app/demo_app/invoice.py"))).toBe("allow-once");
    expect(decide(request("Write", "apps/demo_app/demo_app/tests/test_margin.py"))).toBe("allow-once");
    expect(decide(request("MultiEdit", join(app, "demo_app", "invoice.py")))).toBe("allow-once");
  });

  it("refuses the app's .git, other apps, the run's folder and anything outside", () => {
    expect(decide(request("Write", "apps/demo_app/.git/config"))).toBe("deny");
    // a .git folder at any depth, in any case (macOS file systems ignore case)
    expect(decide(request("Write", "apps/demo_app/.GIT/config"))).toBe("deny");
    expect(decide(request("Write", "apps/demo_app/demo_app/.git/hooks/pre-commit"))).toBe("deny");
    expect(decide(request("Edit", "apps/other_app/x.py"))).toBe("deny");
    expect(decide(request("Write", "INDEX.md"))).toBe("deny");
    expect(decide(request("Write", "apps/demo_app/../../../etc/passwd"))).toBe("deny");
    expect(decide(request("Write", "/etc/hosts"))).toBe("deny");
  });

  it("refuses a path that leaves the app through a symbolic link", () => {
    expect(decide(request("Write", "apps/demo_app/escape/stolen.txt"))).toBe("deny");
    expect(decide(request("Write", "apps/demo_app/escape"))).toBe("deny");
  });

  it("refuses every other tool, and any delegate", () => {
    expect(decide(request("Bash", "apps/demo_app/x"))).toBe("deny");
    expect(decide(request("Edit", "apps/demo_app/demo_app/invoice.py", "fixer"))).toBe("deny");
    expect(decide({ ...request("Edit", ""), argsPreview: {} } as ToolPermissionRequest)).toBe("deny");
  });
});

describe("a fix workspace", () => {
  it("puts the fixed app on Copilot's branch, writable, committing as TBO Copilot; the rest stays read-only", async () => {
    const repo = makeFixtureRepo();
    const other = makeFixtureRepo();
    const base = mkdtempSync(join(tmpdir(), "tbo-fix-ws-"));
    const job: Job = {
      run: "TBO-RUN-2026-00042",
      lease_token: "lease",
      lease_expires: "",
      context: {
        run: "TBO-RUN-2026-00042",
        kind: "fix",
        ticket: { name: "0300", subject: "Margin wrong" },
        site: {
          apps: [
            { app: "demo_app", repository: repo.dir, deployed_commit: repo.commits[1] },
            { app: "other_app", repository: other.dir, deployed_commit: other.commits[0] },
          ],
        },
      },
    };
    const options = {
      runsDir: join(base, "runs"),
      reposDir: join(base, "repos"),
      homeDir: join(base, "home"),
      repoMap: {},
      allowLocalRepos: true,
    };
    try {
      await expect(
        prepareWorkspace(job, { ...options, writable: { app: "demo_app", branch: "main", email: "copilot@example.com" } }),
      ).rejects.toThrow("copilot/ branch");

      const workspace = await prepareWorkspace(job, {
        ...options,
        writable: { app: "demo_app", branch: "copilot/TASK-2026-00009-r42-a1", email: "copilot@example.com" },
      });

      const fixed = workspace.writable!;
      expect(fixed.app).toBe("demo_app");
      const env = gitEnv(options.homeDir);
      expect((await runGit(fixed.dir, ["rev-parse", "--abbrev-ref", "HEAD"], env)).trim()).toBe("copilot/TASK-2026-00009-r42-a1");
      expect((await runGit(fixed.dir, ["config", "user.email"], env)).trim()).toBe("copilot@example.com");
      writeFileSync(join(fixed.dir, "demo_app", "invoice.py"), "fixed = True\n");
      const otherDir = workspace.apps.find((app) => app.app === "other_app")!.dir;
      expect(() => writeFileSync(join(otherDir, "demo_app", "invoice.py"), "no")).toThrow();
      await removeWorkspace(workspace.root);
    } finally {
      rmSync(base, { recursive: true, force: true });
      await removeWorkspace(repo.dir);
      await removeWorkspace(other.dir);
    }
  });
});

describe("the sandbox runner's client", () => {
  function runner(reply: (request: Record<string, unknown>) => unknown): Promise<{ server: Server; path: string; seen: Record<string, unknown>[] }> {
    const path = join(mkdtempSync(join(tmpdir(), "tbo-sbx-")), "runner.sock");
    const seen: Record<string, unknown>[] = [];
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.split("\n")[0]!) as Record<string, unknown>;
        seen.push(request);
        socket.write(`${JSON.stringify(reply(request))}\n`);
      });
    });
    return new Promise((resolve) => server.listen(path, () => resolve({ server, path, seen })));
  }

  it("sends one operation per request and reads the result", async () => {
    const { server, path, seen } = await runner((request) =>
      request.op === "start"
        ? { ok: true, result: { id: "sbx-1" } }
        : { ok: true, result: { ok: false, exit_code: 1, output: "AssertionError: 1.25 != 0.2", ms: 900, failure: "assertion" } },
    );
    try {
      const sandbox = new SocketSandbox(path, 5_000);
      const started = await sandbox.start({ run: "R1", apps: [{ app: "demo_app", commit: "abc1234" }], mount: { app: "demo_app", dir: "/tmp/x" } });
      const result = await sandbox.check(started.id, "demo_app", "demo_app.tests.test_margin");
      expect(started.id).toBe("sbx-1");
      expect(result).toMatchObject({ ok: false, exit_code: 1 });
      expect(seen[1]).toEqual({ op: "check", id: "sbx-1", app: "demo_app", module: "demo_app.tests.test_margin" });
    } finally {
      server.close();
    }
  });

  it("stops at a failed check whose answer does not say how it failed", async () => {
    const { server, path } = await runner(() => ({ ok: true, result: { ok: false, exit_code: 1, output: "FAILED", ms: 900 } }));
    try {
      await expect(new SocketSandbox(path, 5_000).check("sbx-1", "demo_app", "demo_app.tests.test_margin")).rejects.toThrow(
        "did not say how demo_app.tests.test_margin failed",
      );
    } finally {
      server.close();
    }
  });

  it("refuses a module that is not a dotted Python name before asking the runner", async () => {
    const sandbox = new SocketSandbox("/nonexistent.sock", 1_000);
    await expect(sandbox.check("sbx-1", "demo_app", "demo_app.tests; rm -rf /")).rejects.toBeInstanceOf(SandboxError);
    await expect(sandbox.tests("sbx-1", "Demo App")).rejects.toBeInstanceOf(SandboxError);
  });

  it("tries a correction on the copy with one request, records and all", async () => {
    const { server, path, seen } = await runner(() => ({
      ok: true,
      result: [{ doctype: "Item Price", name: "IP-1", ok: false, error: "the rate must be positive" }],
    }));
    try {
      const changes = [{ action: "update" as const, doctype: "Item Price", name: "IP-1", values: { price_list_rate: -1 } }];
      const trials = await new SocketSandbox(path, 5_000).tryChangeSet("sbx-1", changes);
      expect(trials[0]).toMatchObject({ ok: false, error: "the rate must be positive" });
      expect(seen[0]).toEqual({ op: "try_change_set", id: "sbx-1", changes });
    } finally {
      server.close();
    }
  });

  it("does not wait out the timeout when the runner hangs up without answering", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "tbo-sbx-")), "runner.sock");
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(path, () => resolve()));
    try {
      const started = Date.now();
      await expect(new SocketSandbox(path, 60_000).migrate("sbx-1")).rejects.toThrow("closed the connection without answering migrate");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.close();
    }
  });

  it("passes on the runner's refusal in its own words", async () => {
    const { server, path } = await runner(() => ({ ok: false, error: "no copy of this customer's site yet" }));
    try {
      await expect(new SocketSandbox(path, 5_000).migrate("sbx-1")).rejects.toThrow("no copy of this customer's site yet");
    } finally {
      server.close();
    }
  });
});

describe("the fix prompt", () => {
  it("carries what people asked for when they rejected an earlier fix", async () => {
    const { fixPrompt } = await import("./fix-prompt.js");
    const context = { run: "r", kind: "fix", ticket: { name: "0312" }, fix: { task: "TASK-1", closes: "", branch: "copilot/x", attempt: 2, max_usd: 3, commit_email: "c@x", repositories: [], guidance: ["use the price list rate", " "] } };
    const prompt = fixPrompt(context, "alpha", "copilot/x", "a sandbox");
    expect(prompt).toContain("An earlier fix was rejected");
    expect(prompt).toContain("- use the price list rate");
    expect(fixPrompt({ ...context, fix: { ...context.fix, guidance: [] } }, "alpha", "copilot/x", "a sandbox")).not.toContain("rejected");
  });

  it("asks a build for exactly the scope the customer approved, and its review compares with it", async () => {
    const { fixPrompt, reviewPrompt } = await import("./fix-prompt.js");
    const build = { scope: "Require a Sales Team row on Sales Invoice.", checks: ["an invoice without one is refused", "a return is not"] };
    const context = { run: "r", kind: "fix", ticket: { name: "0004" }, fix: { task: "TASK-1", closes: "", branch: "copilot/x", attempt: 1, max_usd: 3, commit_email: "c@x", repositories: [], build } };

    const prompt = fixPrompt(context, "alpha", "copilot/x", "a sandbox");
    expect(prompt).toContain("Build the customization the customer approved on ticket 0004");
    expect(prompt).toContain("Require a Sales Team row on Sales Invoice.");
    expect(prompt).toContain("- a return is not");
    expect(prompt).toContain("check_results");

    const review = reviewPrompt("alpha", "", build);
    expect(review).toContain("Anything beyond this scope is must_fix");
    expect(review).toContain("- an invoice without one is refused");
    expect(reviewPrompt("alpha", "the margin is wrong")).toContain("The bug it should fix");
  });
});
