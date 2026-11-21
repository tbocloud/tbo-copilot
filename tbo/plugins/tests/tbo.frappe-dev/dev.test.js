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
  makeSite(bench, "dev.localhost");
  fs.mkdirSync(path.join(bench, "sites", "assets")); // in every bench, and not a site
  fs.writeFileSync(path.join(bench, "sites", "currentsite.txt"), "dev.localhost\n");
  // workspace "loose": a clone in no bench's apps/ folder
  const repo = workspace === "loose" ? path.join(top, "loose", "my_app") : path.join(bench, "apps", "my_app");
  git(top, "clone", "-q", GITHUB_URL, repo);

  const dataDir = path.join(top, "data");
  fs.mkdirSync(path.join(dataDir, "frappe-semgrep-rules", ".git"), { recursive: true }); // as if cloned today
  const uv = path.join(top, "uv");
  fs.writeFileSync(uv, "");

  const calls = [];
  const bodies = [];
  const benchRuns = []; // every bench call but list-apps: its arguments, folder and time limit
  const logs = []; // what the plugin logged
  const listApps = []; // the sites whose apps were listed (bench --site <site> list-apps)
  const installed = {}; // site -> its apps, for list-apps; default frappe and my_app
  const answers = {
    preCommit: { code: 0, stdout: "black....Passed\n" },
    semgrep: { code: 0, stdout: JSON.stringify({ results: [], errors: [] }) },
    tests: { code: 0, stdout: "Ran 3 tests in 0.2s\n\nOK\n" },
    bench: { code: 0, stdout: "Migrating dev.localhost\nExecuting `after_migrate` hooks...\n", stderr: "" },
    prView: { code: 1, stdout: "", stderr: "no pull requests found for branch" },
    ghAuth: { code: 0, stdout: "", stderr: "✓ Logged in to github.com account dev-user (keyring)" },
    prReady: { code: 0, stdout: "", stderr: "" },
  };
  // holdBench: a promise every bench call waits for, to keep a job running
  // holdListApps: a promise list-apps waits for, to keep a test site's check pending; holdListAppsFor:
  // the same for one site only ({ site: promise })
  const hooks = { beforeSemgrep: null, beforeAuth: null, beforePreCommit: null, holdBench: null, holdListApps: null, holdListAppsFor: {} };
  const runFn = async (cmd, args, opts) => {
    calls.push([cmd === uv ? "uv" : path.basename(cmd), ...args]);
    if (cmd === "git") return run(cmd, args, opts);
    if (cmd === uv) {
      if (args.includes("pre-commit")) {
        if (hooks.beforePreCommit) hooks.beforePreCommit();
        return answers.preCommit;
      }
      if (hooks.beforeSemgrep) hooks.beforeSemgrep();
      return answers.semgrep;
    }
    if (cmd === "bench" && args[2] === "list-apps") {
      listApps.push(args[1]);
      if (hooks.holdListApps) await hooks.holdListApps;
      if (hooks.holdListAppsFor[args[1]]) await hooks.holdListAppsFor[args[1]];
      const apps = installed[args[1]] || ["frappe", "my_app"];
      // as bench prints it: name, version, branch
      return { code: 0, stdout: apps.map((a) => `${a.padEnd(12)} 0.0.1    main`).join("\n") + "\n", stderr: "" };
    }
    if (cmd === "bench") {
      benchRuns.push({ args, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      if (hooks.holdBench) await hooks.holdBench;
      return args.includes("run-tests") ? { ...answers.tests, cwd: opts.cwd } : answers.bench;
    }
    if (cmd === "gh") {
      const [a, b] = args;
      if (a === "auth") {
        if (hooks.beforeAuth) hooks.beforeAuth();
        return answers.ghAuth;
      }
      if (a === "pr" && b === "view") return answers.prView;
      if (a === "pr" && b === "create") {
        bodies.push(fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8"));
        return { code: 0, stdout: `Creating pull request\n${PR_URL}\n`, stderr: "" };
      }
      if (a === "pr" && b === "edit" && args.includes("--body-file")) bodies.push(fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8"));
      if (a === "pr" && b === "ready") return answers.prReady;
      return { code: 0, stdout: "", stderr: "" };
    }
    throw Object.assign(new Error(`${cmd} missing`), { code: "MISSING" });
  };
  // a new createDev is the app started again: only the data folder carries over
  const makeDev = () =>
    createDev({
      getSettings: async () => ({ uvPath: uv, ...settings }),
      getDataPath: async () => dataDir,
      getWorkspace: async () => ({ path: workspace === "bench" ? bench : repo, name: "my_app" }),
      runFn,
      env,
      log: (message) => logs.push(message),
    });
  const dev = makeDev();
  const commit = (rel, text, message) => {
    write(repo, rel, text);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", message);
    return git(repo, "rev-parse", "HEAD");
  };
  return { dev, makeDev, repo, origin, bench, top, git, write, commit, calls, bodies, benchRuns, listApps, installed, logs, answers, hooks, env, dataDir };
}

// A site of the bench: its folder with its site_config.json, tests on unless `tests` is false.
function makeSite(bench, name, { tests = true } = {}) {
  fs.mkdirSync(path.join(bench, "sites", name), { recursive: true });
  fs.writeFileSync(path.join(bench, "sites", name, "site_config.json"), tests ? '{"allow_tests": true}\n' : "{}\n");
}

// `repo`: needed when the workspace is the bench folder, not the repository
async function finished(dev, job, repo) {
  for (let i = 0; i < 200; i += 1) {
    const s = await dev.runDev({ action: "job_status", job, ...(repo ? { repo } : {}) });
    if (s.state !== "running") return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${job} never finished`);
}

async function waitUntil(check) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("never happened");
}

const neverForced = (calls) => {
  for (const c of calls) {
    const push = c[0] === "git" && c[1] === "push";
    assert.ok(!c.some((a) => a === "--force" || a === "-f" || a === "--no-verify" || String(a).startsWith("--force-with-lease") || (push && String(a).startsWith("+"))), c.join(" "));
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
  // bench changes the dev bench: the app asks first (risk medium), and Plan mode never runs it
  assert.ok(DEV_TOOL.schema.properties.action.enum.includes("bench"));
  assert.equal(DEV_TOOL.risk, "medium");
  assert.ok(!DEV_TOOL.planSafeActions.includes("bench"));
  assert.deepEqual([...manifest.permissions].sort(), ["agent.prompt.inject", "agent.tool.register"]);
  assert.equal(manifest.net, undefined, "the plugin itself reaches no network");
  // every skill in the folder is declared, once
  const skillFiles = fs.readdirSync(path.join(__dirname, "../../tbo.frappe-dev/skills")).filter((f) => f.endsWith(".md"));
  assert.deepEqual([...manifest.contributes.skills].sort(), skillFiles.map((f) => `skills/${f}`).sort());
  assert.equal(manifest.contributes.skills.length, 12);
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
  const head = w.git(w.repo, "rev-parse", "HEAD");
  const preCommit = w.calls.find((c) => c[0] === "uv" && c.includes("pre-commit"));
  assert.deepEqual(preCommit.slice(1, 5), ["tool", "run", "--from", PINS.preCommit]);
  // the commit the check is for, not whatever HEAD becomes while it runs
  assert.deepEqual(preCommit.slice(7, 11), ["--from-ref", base, "--to-ref", head]);
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

test("a formatter's fix fails the check with its report, not as a stale result", async (t) => {
  const w = world(t);
  await readyBranch(w);
  w.answers.preCommit = { code: 1, stdout: "black....Failed\n- files were modified by this hook\n", stderr: "" };
  w.hooks.beforePreCommit = () => w.write(w.repo, "my_app/selling/discounts.py", "def cap(x):\n    return x  # formatted\n");
  const done = await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  assert.equal(done.state, "failed", done.error);
  assert.equal(done.error, undefined);
  assert.ok(done.result.steps.some((s) => /pre-commit fixed 1 file\(s\)/.test(s.detail || "")), JSON.stringify(done.result.steps));
});

test("a pass on a tree that changed while the check ran is thrown away", async (t) => {
  const w = world(t);
  await readyBranch(w);
  w.hooks.beforeSemgrep = () => w.write(w.repo, "my_app/selling/discounts.py", "changed while checking\n");
  const done = await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  assert.equal(done.state, "stale");
  assert.match(done.error, /Files changed while this ran/);
});

test("start_work fetches the base into its tracking ref, also in a single-branch clone (bench get-app)", async (t) => {
  const w = world(t);
  // a second branch on GitHub, and the app cloned with one branch only, as bench get-app --branch does
  const seed = path.join(w.top, "seed");
  w.git(seed, "switch", "-q", "-c", "develop");
  w.write(seed, "my_app/develop.txt", "develop\n");
  w.git(seed, "add", ".");
  w.git(seed, "commit", "-q", "-m", "chore: develop");
  w.git(seed, "push", "-q", "origin", "develop");
  fs.rmSync(w.repo, { recursive: true, force: true });
  w.git(w.top, "clone", "-q", "--single-branch", "--branch", "main", GITHUB_URL, w.repo);
  assert.throws(() => w.git(w.repo, "rev-parse", "--verify", "--quiet", "origin/develop"));
  const r = await w.dev.runDev({ action: "start_work", task: TASK, subject: "Cap the discount", kind: "feature", base: "develop" });
  assert.equal(r.state, "created");
  assert.equal(w.git(w.repo, "rev-parse", "HEAD"), w.git(w.repo, "rev-parse", "origin/develop"));
  neverForced(w.calls);
});

test("start_work resumes the task's branch from GitHub in a single-branch clone, with tracking", async (t) => {
  const w = world(t);
  const seed = path.join(w.top, "seed");
  const branch = "feature/TASK-2026-00021-cap-the-discount";
  w.git(seed, "switch", "-q", "-c", branch);
  w.write(seed, "my_app/selling/discounts.py", "def cap(x):\n    return min(x, 10)\n");
  w.git(seed, "add", ".");
  w.git(seed, "commit", "-q", "-m", "feat(selling): cap the discount");
  w.git(seed, "push", "-q", "origin", branch);
  fs.rmSync(w.repo, { recursive: true, force: true });
  w.git(w.top, "clone", "-q", "--single-branch", "--branch", "main", GITHUB_URL, w.repo);
  const r = await w.dev.runDev({ action: "start_work", task: TASK, subject: "Cap the discount" });
  assert.equal(r.state, "continued the task's branch from origin");
  assert.equal(w.git(w.repo, "branch", "--show-current"), branch);
  assert.equal(w.git(w.repo, "rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${branch}`);
  neverForced(w.calls);
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
  const benchCalls = w.calls.filter((c) => c[0] === "bench" && c[3] !== "list-apps");
  assert.deepEqual(benchCalls, [["bench", "--site", "dev.localhost", "run-tests", "--module", "my_app.selling.test_discounts"]]);
  assert.ok(!w.calls.some((c) => c[0] === "bench" && c[3] !== "list-apps" && (c.includes("--app") || !c.includes("--module"))));
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

// --- bench -------------------------------------------------------------------------------

const benchArgs = (w) => w.benchRuns.map((r) => r.args);

test("bench migrate runs bench --site <test site> migrate in the bench folder, in the background, on any branch", async (t) => {
  const w = world(t);
  // not a task branch, and a DocType's JSON not committed yet: migrate runs on the tree as it is
  w.write(w.repo, "my_app/selling/doctype/tier/tier.json", "{}\n");
  const started = await w.dev.runDev({ action: "bench", command: "migrate" });
  assert.equal(started.state, "running");
  assert.equal(started.kind, "bench");
  assert.equal(started.command, "bench --site dev.localhost migrate");
  assert.equal(started.commit, undefined, "a bench job belongs to no commit");
  const done = await finished(w.dev, started.job);
  assert.equal(done.state, "passed", done.error);
  assert.equal(done.result.site, "dev.localhost");
  assert.deepEqual(benchArgs(w), [["--site", "dev.localhost", "migrate"]]);
  assert.equal(w.benchRuns[0].cwd, w.bench);
  assert.equal(w.benchRuns[0].timeoutMs, 20 * 60000);
  assert.equal((await w.dev.runDev({ action: "job_status", job_kind: "bench" })).job, started.job);
  assert.equal((await w.dev.runDev({ action: "status" })).last_bench.job, started.job);
  // another site of the bench, named in the call
  makeSite(w.bench, "second.localhost");
  await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "migrate", site: "second.localhost" })).job);
  assert.deepEqual(benchArgs(w)[1], ["--site", "second.localhost", "migrate"]);
  // the test site from the settings
  const w2 = world(t, { settings: { testSite: "second.localhost" } });
  makeSite(w2.bench, "second.localhost");
  await finished(w2.dev, (await w2.dev.runDev({ action: "bench", command: "migrate" })).job);
  assert.deepEqual(benchArgs(w2), [["--site", "second.localhost", "migrate"]]);
});

