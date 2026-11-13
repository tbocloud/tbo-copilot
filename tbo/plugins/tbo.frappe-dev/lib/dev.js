"use strict";

// The tbo_dev and tbo_dev_pr tools (TBO Copilot Phase 20, TASK-2026-00021): build a Frappe
// feature from a TBO Support task the way TBO does.
// - tbo_dev, all local: `status`; `start_work` (the task's branch); `check` (the linters CI runs)
//   and `run_tests` (module tests on the developer's bench), both in the background because a
//   first run can take minutes and a tool call has 110 seconds; `job_status`.
// - tbo_dev_pr, the one step that leaves the computer: `open_pr` pushes the branch and opens the
//   pull request. It is its own tool so the app asks before it every time. It needs a passing
//   lint run on the current commit, and test results for it (or a reason there are none).
// GitHub is reached with the developer's own `gh` login; no token passes through the plugin.
// See docs/tbo/frappe-dev.md.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, tail, fail } = require("./run");
const { createGit, taskId, taskOf, branchFor, checkBranchName } = require("./git");
const { createLint } = require("./lint");
const { createTests, checkModules, findBench, findSite, testModules } = require("./tests");
const pr = require("./pr");

const MAX_JOBS = 20;
const LINKS = ["Closes", "Refs"];

const TOOL_TEXT = [
  "Build a Frappe/ERPNext change from a TBO Support task, in the repository open in the workspace (or `repo`, a folder inside it). Choose an action:",
  "- status: the repository, its branch and task, what is installed (git, gh and its login, uv, the bench and test site).",
  "- start_work: create or switch to the task's branch (feature/TASK-…-short-name, or fix/… with kind fix) from the remote's default branch or `base` (the remote: origin, else upstream as bench get-app names it). Needs task and subject (tbo_support get_task's branch_subject). Refuses a dirty working tree.",
  "- check: run the linters the repository's CI runs (pre-commit on changed files, Semgrep with Frappe's rules, commit titles) on the committed branch. Runs in the background: answers with a job.",
  "- run_tests: run the test modules the branch touched (or `modules`) on the local bench's test site, one by one; never the whole suite. Runs in the background.",
  "- job_status: the outcome of a check or run_tests job (`job`, or the latest of `kind`).",
  "Commit with conventional titles (feat: …, fix(scope): …). Then open the PR with tbo_dev_pr.",
].join("\n");

const DEV_TOOL = {
  name: "tbo_dev",
  description: TOOL_TEXT,
  risk: "medium",
  planSafeActions: ["status", "job_status"],
  schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["status", "start_work", "check", "run_tests", "job_status"], description: "What to do." },
      repo: { type: "string", description: "The repository folder, relative to the workspace, when the workspace is not the repository itself (e.g. apps/my_app)." },
      task: { type: "string", description: "start_work: the TBO Support task, e.g. TASK-2026-00021." },
      subject: { type: "string", description: "start_work: the task's subject; it becomes the branch's short name." },
      kind: { type: "string", enum: ["feature", "fix"], description: "start_work: fix for a bug fix, else feature." },
      base: { type: "string", description: "start_work: the branch to start from, when the repository's AGENTS.md names one; default the remote's default branch." },
      modules: { type: "array", items: { type: "string" }, description: "run_tests: test modules such as my_app.tests.test_invoices; default the ones the branch touched." },
      job: { type: "string", description: "job_status: the job id check or run_tests answered." },
      job_kind: { type: "string", enum: ["check", "run_tests"], description: "job_status: the latest job of this kind, when no job id is given." },
      skip_hooks: {
        type: "array",
        items: { type: "string" },
        description: "check: pre-commit hooks to leave out, only when the check said their tools cannot be installed and the change has no file they check. Recorded in the PR.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

const PR_TOOL = {
  name: "tbo_dev_pr",
  description: [
    "Open the pull request for the task's branch: pushes the branch with the developer's own GitHub login, opens the PR with the repository's template (TBO's when it has none), the title TASK-…: summary and 'Closes TASK-…', then marks it ready for review so TBO Support moves the task to Pending Review.",
    "Needs a passing tbo_dev check on the current commit and a clean working tree, and the tbo_dev run_tests result for the commit or no_tests_reason. Never pushes to main, master, develop, tbo or the default branch, and never force-pushes.",
  ].join(" "),
  risk: "high",
  schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["open_pr"], description: "What to do." },
      repo: { type: "string", description: "The repository folder, relative to the workspace, when the workspace is not the repository itself." },
      summary: { type: "string", description: "One line: what the PR does (it follows 'TASK-…: ' in the title)." },
      what_and_why: { type: "string", description: "What changes and the problem it solves (markdown)." },
      how_to_test: { type: "string", description: "Steps a reviewer can follow (markdown)." },
      link: { type: "string", enum: LINKS, description: "Closes (merging completes the task; default) or Refs (the PR is part of the task)." },
      no_tests_reason: { type: "string", description: "Why no tests were run on this commit, when none were." },
      reviewers: { type: "array", items: { type: "string" }, description: "GitHub logins to ask for a review; default the plugin setting." },
      draft: { type: "boolean", description: "true: leave it a draft (the task stays Working until it is marked ready)." },
    },
    required: ["action", "summary", "what_and_why", "how_to_test"],
    additionalProperties: false,
  },
};

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function uvCandidates(home, platform) {
  const exe = platform === "win32" ? "uv.exe" : "uv";
  return [path.join(home, ".local", "bin", exe), path.join(home, ".cargo", "bin", exe), "/opt/homebrew/bin/uv", "/usr/local/bin/uv"];
}

