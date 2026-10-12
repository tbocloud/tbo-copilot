import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildGitArgs, runRepoGit } from "./repo-git.js";
import { makeFixtureRepo } from "./test-support/git-fixture.js";

describe("buildGitArgs", () => {
  it("builds each command with revisions and paths after the end of options", () => {
    expect(buildGitArgs({ command: "log", path: "demo_app/invoice.py", max_count: 5, search: "margin" })).toEqual(
      expect.arrayContaining(["log", "--max-count=5", "-Smargin", "--end-of-options", "--", "demo_app/invoice.py"]),
    );
    const show = buildGitArgs({ command: "show", rev: "HEAD~1" });
    expect(show.slice(show.indexOf("--end-of-options"))).toEqual(["--end-of-options", "HEAD~1", "--"]);
    expect(buildGitArgs({ command: "blame", path: "a.py", lines: "1,20" })).toEqual(expect.arrayContaining(["-L", "1,20", "HEAD", "--", "a.py"]));
    expect(buildGitArgs({ command: "diff", rev: "abc1234", rev2: "HEAD" })).toContain("abc1234..HEAD");
  });

  it("always reads pathspecs literally and never runs hooks or external diff tools", () => {
    const args = buildGitArgs({ command: "show", rev: "HEAD" });
    expect(args.slice(0, 2)).toEqual(["--no-pager", "--literal-pathspecs"]);
    expect(args).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv", "core.hooksPath=/dev/null"]));
  });

  it.each([
    [{ command: "push" }, "command must be one of"],
    [{ command: "show", rev: "--output=/tmp/x" }, "rev must be"],
    [{ command: "show", rev: "HEAD..main" }, "rev must be"],
    [{ command: "log", path: "../../etc/passwd" }, "path must be"],
    [{ command: "log", path: "/etc/passwd" }, "path must be"],
    [{ command: "log", path: "-c" }, "path must be"],
    [{ command: "log", max_count: 500 }, "max_count"],
    [{ command: "log", search: "a\nb" }, "search must be"],
    [{ command: "blame" }, "blame needs a path"],
    [{ command: "blame", path: "a.py", lines: "1-20" }, "lines must"],
    [{ command: "diff", rev: "HEAD" }, "rev2 must be"],
  ])("refuses %j", (input, message) => {
    expect(() => buildGitArgs(input)).toThrow(message);
  });
});

describe("runRepoGit", () => {
  const repo = makeFixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "tbo-worker-home-"));
  const apps = { demo_app: repo.dir };

  it("reads the history of a file", async () => {
    const result = await runRepoGit(apps, { app: "demo_app", command: "log", path: "demo_app/invoice.py" }, { homeDir: home });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("fix: margin rate on sales invoices");
    expect(result.text).toContain("change the margin formula");
  });

  it("shows a commit and blames lines", async () => {
    const show = await runRepoGit(apps, { app: "demo_app", command: "show", rev: repo.commits[1] }, { homeDir: home });
    expect(show.text).toContain("doc.selling / doc.buying");
    const blame = await runRepoGit(apps, { app: "demo_app", command: "blame", path: "demo_app/invoice.py", lines: "2,2" }, { homeDir: home });
    expect(blame.ok).toBe(true);
    expect(blame.text).toContain("doc.margin");
  });

  it("names the apps when the app is unknown, and explains a refused request", async () => {
    expect(await runRepoGit(apps, { app: "other", command: "log" }, { homeDir: home })).toEqual({ ok: false, text: "app must be one of: demo_app" });
    const refused = await runRepoGit(apps, { app: "demo_app", command: "show", rev: "--output=/tmp/x" }, { homeDir: home });
    expect(refused.ok).toBe(false);
  });

  it("reports git's own failure", async () => {
    const missing = await runRepoGit(apps, { app: "demo_app", command: "show", rev: "deadbeef" }, { homeDir: home });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.text).toContain("git show failed");
  });
});