test("bench refuses a site that is not in the bench, and every command but migrate, build and clear_cache", async (t) => {
  const w = world(t);
  for (const site of ["live.example.com", "all", "assets", "../dev.localhost", "dev.localhost/../x"]) {
    await assert.rejects(w.dev.runDev({ action: "bench", command: "migrate", site }), { code: "NO_SITE" }, site);
  }
  const commands = ["console", "drop-site", "reinstall", "restore", "backup", "execute", "run-tests", "migrate --force", "--force", "clear-cache"];
  for (const command of [...commands, "", undefined, "constructor", "__proto__", "toString"]) {
    await assert.rejects(w.dev.runDev({ action: "bench", command }), { code: "INVALID_ARGUMENT", message: /only migrate, build, clear_cache/ }, String(command));
  }
  assert.deepEqual(w.benchRuns, [], "nothing ran");
});

test("bench build builds every app or one app of the bench; clear_cache clears a site's cache", async (t) => {
  const w = world(t);
  assert.equal((await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "build" })).job)).state, "passed");
  const one = await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "build", app: "my_app" })).job);
  assert.equal(one.result.app, "my_app");
  await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "clear_cache" })).job);
  assert.deepEqual(benchArgs(w), [["build"], ["build", "--app", "my_app"], ["--site", "dev.localhost", "clear-cache"]]);
  assert.equal(w.benchRuns[2].timeoutMs, 5 * 60000);
  await assert.rejects(w.dev.runDev({ action: "bench", command: "build", app: "erpnext" }), { code: "INVALID_ARGUMENT", message: /not an app/ });
  await assert.rejects(w.dev.runDev({ action: "bench", command: "build", site: "dev.localhost" }), { code: "INVALID_ARGUMENT", message: /takes no site/ });
  await assert.rejects(w.dev.runDev({ action: "bench", command: "migrate", app: "my_app" }), { code: "INVALID_ARGUMENT", message: /takes no app/ });
  assert.equal(w.benchRuns.length, 3);
});