function onPath(name, env, platform) {
  const exts = platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function findUv({ configured, env, home = os.homedir(), platform = process.platform }) {
  if (configured) return fs.existsSync(configured) ? configured : null;
  return onPath("uv", env, platform) || uvCandidates(home, platform).find((p) => fs.existsSync(p)) || null;
}

function createDev({ getSettings, getDataPath, getWorkspace, runFn = run, env = process.env, log = () => {}, platform = process.platform }) {
  const git = createGit({ runFn, env });
  const jobs = new Map(); // id -> job
  const passedLint = new Map(); // `${root}@${head}` -> the lint result
  const testRuns = new Map(); // `${root}@${head}` -> the test result
  let counter = 0;

  async function settings() {
    const s = (await getSettings()) || {};
    return {
      benchPath: String(s.benchPath || "").trim(),
      testSite: String(s.testSite || "").trim(),
      benchCommand: String(s.benchCommand || "").trim() || "bench",
      reviewers: String(s.reviewers || "")
        .split(/[\s,]+/)
        .filter(Boolean),
      uvPath: String(s.uvPath || "").trim(),
    };
  }

  async function repoOf(args) {
    const ws = await getWorkspace();
    return git.resolve(ws && ws.path, args && args.repo);
  }

  async function ghLogin(root) {
    try {
      const res = await runFn("gh", ["auth", "status", "--hostname", "github.com"], { cwd: root, env, timeoutMs: 20000 });
      const who = /account ([A-Za-z0-9-]+)/.exec(`${res.stdout}\n${res.stderr}`);
      return res.code === 0 ? { ok: true, login: who ? who[1] : null } : { ok: false, hint: "Run `gh auth login` once (GitHub CLI)." };
    } catch {
      return { ok: false, hint: "Install the GitHub CLI (https://cli.github.com) and run `gh auth login`." };
    }
  }

  async function status(args) {
    const conf = await settings();
    const root = await repoOf(args);
    const info = await git.info(root);
    const base = info.branch ? (await git.baseOf(root, info.branch)) || info.defaultBranch : info.defaultBranch;
    let bench = null;
    let benchProblem = null;
    let site = null;
    try {
      bench = findBench(root, conf.benchPath);
      if (bench) site = findSite(bench, conf.testSite);
      else benchProblem = 'No bench found: set "Frappe bench folder", or work in <bench>/apps/<app>.';
    } catch (e) {
      benchProblem = e.message;
    }
    const uv = findUv({ configured: conf.uvPath, env, platform });
    return {
      repo: root,
      remote: info.remote,
      github: info.github,
      branch: info.branch,
      task: info.task,
      base,
      default_branch: info.defaultBranch,
      uncommitted: info.dirty.slice(0, 20),
      gh: await ghLogin(root),
      uv: uv || "missing: install uv (https://docs.astral.sh/uv/) or set uv location",
      bench: bench || null,
      test_site: site,
      bench_problem: benchProblem || undefined,
      last_check: lastOf("check", root),
      last_tests: lastOf("run_tests", root),
    };
  }

  async function startWork(args) {
    const task = taskId(args.task);
    const subject = String(args.subject || "").trim();
    if (!subject) throw fail("INVALID_ARGUMENT", '"subject" is needed: the task\'s subject from tbo_support get_task.');
    const root = await repoOf(args);
    const info = await git.info(root);
    if (info.task === task) return { branch: info.branch, task, base: await git.baseOf(root, info.branch), state: "already on it" };
    if (info.dirty.length) {
      throw fail("DIRTY", `The working tree has uncommitted changes; commit or put them aside first (nothing is stashed for you):\n${info.dirty.slice(0, 10).join("\n")}`);
    }
    const wanted = String(args.base || info.defaultBranch || "").trim();
    if (!wanted) throw fail("NO_BASE", `${info.remote} has no default branch here; name the branch to start from as "base".`);
    const base = checkBranchName(wanted, "base");
    await git.git(root, ["fetch", "--quiet", info.remote, base], { timeoutMs: 90000 });
    const existing = await git.taskBranch(root, task, info.remote);
    let branch;
    let state;
    if (existing && existing.where === "local") {
      branch = existing.name;
      await git.git(root, ["switch", "--quiet", branch]);
      state = "switched to the task's branch";
    } else if (existing) {
      branch = checkBranchName(existing.name, "branch");
      await git.git(root, ["fetch", "--quiet", info.remote, branch], { timeoutMs: 90000 });
      await git.git(root, ["switch", "--quiet", "--track", "-c", branch, `${info.remote}/${branch}`]);
      state = `continued the task's branch from ${info.remote}`;
    } else {
      branch = checkBranchName(branchFor(task, subject, args.kind), "branch");
      await git.git(root, ["switch", "--quiet", "--no-track", "-c", branch, `${info.remote}/${base}`]);
      state = "created";
    }
    if (!(await git.baseOf(root, branch))) await git.setBase(root, branch, base);
    return {
      branch,
      task,
      base: (await git.baseOf(root, branch)) || base,
      state,
      next: "Read the repository's AGENTS.md, write the change and its tests, commit with conventional titles, then tbo_dev run_tests and check.",
    };
  }

  // --- background jobs ------------------------------------------------------------

  function lastOf(kind, root) {
    const list = [...jobs.values()].filter((j) => j.kind === kind && j.repo === root);
    return list.length ? summaryOf(list.at(-1)) : null;
  }

  function summaryOf(job) {
    const out = { job: job.id, kind: job.kind, state: job.state, commit: job.head.slice(0, 12), started: job.started };
    if (job.finished) out.finished = job.finished;
    if (job.error) out.error = job.error;
    if (job.result) out.result = job.result;
    return out;
  }

  function startJob(kind, root, head, work) {
    const running = [...jobs.values()].find((j) => j.kind === kind && j.repo === root && j.state === "running");
    if (running) return { ...summaryOf(running), note: "already running; ask job_status for it" };
    counter += 1;
    const job = { id: `${kind}-${counter}`, kind, repo: root, head, state: "running", started: new Date().toISOString() };
    jobs.set(job.id, job);
    while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
    work()
      .then((result) => {
        job.result = result;
        job.state = result.passed ? "passed" : "failed";
      })
      .catch((e) => {
        job.state = "error";
        job.error = e.message;
      })
      .finally(() => {
        job.finished = new Date().toISOString();
        log(`tbo_dev ${job.id} ${job.state}`);
      });
    return { ...summaryOf(job), next: "Ask job_status in a minute; the first run of a repository takes longer." };
  }

  // The committed state of a task branch: lint and test results belong to one commit.
  async function committedBranch(root) {
    const info = await git.info(root);
    if (!info.branch || !info.task) throw fail("NOT_A_TASK_BRANCH", "Switch to the task's branch first (tbo_dev start_work).");
    if (info.dirty.length) throw fail("DIRTY", `Commit the changes first; checks run on a commit:\n${info.dirty.slice(0, 10).join("\n")}`);
    const base = (await git.baseOf(root, info.branch)) || info.defaultBranch;
    if (!base) throw fail("NO_BASE", "The branch's base is not known; start the branch with tbo_dev start_work.");
    await git.git(root, ["fetch", "--quiet", info.remote, base], { timeoutMs: 60000 });
    return { info, base };
  }

  async function check(args) {
    const root = await repoOf(args);
    const { info, base } = await committedBranch(root);
    const conf = await settings();
    const uv = findUv({ configured: conf.uvPath, env, platform });
    if (!uv) throw fail("UV_MISSING", "The linters run through uv: install it (https://docs.astral.sh/uv/) or set uv location in the plugin settings.");
    const skip = Array.isArray(args.skip_hooks) ? args.skip_hooks.map(String) : [];
    for (const id of skip) if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) throw fail("INVALID_ARGUMENT", `"${id}" is not a pre-commit hook id.`);
    const lint = createLint({ git, runFn, env, uv, dataDir: await getDataPath(), log });
    return startJob("check", root, info.head, async () => {
      const result = await lint.check(root, base, skip, info.remote);
      if (result.passed) passedLint.set(`${root}@${info.head}`, result);
      return result;
    });
  }

  async function runTests(args) {
    const root = await repoOf(args);
    const { info, base } = await committedBranch(root);
    const conf = await settings();
    const bench = findBench(root, conf.benchPath);
    if (!bench) throw fail("NO_BENCH", 'No bench found: set "Frappe bench folder" in the plugin settings, or work in <bench>/apps/<app>.');
    const site = findSite(bench, conf.testSite);
    let modules = Array.isArray(args.modules) ? args.modules.map(String) : [];
    if (!modules.length) modules = testModules(root, await git.changedFiles(root, await git.mergeBase(root, base, info.remote)));
    if (!modules.length) throw fail("NO_TESTS", "The branch changes no file that has tests beside it: name the test modules, or add tests.");
    checkModules(modules); // refused now, not later in the background
    const tests = createTests({ runFn, env, log });
    return startJob("run_tests", root, info.head, async () => {
      const result = await tests.runModules({ bench, site, modules, benchCommand: conf.benchCommand });
      testRuns.set(`${root}@${info.head}`, result);
      return result;
    });
  }

  async function jobStatus(args) {
    const root = await repoOf(args);
    if (args.job) {
      const job = jobs.get(String(args.job));
      if (!job) throw fail("NO_JOB", `No job ${args.job} (jobs are kept until the app restarts).`);
      return summaryOf(job);
    }
    return lastOf(args.job_kind || "check", root) || { state: "none", note: "No job of that kind for this repository yet." };
  }

  // --- the pull request -----------------------------------------------------------

  async function gh(root, argv, timeoutMs) {
    const res = await runFn("gh", argv, { cwd: root, env, timeoutMs });
    if (res.timedOut) throw fail("TIMEOUT", `gh ${argv[0]} ${argv[1]} took too long.`);
    if (res.code !== 0) throw fail("GITHUB_ERROR", `gh ${argv[0]} ${argv[1]} failed: ${tail(res.stderr || res.stdout, 8)}`);
    return res.stdout.trim();
  }

  async function openPr(args) {
    const root = await repoOf(args);
    const { info, base } = await committedBranch(root);
    const branch = info.branch;
    if (git.shared(branch, info, base)) throw fail("SHARED_BRANCH", `Copilot never pushes to ${branch}.`);
    const link = LINKS.includes(args.link) ? args.link : "Closes";
    const ahead = Number(await git.out(root, ["rev-list", "--count", `refs/remotes/${info.remote}/${base}..HEAD`]));
    if (!ahead) throw fail("NOTHING_TO_PR", `The branch has no commits beyond ${info.remote}/${base}.`);
    const lint = passedLint.get(`${root}@${info.head}`);
    if (!lint) throw fail("NOT_CHECKED", `Run tbo_dev check on this commit (${info.head.slice(0, 12)}) first; the PR opens only after the linters pass on it.`);
    const tests = testRuns.get(`${root}@${info.head}`) || null;
    if (tests && !tests.passed) throw fail("TESTS_FAILED", "The tests failed on this commit; fix them (or name the modules that apply) before opening the PR.");
    const noTestsReason = String(args.no_tests_reason || "").trim();
    if (!tests && !noTestsReason) throw fail("NOT_TESTED", "Run tbo_dev run_tests on this commit first, or give no_tests_reason (why no test applies).");
    const conf = await settings();
    const reviewers = (Array.isArray(args.reviewers) ? args.reviewers : conf.reviewers).map(String).filter(Boolean);
    for (const r of reviewers) if (!GITHUB_LOGIN.test(r)) throw fail("INVALID_ARGUMENT", `"${r}" is not a GitHub login.`);
    const login = await ghLogin(root);
    if (!login.ok) throw fail("GH_LOGIN", login.hint);
    if (!info.github) throw fail("NOT_GITHUB", `${info.remote} is not a GitHub repository.`);

    const titleText = pr.title(info.task, args.summary);
    const template = pr.findTemplate(root);
    const bodyText = pr.body(template.text, {
      task: info.task,
      link,
      whatAndWhy: String(args.what_and_why || ""),
      howToTest: String(args.how_to_test || ""),
      checks: { head: info.head, lint, tests, noTestsReason },
    });

    // a fast-forward push only: a branch that moved on GitHub is never overwritten
    const push = await runFn("git", ["push", "--quiet", "--set-upstream", info.remote, `HEAD:refs/heads/${branch}`], { cwd: root, env, timeoutMs: 60000 });
    if (push.code !== 0 || push.timedOut) {
      throw fail("PUSH_FAILED", `The push was refused (nothing was forced): ${tail(push.stderr || push.stdout, 6)}\nIf GitHub has newer commits on the branch, pull them (git pull --rebase is fine on your own branch), check again, and retry.`);
    }

    const existing = await runFn("gh", ["pr", "view", branch, "--repo", info.github, "--json", "url,state,isDraft"], { cwd: root, env, timeoutMs: 20000 });
    let url;
    let state;
    if (existing.code === 0) {
      const found = JSON.parse(existing.stdout);
      if (found.state === "OPEN") {
        url = found.url;
        state = "updated: the open PR got the new commits";
      }
    }
    if (!url) {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tbo-dev-pr-")), "body.md");
      fs.writeFileSync(file, bodyText);
      try {
        url = (await gh(root, ["pr", "create", "--repo", info.github, "--draft", "--base", base, "--head", branch, "--title", titleText, "--body-file", file], 30000))
          .split("\n")
          .filter((l) => /^https:\/\//.test(l))
          .pop();
      } finally {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
      }
      state = "opened";
    }
    // "ready for review" is what moves the task to Pending Review in TBO Support
    if (!args.draft) await gh(root, ["pr", "ready", url, "--repo", info.github], 20000).catch((e) => log(`tbo_dev_pr ready: ${e.message}`));
    if (reviewers.length) await gh(root, ["pr", "edit", url, "--repo", info.github, "--add-reviewer", reviewers.join(",")], 20000).catch((e) => log(`tbo_dev_pr reviewers: ${e.message}`));
    return {
      pr: url,
      state,
      title: titleText,
      base,
      branch,
      task: info.task,
      link,
      template: template.source,
      draft: Boolean(args.draft),
      reviewers,
      task_moves: args.draft
        ? `${info.task} stays Working while the PR is a draft; marking it ready moves it to Pending Review.`
        : `TBO Support moves ${info.task} to Pending Review when GitHub's webhook arrives (usually within a minute), if ${info.github} is in its GitHub settings' allowed repositories.`,
    };
  }

  async function runDev(args) {
    const action = args && args.action;
    if (action === "status") return status(args);
    if (action === "start_work") return startWork(args);
    if (action === "check") return check(args);
    if (action === "run_tests") return runTests(args);
    if (action === "job_status") return jobStatus(args);
    throw fail("INVALID_ARGUMENT", `Unknown action "${action}". Use one of: ${DEV_TOOL.schema.properties.action.enum.join(", ")}.`);
  }

  async function runPr(args) {
    if (!args || args.action !== "open_pr") throw fail("INVALID_ARGUMENT", 'The only action is "open_pr".');
    return openPr(args);
  }

  return { runDev, runPr, jobs };
}

module.exports = { createDev, DEV_TOOL, PR_TOOL, findUv, taskOf };
