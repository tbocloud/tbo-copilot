"use strict";

// The two tools end to end on real git repositories: a bare "origin" that looks like GitHub
// (url.insteadOf), a clone in a bench's apps/ folder, and stand-ins for gh, uv and bench that
// record what they were asked. Nothing reaches the network.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { run } = require("../../tbo.frappe-dev/lib/run");
const { createDev, DEV_TOOL, PR_TOOL } = require("../../tbo.frappe-dev/lib/dev");
const { PINS } = require("../../tbo.frappe-dev/lib/lint");
const manifest = require("../../tbo.frappe-dev/manifest.json");

const GITHUB_URL = "https://github.com/tbocloud/my_app.git";
const PR_URL = "https://github.com/tbocloud/my_app/pull/7";
const TASK = "TASK-2026-00021";
const LINT_WORKFLOW = `jobs:
  commit-lint:
    steps:
      - run: npx commitlint --from x --to y
  linter:
    steps:
      - uses: pre-commit/action@v3.0.1
      - run: semgrep ci --config ./frappe-semgrep-rules/rules --config r/python.lang.correctness
`;

function world(t, { settings = {}, workflow = LINT_WORKFLOW, workspace } = {}) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tbo-dev-")));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: top,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Dev",
    GIT_AUTHOR_EMAIL: "dev@example.com",
    GIT_COMMITTER_NAME: "Dev",
    GIT_COMMITTER_EMAIL: "dev@example.com",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const write = (root, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  const origin = path.join(top, "origin.git");
  git(top, "init", "-q", "--bare", "-b", "main", origin);
  // every GitHub address of the app goes to the local origin
  git(top, "config", "--global", `url.${origin}.insteadOf`, GITHUB_URL);

  const seed = path.join(top, "seed");
  git(top, "init", "-q", "-b", "main", seed);
  write(seed, "my_app/hooks.py", "app_name = 'my_app'\n");
  write(seed, "my_app/selling/discounts.py", "def cap(x):\n    return x\n");
  write(seed, "my_app/selling/test_discounts.py", "def test_cap():\n    pass\n");
  write(seed, ".pre-commit-config.yaml", "repos: []\n");
  if (workflow) write(seed, ".github/workflows/lint.yml", workflow);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "chore: start");
  git(seed, "remote", "add", "origin", GITHUB_URL);
  git(seed, "push", "-q", "origin", "main");

  const bench = path.join(top, "bench");
  fs.mkdirSync(path.join(bench, "apps", "frappe"), { recursive: true });
  fs.mkdirSync(path.join(bench, "sites", "dev.localhost"), { recursive: true });
  fs.writeFileSync(path.join(bench, "sites", "currentsite.txt"), "dev.localhost\n");
  const repo = path.join(bench, "apps", "my_app");
  git(top, "clone", "-q", GITHUB_URL, repo);

  const dataDir = path.join(top, "data");
  fs.mkdirSync(path.join(dataDir, "frappe-semgrep-rules", ".git"), { recursive: true }); // as if cloned today
  const uv = path.join(top, "uv");
  fs.writeFileSync(uv, "");

  const calls = [];
  const bodies = [];
  const answers = {
    preCommit: { code: 0, stdout: "black....Passed\n" },
    semgrep: { code: 0, stdout: JSON.stringify({ results: [], errors: [] }) },
    tests: { code: 0, stdout: "Ran 3 tests in 0.2s\n\nOK\n" },
    prView: { code: 1, stdout: "", stderr: "no pull requests found for branch" },
    ghAuth: { code: 0, stdout: "", stderr: "✓ Logged in to github.com account dev-user (keyring)" },
  };
  const runFn = async (cmd, args, opts) => {
    calls.push([cmd === uv ? "uv" : path.basename(cmd), ...args]);
    if (cmd === "git") return run(cmd, args, opts);
    if (cmd === uv) return args.includes("pre-commit") ? answers.preCommit : answers.semgrep;
    if (cmd === "bench") return { ...answers.tests, cwd: opts.cwd };
    if (cmd === "gh") {
      const [a, b] = args;
      if (a === "auth") return answers.ghAuth;
      if (a === "pr" && b === "view") return answers.prView;
      if (a === "pr" && b === "create") {
        bodies.push(fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8"));
        return { code: 0, stdout: `Creating pull request\n${PR_URL}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    throw Object.assign(new Error(`${cmd} missing`), { code: "MISSING" });
  };
  const dev = createDev({
    getSettings: async () => ({ uvPath: uv, ...settings }),
    getDataPath: async () => dataDir,
    getWorkspace: async () => ({ path: workspace === "bench" ? bench : repo, name: "my_app" }),
    runFn,
    env,
  });
  const commit = (rel, text, message) => {
    write(repo, rel, text);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", message);
    return git(repo, "rev-parse", "HEAD");
  };
  return { dev, repo, origin, bench, top, git, write, commit, calls, bodies, answers, env, dataDir };
}

async function finished(dev, job) {
  for (let i = 0; i < 200; i += 1) {
    const s = await dev.runDev({ action: "job_status", job });
    if (s.state !== "running") return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${job} never finished`);
}

const neverForced = (calls) => {
  for (const c of calls) {
    assert.ok(!c.some((a) => a === "--force" || a === "-f" || a === "--no-verify" || String(a).startsWith("--force-with-lease") || String(a).startsWith("+")), c.join(" "));
  }
};

async function readyBranch(w, message = "feat(selling): cap the discount per tier") {
  await w.dev.runDev({ action: "start_work", task: TASK, subject: "Cap the discount per tier" });
  w.commit("my_app/selling/discounts.py", "def cap(x):\n    return min(x, 10)\n", message);
}

// --- the declarations --------------------------------------------------------------------

test("the manifest declares exactly the code's two tools, its skills and its settings", () => {
  const pick = (t) => ({ name: t.name, description: t.description, risk: t.risk, planSafeActions: t.planSafeActions, schema: t.schema });
  assert.deepEqual(manifest.contributes.agentTools.map(pick), [pick(DEV_TOOL), pick(PR_TOOL)]);
  assert.match(manifest.id, /^tbo\./);
  assert.equal(PR_TOOL.risk, "high", "the push always asks");
  assert.equal(PR_TOOL.planSafeActions, undefined);
  assert.deepEqual(DEV_TOOL.planSafeActions, ["status", "job_status"]);
  assert.deepEqual([...manifest.permissions].sort(), ["agent.prompt.inject", "agent.tool.register"]);
  assert.equal(manifest.net, undefined, "the plugin itself reaches no network");
  for (const file of manifest.contributes.skills) {
    const text = fs.readFileSync(path.join(__dirname, "../../tbo.frappe-dev", file), "utf8");
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
    assert.ok(front, `${file} has no front matter`);
    assert.ok(front[2].length <= 240, `${file}'s description is ${front[2].length} characters`);
  }
  for (const s of manifest.contributes.settings) assert.doesNotMatch(s.key, /key|secret|token|password/i, s.key);
});

// --- status and the repository ------------------------------------------------------------

test("status names the repository, its GitHub slug, the bench, the test site and the GitHub login", async (t) => {
  const w = world(t);
  const s = await w.dev.runDev({ action: "status" });
  assert.equal(s.repo, w.repo);
  assert.equal(s.github, "tbocloud/my_app");
  assert.equal(s.branch, "main");
  assert.equal(s.task, null);
  assert.equal(s.default_branch, "main");
  assert.equal(s.bench, w.bench);
  assert.equal(s.test_site, "dev.localhost");
  assert.deepEqual(s.gh, { ok: true, login: "dev-user" });
});

test("a bench as the workspace names its app repositories; repo picks one, never outside the workspace", async (t) => {
  const w = world(t, { workspace: "bench" });
  await assert.rejects(w.dev.runDev({ action: "status" }), { code: "NOT_A_REPO", message: /apps\/my_app/ });
  assert.equal((await w.dev.runDev({ action: "status", repo: "apps/my_app" })).repo, w.repo);
  await assert.rejects(w.dev.runDev({ action: "status", repo: "../.." }), { code: "INVALID_ARGUMENT" });
});

// --- start_work --------------------------------------------------------------------------

test("start_work makes the task's branch from origin's default branch, records its base, tracks nothing", async (t) => {
  const w = world(t);
  const r = await w.dev.runDev({ action: "start_work", task: "task-2026-00021", subject: "Cap the discount per tier", kind: "feature" });
  assert.equal(r.branch, "feature/TASK-2026-00021-cap-the-discount-per-tier");
  assert.equal(r.state, "created");
  assert.equal(r.base, "main");
  assert.equal(w.git(w.repo, "branch", "--show-current"), r.branch);
  assert.equal(w.git(w.repo, "config", `branch.${r.branch}.tboBase`), "main");
  assert.throws(() => w.git(w.repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "no upstream: the push sets it");
  assert.equal((await w.dev.runDev({ action: "start_work", task: TASK, subject: "anything" })).state, "already on it");
  neverForced(w.calls);
});

test("start_work refuses a dirty tree and never stashes; a bad base or task is refused", async (t) => {
  const w = world(t);
  w.write(w.repo, "notes.txt", "mine");
  await assert.rejects(w.dev.runDev({ action: "start_work", task: TASK, subject: "x" }), { code: "DIRTY", message: /notes\.txt/ });
  assert.equal(w.git(w.repo, "stash", "list"), "");
  fs.rmSync(path.join(w.repo, "notes.txt"));
  await assert.rejects(w.dev.runDev({ action: "start_work", task: TASK, subject: "x", base: "../main" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(w.dev.runDev({ action: "start_work", task: "TASK-1", subject: "x" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(w.dev.runDev({ action: "start_work", task: TASK }), { code: "INVALID_ARGUMENT", message: /subject/ });
});

test("start_work returns to the task's existing branch, local or on origin, whatever its short name", async (t) => {
  const w = world(t);
  await w.dev.runDev({ action: "start_work", task: TASK, subject: "First name" });
  w.git(w.repo, "switch", "-q", "main");
  const again = await w.dev.runDev({ action: "start_work", task: TASK, subject: "A different subject" });
  assert.equal(again.branch, "feature/TASK-2026-00021-first-name");
  assert.equal(again.state, "switched to the task's branch");
  // a colleague started TASK-2026-00022 on GitHub
  const other = path.join(w.top, "other");
  w.git(w.top, "clone", "-q", GITHUB_URL, other);
  w.git(other, "switch", "-q", "-c", "fix/TASK-2026-00022-margin");
  w.git(other, "push", "-q", "origin", "fix/TASK-2026-00022-margin");
  w.git(w.repo, "switch", "-q", "main");
  const remote = await w.dev.runDev({ action: "start_work", task: "TASK-2026-00022", subject: "Margin", kind: "fix" });
  assert.equal(remote.branch, "fix/TASK-2026-00022-margin");
  assert.equal(remote.state, "continued the task's branch from origin");
});

test("a base the repository's AGENTS.md names is used and remembered", async (t) => {
  const w = world(t);
  const other = path.join(w.top, "other");
  w.git(w.top, "clone", "-q", GITHUB_URL, other);
  w.git(other, "switch", "-q", "-c", "tbo-copilot");
  w.git(other, "push", "-q", "origin", "tbo-copilot");
  const r = await w.dev.runDev({ action: "start_work", task: TASK, subject: "x", base: "tbo-copilot" });
  assert.equal(r.base, "tbo-copilot");
  assert.equal(w.git(w.repo, "config", `branch.${r.branch}.tboBase`), "tbo-copilot");
});

// --- check, run_tests, job_status ------------------------------------------------------------

test("check runs what CI runs, on the branch's changes against its merge base, in the background", async (t) => {
  const w = world(t);
  await readyBranch(w);
  const started = await w.dev.runDev({ action: "check" });
  assert.equal(started.state, "running");
  const done = await finished(w.dev, started.job);
  assert.equal(done.state, "passed");
  assert.deepEqual(done.result.steps.map((s) => [s.name, s.status, s.fromCi]), [
    ["pre-commit", "passed", true],
    ["semgrep", "passed", true],
    ["commit titles", "passed", true],
  ]);
  const base = w.git(w.repo, "merge-base", "HEAD", "origin/main");
  const preCommit = w.calls.find((c) => c[0] === "uv" && c.includes("pre-commit"));
  assert.deepEqual(preCommit.slice(1, 5), ["tool", "run", "--from", PINS.preCommit]);
  assert.deepEqual(preCommit.slice(7, 11), ["--from-ref", base, "--to-ref", "HEAD"]);
  const semgrep = w.calls.find((c) => c[0] === "uv" && c.includes("semgrep"));
  assert.ok(semgrep.includes(PINS.semgrep));
  assert.ok(semgrep.includes(path.join(w.dataDir, "frappe-semgrep-rules", "rules")));
  assert.ok(semgrep.includes("r/python.lang.correctness"));
  assert.equal(semgrep[semgrep.indexOf("--baseline-commit") + 1], base);
  assert.ok(semgrep.includes("--metrics=off"));
  const last = await w.dev.runDev({ action: "job_status", job_kind: "check" });
  assert.equal(last.job, started.job);
});

test("a failing linter, a bad commit title or a formatter's fix fails the check", async (t) => {
  const w = world(t);
  await readyBranch(w, "Cap the discount");
  w.answers.semgrep = { code: 1, stdout: JSON.stringify({ results: [{ check_id: "frappe.frappe-manual-commit", path: "my_app/selling/discounts.py", start: { line: 2 }, extra: { message: "Manual commit" } }], errors: [] }) };
  const done = await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  assert.equal(done.state, "failed");
  const byName = Object.fromEntries(done.result.steps.map((s) => [s.name, s]));
  assert.match(byName.semgrep.detail, /my_app\/selling\/discounts\.py:2 frappe-manual-commit: Manual commit/);
  assert.match(byName["commit titles"].detail, /"Cap the discount": not "type\(scope\): summary"/);
});

test("check and run_tests need the task's branch and a commit, not loose changes", async (t) => {
  const w = world(t);
  await assert.rejects(w.dev.runDev({ action: "check" }), { code: "NOT_A_TASK_BRANCH" });
  await readyBranch(w);
  w.write(w.repo, "my_app/selling/discounts.py", "changed\n");
  await assert.rejects(w.dev.runDev({ action: "check" }), { code: "DIRTY" });
  await assert.rejects(w.dev.runDev({ action: "run_tests" }), { code: "DIRTY" });
});

test("run_tests runs the touched modules one by one on the bench's test site, never the whole suite", async (t) => {
  const w = world(t);
  await readyBranch(w);
  const done = await finished(w.dev, (await w.dev.runDev({ action: "run_tests" })).job);
  assert.equal(done.state, "passed");
  assert.deepEqual(done.result.results.map((r) => [r.module, r.status, r.detail]), [["my_app.selling.test_discounts", "passed", "3 test(s), OK"]]);
  const benchCalls = w.calls.filter((c) => c[0] === "bench");
  assert.deepEqual(benchCalls, [["bench", "--site", "dev.localhost", "run-tests", "--module", "my_app.selling.test_discounts"]]);
  assert.ok(!w.calls.some((c) => c[0] === "bench" && (c.includes("--app") || !c.includes("--module"))));
  await assert.rejects(w.dev.runDev({ action: "run_tests", modules: ["my_app.tests; rm -rf ~"] }), { code: "INVALID_ARGUMENT" });
});

test("a site with testing off says how to turn it on", async (t) => {
  const w = world(t);
  await readyBranch(w);
  w.answers.tests = { code: 1, stdout: "", stderr: "Testing is disabled for the site!" };
  const done = await finished(w.dev, (await w.dev.runDev({ action: "run_tests" })).job);
  assert.equal(done.state, "failed");
  assert.match(done.result.results[0].detail, /bench --site dev\.localhost set-config allow_tests true/);
});

// --- open_pr -----------------------------------------------------------------------------

async function checkedAndTested(w) {
  await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  await finished(w.dev, (await w.dev.runDev({ action: "run_tests" })).job);
}

const PR_ARGS = { action: "open_pr", summary: "cap the discount per tier", what_and_why: "Discounts were unlimited.", how_to_test: "1. Make an invoice with 40 % off." };

test("open_pr needs a passing check and the tests on the current commit", async (t) => {
  const w = world(t);
  await readyBranch(w);
  await assert.rejects(w.dev.runPr(PR_ARGS), { code: "NOT_CHECKED" });
  await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  await assert.rejects(w.dev.runPr(PR_ARGS), { code: "NOT_TESTED" });
  // a new commit after the check needs a new check
  w.commit("my_app/selling/discounts.py", "def cap(x):\n    return min(x, 20)\n", "fix(selling): raise the cap");
  await assert.rejects(w.dev.runPr({ ...PR_ARGS, no_tests_reason: "x" }), { code: "NOT_CHECKED" });
  assert.equal(w.calls.filter((c) => c[0] === "gh" && c[1] === "pr").length, 0);
  assert.throws(() => w.git(w.origin, "rev-parse", "--verify", "refs/heads/feature/TASK-2026-00021-cap-the-discount-per-tier"), "nothing was pushed");
});

test("open_pr pushes the branch, opens a draft with the task and the checks, marks it ready, asks the reviewers", async (t) => {
  const w = world(t, { settings: { reviewers: "lead-one, lead-two" } });
  await readyBranch(w);
  await checkedAndTested(w);
  const r = await w.dev.runPr(PR_ARGS);
  const branch = "feature/TASK-2026-00021-cap-the-discount-per-tier";
  assert.equal(r.pr, PR_URL);
  assert.equal(r.state, "opened");
  assert.equal(r.title, "TASK-2026-00021: cap the discount per tier");
  assert.equal(r.template, "TBO's template");
  assert.match(r.task_moves, /Pending Review/);
  assert.equal(w.git(w.origin, "rev-parse", `refs/heads/${branch}`), w.git(w.repo, "rev-parse", "HEAD"));
  const create = w.calls.find((c) => c[0] === "gh" && c[2] === "create");
  assert.deepEqual(create.slice(1, 12), ["pr", "create", "--repo", "tbocloud/my_app", "--draft", "--base", "main", "--head", branch, "--title", r.title]);
  const [body] = w.bodies;
  assert.match(body, /\nCloses TASK-2026-00021\n/);
  assert.match(body, /## What and why\n\nDiscounts were unlimited\./);
  assert.match(body, /- \[x\] Tests added or updated/);
  assert.match(body, /- tests `my_app\.selling\.test_discounts` on a local site: passed/);
  assert.ok(w.calls.some((c) => c[0] === "gh" && c[2] === "ready" && c[3] === PR_URL), "ready for review moves the task");
  assert.ok(w.calls.some((c) => c[0] === "gh" && c[2] === "edit" && c.includes("lead-one,lead-two")));
  neverForced(w.calls);
});

test("open_pr with no test that applies says why in the PR; a draft stays a draft", async (t) => {
  const w = world(t);
  await readyBranch(w, "docs: explain the cap");
  await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  const r = await w.dev.runPr({ ...PR_ARGS, no_tests_reason: "a comment only", draft: true, link: "Refs" });
  assert.equal(r.draft, true);
  assert.match(r.task_moves, /stays Working/);
  assert.match(w.bodies[0], /\nRefs TASK-2026-00021\n/);
  assert.match(w.bodies[0], /- tests: none run locally \(a comment only\)/);
  assert.ok(!w.calls.some((c) => c[0] === "gh" && c[2] === "ready"));
});

test("failed tests on the commit block the PR", async (t) => {
  const w = world(t);
  await readyBranch(w);
  w.answers.tests = { code: 1, stdout: "Ran 3 tests\n\nFAILED (failures=1)\n" };
  await checkedAndTested(w);
  await assert.rejects(w.dev.runPr(PR_ARGS), { code: "TESTS_FAILED" });
});

test("a branch that moved on GitHub is never overwritten, and no PR is opened", async (t) => {
  const w = world(t);
  await readyBranch(w);
  const branch = "feature/TASK-2026-00021-cap-the-discount-per-tier";
  const other = path.join(w.top, "other");
  w.git(w.top, "clone", "-q", GITHUB_URL, other);
  w.git(other, "switch", "-q", "-c", branch);
  fs.writeFileSync(path.join(other, "theirs.txt"), "theirs");
  w.git(other, "add", ".");
  w.git(other, "commit", "-q", "-m", "chore: theirs");
  w.git(other, "push", "-q", "origin", branch);
  const theirs = w.git(other, "rev-parse", "HEAD");
  await checkedAndTested(w);
  await assert.rejects(w.dev.runPr(PR_ARGS), { code: "PUSH_FAILED", message: /nothing was forced/ });
  assert.equal(w.git(w.origin, "rev-parse", `refs/heads/${branch}`), theirs);
  assert.ok(!w.calls.some((c) => c[0] === "gh" && c[2] === "create"));
  neverForced(w.calls);
});

test("an open PR for the branch gets the new commits instead of a second PR", async (t) => {
  const w = world(t);
  await readyBranch(w);
  await checkedAndTested(w);
  w.answers.prView = { code: 0, stdout: JSON.stringify({ url: PR_URL, state: "OPEN", isDraft: false }) };
  const r = await w.dev.runPr(PR_ARGS);
  assert.equal(r.pr, PR_URL);
  assert.match(r.state, /updated/);
  assert.ok(!w.calls.some((c) => c[0] === "gh" && c[2] === "create"));
});

test("shared branches are never pushed to, and a GitHub login is needed", async (t) => {
  const w = world(t);
  // a task number in a shared branch's name still does not make it a task branch to push
  w.git(w.repo, "switch", "-q", "-c", "develop");
  await assert.rejects(w.dev.runPr({ ...PR_ARGS, no_tests_reason: "x" }), { code: "NOT_A_TASK_BRANCH" });
  w.git(w.repo, "switch", "-q", "main");
  await readyBranch(w);
  await checkedAndTested(w);
  w.answers.ghAuth = { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." };
  await assert.rejects(w.dev.runPr(PR_ARGS), { code: "GH_LOGIN", message: /gh auth login/ });
  await assert.rejects(w.dev.runPr({ ...PR_ARGS, reviewers: ["not a login!"] }), { code: "INVALID_ARGUMENT" });
});

test("skip_hooks reaches pre-commit as SKIP and is kept in the result; a bad hook id is refused", async (t) => {
  const w = world(t);
  await readyBranch(w);
  await assert.rejects(w.dev.runDev({ action: "check", skip_hooks: ["prettier; rm"] }), { code: "INVALID_ARGUMENT" });
  let seen = null;
  const answer = w.answers.preCommit;
  w.answers.preCommit = answer;
  const done = await finished(w.dev, (await w.dev.runDev({ action: "check", skip_hooks: ["prettier"] })).job);
  seen = done.result.steps.find((s) => s.name === "pre-commit");
  assert.deepEqual(seen.skipped, ["prettier"]);
  assert.equal(done.state, "passed");
});

test("a clone made by bench get-app (its remote named upstream) works the same", async (t) => {
  const w = world(t);
  w.git(w.repo, "remote", "rename", "origin", "upstream");
  const s = await w.dev.runDev({ action: "status" });
  assert.equal(s.github, "tbocloud/my_app");
  assert.equal(s.default_branch, "main");
  const r = await w.dev.runDev({ action: "start_work", task: TASK, subject: "Cap the discount per tier" });
  assert.equal(r.state, "created");
  w.commit("my_app/selling/discounts.py", "def cap(x):\n    return min(x, 10)\n", "feat(selling): cap the discount per tier");
  await checkedAndTested(w);
  const pr = await w.dev.runPr(PR_ARGS);
  assert.equal(pr.pr, PR_URL);
  assert.equal(w.git(w.origin, "rev-parse", `refs/heads/${r.branch}`), w.git(w.repo, "rev-parse", "HEAD"));
  assert.ok(w.calls.some((c) => c[0] === "git" && c[1] === "push" && c.includes("upstream")));
  // two remotes and neither origin nor upstream: the tools ask which one
  w.git(w.repo, "remote", "rename", "upstream", "mine");
  w.git(w.repo, "remote", "add", "theirs", GITHUB_URL);
  await assert.rejects(w.dev.runDev({ action: "status" }), { code: "NO_REMOTE" });
});