test("nothing destructive reaches bench through the bench action's arguments", async (t) => {
  const w = world(t);
  const attempts = [
    { command: "migrate", site: "--force" },
    { command: "migrate", site: "dev.localhost --force" },
    { command: "migrate", site: "dev.localhost; bench drop-site dev.localhost" },
    { command: "migrate", site: "-h" },
    { command: "clear_cache", site: "--site" },
    { command: "build", app: "--force" },
    { command: "build", app: "my_app --force" },
    { command: "build", app: "-f" },
    { command: "build", app: "../frappe" },
    { command: "migrate --skip-failing" },
    { command: ["migrate", "--force"] },
  ];
  for (const args of attempts) {
    await assert.rejects(w.dev.runDev({ action: "bench", ...args }), (e) => ["INVALID_ARGUMENT", "NO_SITE"].includes(e.code), JSON.stringify(args));
  }
  assert.deepEqual(w.benchRuns, []);
  // what is not a parameter of the action never reaches bench
  const done = await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "migrate", args: ["--force"], options: "--skip-failing", flags: ["drop-site"], modules: ["--force"] })).job);
  assert.equal(done.state, "passed");
  assert.deepEqual(benchArgs(w), [["--site", "dev.localhost", "migrate"]]);
  for (const a of benchArgs(w).flat()) assert.doesNotMatch(a, /^-f$|--force|--skip-failing|console|drop-site|reinstall|restore/);
});

test("a failed migrate fails the job with its output; a traceback or a time-out fails it too", async (t) => {
  const w = world(t);
  w.answers.bench = { code: 1, stdout: "Migrating dev.localhost\nTraceback (most recent call last):\nfrappe.exceptions.ValidationError: Tier is mandatory\n", stderr: "" };
  let job = await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "migrate" })).job);
  assert.equal(job.state, "failed");
  assert.equal(job.result.detail, "exit code 1");
  assert.match(job.result.output, /ValidationError: Tier is mandatory/);
  w.answers.bench = { code: 0, stdout: "Traceback (most recent call last):\nKeyError: 'tier'\n", stderr: "" };
  job = await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "migrate" })).job);
  assert.equal(job.state, "failed");
  assert.match(job.result.detail, /traceback/);
  w.answers.bench = { code: null, stdout: "", stderr: "", timedOut: true };
  job = await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "build" })).job);
  assert.equal(job.state, "failed");
  assert.match(job.result.detail, /longer than 20 minutes/);
});

test("one job at a time on a bench: no migrate under running tests, no tests under a migrate; a commit meanwhile keeps a bench result", async (t) => {
  const w = world(t);
  await readyBranch(w);
  let release;
  w.hooks.holdBench = new Promise((r) => {
    release = r;
  });
  const migrate = await w.dev.runDev({ action: "bench", command: "migrate" });
  assert.equal(migrate.state, "running");
  await assert.rejects(w.dev.runDev({ action: "bench", command: "build" }), { code: "BUSY", message: /bench --site dev\.localhost migrate/ });
  await assert.rejects(w.dev.runDev({ action: "run_tests" }), { code: "BUSY" });
  w.commit("my_app/selling/discounts.py", "def cap(x):\n    return min(x, 20)\n", "fix(selling): raise the cap");
  w.hooks.holdBench = null;
  release();
  assert.equal((await finished(w.dev, migrate.job)).state, "passed", "a bench job belongs to no commit, so it is never stale");
  w.hooks.holdBench = new Promise((r) => {
    release = r;
  });
  const tests = await w.dev.runDev({ action: "run_tests" });
  assert.equal(tests.state, "running");
  await assert.rejects(w.dev.runDev({ action: "bench", command: "migrate" }), { code: "BUSY", message: /run_tests/ });
  w.hooks.holdBench = null;
  release();
  await finished(w.dev, tests.job);
  assert.equal((await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "migrate" })).job)).state, "passed");
});

test("a running bench job stays in the history however many jobs finish after it", async (t) => {
  // CodeRabbit on #29: an evicted running migrate let a second bench job start on the same bench
  const w = world(t);
  await readyBranch(w);
  let release;
  w.hooks.holdBench = new Promise((r) => {
    release = r;
  });
  const migrate = await w.dev.runDev({ action: "bench", command: "migrate" });
  assert.equal(migrate.state, "running");
  for (let i = 0; i < 25; i += 1) await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  await assert.rejects(w.dev.runDev({ action: "bench", command: "build" }), { code: "BUSY", message: /migrate/ });
  w.hooks.holdBench = null;
  release();
  assert.equal((await finished(w.dev, migrate.job)).state, "passed");
});

test("tests from two repositories on one bench run one at a time; the same repository gets its running job back", async (t) => {
  // CodeRabbit on #29: run_tests checked only for bench jobs, so another repository's tests could share the test site
  const w = world(t, { workspace: "bench" });
  w.git(w.top, "clone", "-q", GITHUB_URL, path.join(w.bench, "apps", "other_app"));
  w.installed["dev.localhost"] = ["frappe", "my_app", "other_app"];
  for (const repo of ["apps/my_app", "apps/other_app"]) {
    await w.dev.runDev({ action: "start_work", repo, task: TASK, subject: "Cap the discount per tier" });
    const root = path.join(w.bench, repo);
    w.write(root, "my_app/selling/discounts.py", "def cap(x):\n    return min(x, 10)\n");
    w.git(root, "add", ".");
    w.git(root, "commit", "-q", "-m", "feat(selling): cap the discount per tier");
  }
  let release;
  w.hooks.holdBench = new Promise((r) => {
    release = r;
  });
  const first = await w.dev.runDev({ action: "run_tests", repo: "apps/my_app" });
  assert.equal(first.state, "running");
  await assert.rejects(w.dev.runDev({ action: "run_tests", repo: "apps/other_app" }), { code: "BUSY", message: /run_tests/ });
  const again = await w.dev.runDev({ action: "run_tests", repo: "apps/my_app" });
  assert.equal(again.job, first.job);
  w.hooks.holdBench = null;
  release();
  assert.equal((await finished(w.dev, first.job, "apps/my_app")).state, "passed");
  const second = await w.dev.runDev({ action: "run_tests", repo: "apps/other_app" });
  assert.equal((await finished(w.dev, second.job, "apps/other_app")).state, "passed");
});

test("one bench reached two ways is one bench: a link or a trailing slash does not let a job start beside a migrate", async (t) => {
  // CodeRabbit on #29: the bench's path was compared as written, so a second path to it was a second bench
  const settings = {};
  const w = world(t, { settings });
  await readyBranch(w);
  let release;
  w.hooks.holdBench = new Promise((r) => {
    release = r;
  });
  const migrate = await w.dev.runDev({ action: "bench", command: "migrate" });
  assert.equal(migrate.state, "running");
  const link = path.join(w.top, "bench-link");
  fs.symlinkSync(w.bench, link);
  for (const benchPath of [link, `${w.bench}${path.sep}`, link + path.sep]) {
    settings.benchPath = benchPath;
    await assert.rejects(w.dev.runDev({ action: "bench", command: "build" }), { code: "BUSY", message: /migrate/ }, benchPath);
    await assert.rejects(w.dev.runDev({ action: "run_tests" }), { code: "BUSY" }, benchPath);
  }
  w.hooks.holdBench = null;
  release();
  assert.equal((await finished(w.dev, migrate.job)).state, "passed");
  // once it is done, the same linked path starts a job, and the job runs in the bench's real path
  settings.benchPath = link;
  const build = await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "build" })).job);
  assert.equal(build.state, "passed");
  assert.equal(w.benchRuns.at(-1).cwd, fs.realpathSync(w.bench));
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
  for (const bad of ["not a login!", "lead-", "-lead", "le--ad", "x".repeat(40)]) {
    await assert.rejects(w.dev.runPr({ ...PR_ARGS, reviewers: [bad] }), { code: "INVALID_ARGUMENT" }, bad);
  }
});

const PRETTIER_INSTALL_FAILS = {
  code: 3,
  stdout: "[INFO] Installing environment for https://github.com/pre-commit/mirrors-prettier.\nAn unexpected error has occurred: CalledProcessError: npm install\n    npm error code EALLOWGIT\n",
};
const PRE_COMMIT_CONFIG = [
  "repos:",
  "  - repo: https://github.com/psf/black",
  "    rev: 22.6.0",
  "    hooks:",
  "      - id: black",
  "  - repo: https://github.com/pre-commit/mirrors-prettier",
  "    rev: v2.6.2",
  "    hooks:",
  "      - id: prettier",
  "        types_or: [javascript, vue, html]",
  "",
].join("\n");

test("a hook is skipped only after its install failed on this commit, and only when it checks no changed file", async (t) => {
  const w = world(t);
  await readyBranch(w);
  w.commit(".pre-commit-config.yaml", PRE_COMMIT_CONFIG, "chore: name the hooks");
  await assert.rejects(w.dev.runDev({ action: "check", skip_hooks: ["prettier; rm"] }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(w.dev.runDev({ action: "check", skip_hooks: ["prettier"] }), { code: "SKIP_REFUSED", message: /only after a check on this commit/ });
  w.answers.preCommit = PRETTIER_INSTALL_FAILS;
  const failed = await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  const step = failed.result.steps.find((x) => x.name === "pre-commit");
  assert.equal(step.installError, true);
  assert.deepEqual(step.failedHooks, ["prettier"]);
  // black did not fail to install, so it is never skipped
  await assert.rejects(w.dev.runDev({ action: "check", skip_hooks: ["black"] }), { code: "SKIP_REFUSED" });
  w.answers.preCommit = { code: 0, stdout: "black....Passed\nprettier....Skipped\n" };
  const done = await finished(w.dev, (await w.dev.runDev({ action: "check", skip_hooks: ["prettier"] })).job);
  assert.equal(done.state, "passed");
  assert.deepEqual(done.result.steps.find((x) => x.name === "pre-commit").skipped, ["prettier"]);
  // a change prettier checks: the skip is refused
  w.commit("my_app/public/js/cap.js", "export const cap = 10;\n", "feat(selling): show the cap");
  w.answers.preCommit = PRETTIER_INSTALL_FAILS;
  await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  await assert.rejects(w.dev.runDev({ action: "check", skip_hooks: ["prettier"] }), { code: "SKIP_REFUSED", message: /checks my_app\/public\/js\/cap\.js/ });
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

test("a folder named like ..something inside the workspace is still inside it", async (t) => {
  const w = world(t, { workspace: "bench" });
  fs.mkdirSync(path.join(w.bench, "..apps"), { recursive: true });
  await assert.rejects(w.dev.runDev({ action: "status", repo: "..apps" }), { code: "NOT_A_REPO" });
});

test("two checks at once download Frappe's rules once", async (t) => {
  const { createLint } = require("../../tbo.frappe-dev/lib/lint");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tbo-dev-rules-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let clones = 0;
  const runFn = async (cmd, args) => {
    if (cmd === "git" && args[0] === "clone") {
      clones += 1;
      await new Promise((r) => setTimeout(r, 50));
      fs.mkdirSync(path.join(args.at(-1), ".git"), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify({ results: [], errors: [] }), stderr: "" };
  };
  const git = { mergeBase: async () => "abc", changedFiles: async () => [], commitsSince: async () => [], out: async () => "" };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tbo-dev-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "my_app"));
  fs.writeFileSync(path.join(root, "my_app", "hooks.py"), "");
  const lint = createLint({ git, runFn, env: process.env, uv: "uv", dataDir });
  const [a, b] = await Promise.all([lint.check(root, "main"), lint.check(root, "main")]);
  assert.equal(clones, 1);
  assert.equal(a.passed && b.passed, true);
});

test("a new check replaces an earlier pass: the latest result on the commit is the one that counts", async (t) => {
  const w = world(t);
  await readyBranch(w);
  await checkedAndTested(w);
  w.answers.semgrep = { code: 0, stdout: JSON.stringify({ results: [{ check_id: "x.frappe-manual-commit", path: "a.py", start: { line: 1 }, extra: { message: "m" } }], errors: [] }) };
  const second = await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  assert.equal(second.state, "failed");
  await assert.rejects(w.dev.runPr(PR_ARGS), { code: "NOT_CHECKED", message: /latest check on this commit .* failed/ });
});

test("a result is thrown away when the branch moves while the job runs", async (t) => {
  const w = world(t);
  await readyBranch(w);
  w.hooks.beforeSemgrep = () => {
    w.hooks.beforeSemgrep = null;
    w.commit("my_app/selling/discounts.py", "def cap(x):\n    return min(x, 30)\n", "fix(selling): another cap");
  };
  const job = await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  assert.equal(job.state, "stale");
  assert.match(job.error, /run it again/);
  await assert.rejects(w.dev.runPr({ ...PR_ARGS, no_tests_reason: "x" }), { code: "NOT_CHECKED" });
});

test("open_pr pushes the commit that passed the checks, even if another commit lands meanwhile", async (t) => {
  const w = world(t);
  await readyBranch(w);
  await checkedAndTested(w);
  const checked = w.git(w.repo, "rev-parse", "HEAD");
  w.hooks.beforeAuth = () => {
    w.hooks.beforeAuth = null;
    w.commit("my_app/selling/discounts.py", "unchecked = True\n", "feat(selling): not checked");
  };
  const r = await w.dev.runPr(PR_ARGS);
  assert.equal(r.commit, checked);
  assert.equal(w.git(w.origin, "rev-parse", "refs/heads/feature/TASK-2026-00021-cap-the-discount-per-tier"), checked);
  neverForced(w.calls);
});

test("an open PR gets the new title and description, and Refs stays Refs", async (t) => {
  const w = world(t);
  await readyBranch(w);
  await checkedAndTested(w);
  w.answers.prView = { code: 0, stdout: JSON.stringify({ url: PR_URL, state: "OPEN", isDraft: false }) };
  const r = await w.dev.runPr({ ...PR_ARGS, link: "Refs" });
  const edit = w.calls.find((c) => c[0] === "gh" && c[2] === "edit" && c.includes("--title"));
  assert.ok(edit, "the PR's title and body are rewritten");
  assert.equal(edit[edit.indexOf("--title") + 1], "TASK-2026-00021: cap the discount per tier");
  assert.match(w.bodies.at(-1), /\nRefs TASK-2026-00021\n/);
  assert.equal(r.draft, false);
  assert.ok(!w.calls.some((c) => c[0] === "gh" && c[2] === "ready"), "an open, ready PR is not marked ready again");
});

test("a PR that could not be marked ready is reported as a draft, with a warning", async (t) => {
  const w = world(t);
  await readyBranch(w);
  await checkedAndTested(w);
  w.answers.prReady = { code: 1, stdout: "", stderr: "GraphQL: something went wrong" };
  const r = await w.dev.runPr(PR_ARGS);
  assert.equal(r.draft, true);
  assert.match(r.warnings[0], /still a draft/);
  assert.match(r.task_moves, /stays Working/);
});

test("Semgrep passes only when it finished cleanly", async (t) => {
  const w = world(t);
  await readyBranch(w);
  w.answers.semgrep = { code: 2, stdout: JSON.stringify({ results: [], errors: [] }), stderr: "boom" };
  let job = await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  assert.match(job.result.steps.find((x) => x.name === "semgrep").detail, /exit code 2/);
  w.answers.semgrep = { code: 0, stdout: JSON.stringify({ results: [], errors: [{ level: "error", message: "Invalid rule schema" }] }) };
  job = await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  assert.match(job.result.steps.find((x) => x.name === "semgrep").detail, /1 error\(s\):\nInvalid rule schema/);
  w.answers.semgrep = { code: 0, stdout: JSON.stringify({ results: [], errors: [{ level: "warn", message: "Syntax error in a.py" }] }) };
  job = await finished(w.dev, (await w.dev.runDev({ action: "check" })).job);
  assert.equal(job.result.steps.find((x) => x.name === "semgrep").status, "passed");
});

test("a test module passes only when its tests ran to the end with OK", async (t) => {
  const w = world(t);
  await readyBranch(w);
  for (const [stdout, detail] of [
    ["Testing is disabled for the site!\n", /allow_tests true/],
    ["Ran 3 tests in 0.2s\n\nFAILED (failures=1)\n", /failures=1/],
    ["Ran 0 tests in 0.0s\n\nOK\n", /no test ran/],
  ]) {
    w.answers.tests = { code: 0, stdout };
    const job = await finished(w.dev, (await w.dev.runDev({ action: "run_tests" })).job);
    assert.equal(job.state, "failed", stdout);
    assert.match(job.result.results[0].detail, detail);
  }
});

test("a configured bench must hold this checkout in its apps/ folder", async (t) => {
  const w = world(t, { settings: { benchPath: "" } });
  const other = path.join(w.top, "other-bench");
  fs.mkdirSync(path.join(other, "apps", "frappe"), { recursive: true });
  makeSite(other, "dev.localhost");
  // a clone in no bench: a listed bench that does not hold it is never used
  const loose = world(t, { settings: { benchPath: other }, workspace: "loose" });
  await readyBranch(loose);
  await assert.rejects(loose.dev.runDev({ action: "run_tests" }), { code: "NO_BENCH", message: /does not hold it/ });
  // the same checkout linked into the bench's apps/ is one of them
  fs.symlinkSync(loose.repo, path.join(other, "apps", "my_app"));
  fs.writeFileSync(path.join(other, "sites", "currentsite.txt"), "dev.localhost\n");
  const job = await loose.dev.runDev({ action: "run_tests" });
  assert.ok(job.job);
  await finished(loose.dev, job.job);
  assert.equal(loose.benchRuns.at(-1).cwd, fs.realpathSync(other));
  // another checkout is not: a clone in its own bench runs on that bench, never on the listed one
  const third = world(t, { settings: { benchPath: other } });
  await readyBranch(third);
  await finished(third.dev, (await third.dev.runDev({ action: "run_tests" })).job);
  assert.equal(third.benchRuns.at(-1).cwd, third.bench);
});

// --- the test site for each project (testing fixes 8) --------------------------------------

const testRunSite = (w) => w.benchRuns.filter((r) => r.args.includes("run-tests")).map((r) => [r.args[1], r.cwd]);

test("projects on two benches each run on the listed test site of their own bench", async (t) => {
  const settings = { testSite: "alpha.localhost, beta.localhost" };
  const a = world(t, { settings });
  const b = world(t, { settings });
  makeSite(a.bench, "alpha.localhost");
  makeSite(b.bench, "beta.localhost");
  // no default site: only the list decides
  for (const w of [a, b]) fs.rmSync(path.join(w.bench, "sites", "currentsite.txt"));
  // both benches in the one setting too
  settings.benchPath = `${a.bench}, ${b.bench}`;
  for (const [w, site] of [
    [a, "alpha.localhost"],
    [b, "beta.localhost"],
  ]) {
    const s = await w.dev.runDev({ action: "status" });
    assert.equal(s.bench, w.bench);
    assert.equal(s.test_site, site);
    assert.equal(s.test_site_from, "from your Test site list");
    await readyBranch(w);
    const started = await w.dev.runDev({ action: "run_tests" });
    assert.equal(started.test_site, site);
    await finished(w.dev, started.job);
    assert.deepEqual(testRunSite(w), [[site, w.bench]]);
    // the other bench's site is never asked about; the choice is checked once
    assert.deepEqual(w.listApps, [site]);
  }
});

test("two apps on one bench each get a listed site that has their own app", async (t) => {
  const w = world(t, { workspace: "bench", settings: { testSite: "first.localhost, second.localhost" } });
  w.git(w.top, "clone", "-q", GITHUB_URL, path.join(w.bench, "apps", "other_app"));
  makeSite(w.bench, "first.localhost");
  makeSite(w.bench, "second.localhost");
  w.installed["first.localhost"] = ["frappe", "other_app"];
  w.installed["second.localhost"] = ["frappe", "erpnext", "my_app"];
  assert.equal((await w.dev.runDev({ action: "status", repo: "apps/my_app" })).test_site, "second.localhost");
  assert.equal((await w.dev.runDev({ action: "status", repo: "apps/other_app" })).test_site, "first.localhost");
});

test("a site with tests off or without the app is passed over and named, with what fixes it", async (t) => {
  const settings = { testSite: "elsewhere.localhost, off.localhost, bare.localhost" };
  const w = world(t, { settings });
  makeSite(w.bench, "off.localhost", { tests: false });
  makeSite(w.bench, "bare.localhost");
  w.installed["bare.localhost"] = ["frappe"];
  w.installed["dev.localhost"] = ["frappe", "erpnext"];
  await readyBranch(w);
  const reasons = [
    /elsewhere\.localhost: not on this bench/,
    /off\.localhost: tests are off \(bench --site off\.localhost set-config allow_tests true\)/,
    /bare\.localhost: my_app is not installed \(bench --site bare\.localhost install-app my_app\)/,
    /dev\.localhost: my_app is not installed/,
  ];
  for (const why of reasons) await assert.rejects(w.dev.runDev({ action: "run_tests" }), { code: "NO_SITE", message: why });
  assert.deepEqual(testRunSite(w), [], "no test ran on a site that does not fit");
  // status does not stop: it says why
  const s = await w.dev.runDev({ action: "status" });
  assert.equal(s.test_site, null);
  for (const why of reasons) assert.match(s.bench_problem, why);
  assert.ok(!w.listApps.includes("elsewhere.localhost"), "a site of another bench gets no bench call");
  // migrate without a site needs the project's test site; with one named it runs there, as before
  await assert.rejects(w.dev.runDev({ action: "bench", command: "migrate" }), { code: "NO_SITE" });
  await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "migrate", site: "dev.localhost" })).job);
  assert.deepEqual(benchArgs(w), [["--site", "dev.localhost", "migrate"]]);
  // allow_tests in the bench's common config counts, as Frappe reads it
  fs.writeFileSync(path.join(w.bench, "sites", "common_site_config.json"), '{"allow_tests": true}\n');
  const after = await w.dev.runDev({ action: "status" });
  assert.equal(after.test_site, "off.localhost");
  assert.equal(after.bench_problem, undefined);
});

test("the test site is remembered for the project, also after a restart, until the list changes or the site is gone", async (t) => {
  const settings = { testSite: "first.localhost, second.localhost" };
  const w = world(t, { settings });
  makeSite(w.bench, "first.localhost");
  makeSite(w.bench, "second.localhost");
  w.installed["first.localhost"] = ["frappe"];
  assert.equal((await w.dev.runDev({ action: "status" })).test_site, "second.localhost");
  assert.deepEqual(w.listApps, ["first.localhost", "second.localhost"]);
  assert.ok(fs.existsSync(path.join(w.dataDir, "test-sites.json")));
  // the app started again: no new check
  const again = await w.makeDev().runDev({ action: "status" });
  assert.equal(again.test_site, "second.localhost");
  assert.equal(again.test_site_from, "from your Test site list (remembered for this project)");
  assert.equal(w.listApps.length, 2);
  // a changed list chooses again
  makeSite(w.bench, "third.localhost");
  settings.testSite = "third.localhost, second.localhost";
  assert.equal((await w.makeDev().runDev({ action: "status" })).test_site, "third.localhost");
  assert.equal(w.listApps.at(-1), "third.localhost");
  // a site that is gone is dropped, with a note
  fs.rmSync(path.join(w.bench, "sites", "third.localhost"), { recursive: true });
  const gone = await w.dev.runDev({ action: "status" });
  assert.equal(gone.test_site, "second.localhost");
  assert.match(gone.test_site_note, /third\.localhost, the test site before, is no longer a site of this bench/);
});

test("the developer chooses a project's test site: checked, then remembered; migrate follows it", async (t) => {
  const w = world(t);
  makeSite(w.bench, "second.localhost");
  makeSite(w.bench, "bare.localhost");
  w.installed["bare.localhost"] = ["frappe"];
  await readyBranch(w);
  const started = await w.dev.runDev({ action: "run_tests", site: "second.localhost" });
  assert.equal(started.test_site, "second.localhost");
  assert.equal(started.test_site_from, "chosen for this project");
  await finished(w.dev, started.job);
  // later calls without a site, and the app started again
  await finished(w.dev, (await w.dev.runDev({ action: "run_tests" })).job);
  assert.deepEqual(
    testRunSite(w).map(([site]) => site),
    ["second.localhost", "second.localhost"],
  );
  const s = await w.makeDev().runDev({ action: "status" });
  assert.equal(s.test_site, "second.localhost");
  assert.equal(s.test_site_from, "chosen for this project");
  // migrate without a site runs on it; a site named for one migrate changes nothing
  await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "migrate" })).job);
  await finished(w.dev, (await w.dev.runDev({ action: "bench", command: "clear_cache", site: "dev.localhost" })).job);
  assert.deepEqual(benchArgs(w).filter((a) => !a.includes("run-tests")), [
    ["--site", "second.localhost", "migrate"],
    ["--site", "dev.localhost", "clear-cache"],
  ]);
  assert.equal((await w.dev.runDev({ action: "status" })).test_site, "second.localhost");
  // a site that does not fit is refused and not remembered; nothing odd reaches bench
  await assert.rejects(w.dev.runDev({ action: "run_tests", site: "bare.localhost" }), { code: "NO_SITE", message: /bare\.localhost cannot be the test site for my_app: my_app is not installed/ });
  for (const site of ["--force", "all", "assets", "../dev.localhost", "live.example.com"]) {
    await assert.rejects(w.dev.runDev({ action: "status", site }), { code: "NO_SITE" }, site);
  }
  assert.deepEqual([...new Set(w.listApps)].sort(), ["bare.localhost", "second.localhost"]);
  assert.equal((await w.dev.runDev({ action: "status" })).test_site, "second.localhost");
});

test("the bench's default site is checked like a listed one", async (t) => {
  const w = world(t);
  w.installed["dev.localhost"] = ["frappe"];
  await readyBranch(w);
  const s = await w.dev.runDev({ action: "status" });
  assert.equal(s.test_site, null);
  assert.match(s.bench_problem, /dev\.localhost: my_app is not installed/);
  await assert.rejects(w.dev.runDev({ action: "run_tests" }), { code: "NO_SITE" });
  w.installed["dev.localhost"] = ["frappe", "my_app"];
  const ok = await w.dev.runDev({ action: "status" });
  assert.equal(ok.test_site, "dev.localhost");
  assert.equal(ok.test_site_from, "the bench's default site");
});

// --- CodeRabbit on #32 ---

test("a bench job that starts while the test site is checked stops the tests: nothing runs beside a migrate", async (t) => {
  const w = world(t);
  await readyBranch(w);
  let checked;
  w.hooks.holdListApps = new Promise((r) => {
    checked = r;
  });
  const tests = w.dev.runDev({ action: "run_tests" });
  await waitUntil(() => w.listApps.length === 1); // the site's check is under way
  let migrated;
  w.hooks.holdBench = new Promise((r) => {
    migrated = r;
  });
  const migrate = await w.dev.runDev({ action: "bench", command: "migrate", site: "dev.localhost" });
  assert.equal(migrate.state, "running");
  w.hooks.holdListApps = null;
  checked();
  await assert.rejects(tests, { code: "BUSY", message: /migrate/ });
  assert.ok(!w.benchRuns.some((r) => r.args.includes("run-tests")), "no test ran beside the migrate");
  w.hooks.holdBench = null;
  migrated();
  await finished(w.dev, migrate.job);
});

test("while a project's tests run, asking again answers with that job and its own site; another site waits", async (t) => {
  const w = world(t);
  makeSite(w.bench, "second.localhost");
  await readyBranch(w);
  let release;
  w.hooks.holdBench = new Promise((r) => {
    release = r;
  });
  const first = await w.dev.runDev({ action: "run_tests" });
  assert.equal(first.test_site, "dev.localhost");
  await assert.rejects(w.dev.runDev({ action: "run_tests", site: "second.localhost" }), {
    code: "BUSY",
    message: /still running this project's tests on dev\.localhost; choose second\.localhost when it has finished/,
  });
  const again = await w.dev.runDev({ action: "run_tests" });
  assert.equal(again.job, first.job);
  assert.equal(again.test_site, "dev.localhost");
  assert.equal((await w.dev.runDev({ action: "run_tests", site: "dev.localhost" })).job, first.job);
  // the refused site was not remembered
  assert.equal((await w.dev.runDev({ action: "status" })).test_site, "dev.localhost");
  w.hooks.holdBench = null;
  release();
  await finished(w.dev, first.job);
});

test("two run_tests at once for one project: the second waits its turn, is refused, and remembers nothing", async (t) => {
  const w = world(t);
  makeSite(w.bench, "second.localhost");
  await readyBranch(w);
  let checked;
  w.hooks.holdListAppsFor["dev.localhost"] = new Promise((r) => {
    checked = r;
  });
  let release;
  w.hooks.holdBench = new Promise((r) => {
    release = r;
  });
  const first = w.dev.runDev({ action: "run_tests" }); // its site's check is held
  await waitUntil(() => w.listApps.includes("dev.localhost"));
  const second = w.dev.runDev({ action: "run_tests", site: "second.localhost" });
  // the second call has reached the bench while the first is still checking its site: it waits its turn
  // (without a turn per bench it would check and keep its own site now, and never log this)
  await waitUntil(() => w.logs.some((m) => /run_tests waits for the run_tests starting on /.test(m)));
  assert.ok(!w.listApps.includes("second.localhost"), "the second call waits for the first to start");
  delete w.hooks.holdListAppsFor["dev.localhost"];
  checked();
  const started = await first;
  assert.equal(started.test_site, "dev.localhost");
  await assert.rejects(second, { code: "BUSY", message: /on dev\.localhost; choose second\.localhost when it has finished/ });
  assert.ok(!w.listApps.includes("second.localhost"), "the refused site was never checked");
  assert.deepEqual(testRunSite(w).map(([site]) => site), ["dev.localhost"]);
  assert.equal((await w.dev.runDev({ action: "status" })).test_site, "dev.localhost", "nothing was remembered for the refused call");
  w.hooks.holdBench = null;
  release();
  await finished(w.dev, started.job);
});

test("two projects choosing their test sites at once both keep their choice", async (t) => {
  const { createSites } = require("../../tbo.frappe-dev/lib/sites");
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tbo-sites-")));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const bench = path.join(top, "bench");
  for (const app of ["frappe", "app_a", "app_b"]) fs.mkdirSync(path.join(bench, "apps", app), { recursive: true });
  makeSite(bench, "dev.localhost");
  const dataDir = path.join(top, "data");
  const runFn = async () => ({ code: 0, stdout: "frappe\napp_a\napp_b\n", stderr: "" });
  // a data folder that answers a moment later, as an app's IPC does
  const getDataPath = () => new Promise((r) => setImmediate(() => r(dataDir)));
  const sites = createSites({ runFn, env: process.env, getDataPath });
  const listed = ["dev.localhost"];
  const [a, b] = await Promise.all(["app_a", "app_b"].map((app) => sites.choose({ root: path.join(bench, "apps", app), bench, listed })));
  assert.equal(a.site, "dev.localhost");
  assert.equal(b.site, "dev.localhost");
  const kept = JSON.parse(fs.readFileSync(path.join(dataDir, "test-sites.json"), "utf8"));
  assert.deepEqual(Object.keys(kept).sort(), [path.join(bench, "apps", "app_a"), path.join(bench, "apps", "app_b")]);
});

test("a folder inside a larger repository is not taken for a repository", async (t) => {
  const w = world(t);
  const { createGit } = require("../../tbo.frappe-dev/lib/git");
  const git = createGit({ env: w.env });
  await assert.rejects(git.resolve(path.join(w.repo, "my_app")), { code: "NOT_A_REPO", message: /belongs to the repository/ });
});
