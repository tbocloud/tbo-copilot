"use strict";

// The linters a repository's CI runs, run here first on what the branch changed:
// - pre-commit (black, flake8, isort, ruff, prettier, eslint: whatever the repository's
//   .pre-commit-config.yaml lists) on the branch's changed files;
// - Semgrep with the configs CI names (Frappe's rules, r/python.lang.correctness), reporting
//   only findings the branch adds (its merge base is the baseline);
// - flake8 or ruff when CI runs them outside pre-commit;
// - conventional commit titles when CI runs commitlint.
// A Frappe app whose CI runs nothing still gets Semgrep with Frappe's rules and the commit
// titles, as TBO's own repositories do. Tools run as pinned versions through uv.

const fs = require("node:fs");
const path = require("node:path");
const { tail, fail } = require("./run");

const PINS = {
  preCommit: "pre-commit==4.7.0",
  semgrep: "semgrep==1.182.1",
  flake8: "flake8==7.3.0",
  ruff: "ruff==0.14.2",
};
const FRAPPE_RULES = "https://github.com/frappe/semgrep-rules.git";
const DEFAULT_SEMGREP = [{ kind: "frappe", sub: "rules" }, { kind: "registry", name: "r/python.lang.correctness" }];
const RULES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// @commitlint/config-conventional's types; a header of at most 100 characters
const COMMIT_TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
const CONVENTIONAL = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\([^()\\n]+\\))?!?: \\S`);

function workflowText(root) {
  const dir = path.join(root, ".github", "workflows");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
  } catch {
    return "";
  }
  return names
    .sort()
    .map((n) => {
      try {
        return fs.readFileSync(path.join(dir, n), "utf8").slice(0, 200000);
      } catch {
        return "";
      }
    })
    .join("\n");
}

function isFrappeApp(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).some((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, "hooks.py")));
  } catch {
    return false;
  }
}

// The Semgrep configs CI passes: Frappe's rules (cloned by CI), registry rule sets, or files in
// the repository. Anything else is left out.
function semgrepConfigs(text, root) {
  const configs = [];
  for (const line of text.split("\n")) {
    if (!/semgrep/i.test(line)) continue;
    for (const m of line.matchAll(/--config[= ]+("[^"]+"|'[^']+'|\S+)/g)) {
      const value = m[1].replace(/^["']|["']$/g, "");
      const frappe = /frappe-semgrep-rules\/?(.*)$/.exec(value);
      if (frappe) configs.push({ kind: "frappe", sub: frappe[1].replace(/^\/+|\/+$/g, "") || "rules" });
      else if (/^[rps]\/[\w.-]+$/.test(value)) configs.push({ kind: "registry", name: value });
      else if (!value.includes("..") && fs.existsSync(path.join(root, value))) configs.push({ kind: "local", path: value });
    }
  }
  const seen = new Set();
  return configs.filter((c) => {
    const key = JSON.stringify(c);
    return seen.has(key) ? false : seen.add(key);
  });
}

function directRun(text, tool) {
  return text.split("\n").some((line) => {
    const t = line.trim().replace(/^-\s*/, "").replace(/^run:\s*/, "");
    return t.startsWith(`${tool} `) || t === tool || t.startsWith(`python -m ${tool}`) || t.startsWith(`python3 -m ${tool}`);
  });
}

// What to run for this repository, and why.
function plan(root) {
  const text = workflowText(root);
  const frappe = isFrappeApp(root);
  const preCommit = fs.existsSync(path.join(root, ".pre-commit-config.yaml"));
  const ciSemgrep = /semgrep/i.test(text);
  const configs = ciSemgrep ? semgrepConfigs(text, root) : [];
  return {
    preCommit: preCommit ? { fromCi: /pre-commit/.test(text) } : null,
    semgrep: ciSemgrep || frappe ? { fromCi: ciSemgrep, configs: configs.length ? configs : DEFAULT_SEMGREP } : null,
    flake8: directRun(text, "flake8"),
    ruff: directRun(text, "ruff"),
    commits: { fromCi: /commitlint/.test(text), blocking: /commitlint/.test(text) || frappe },
  };
}

// Why a commit title breaks @commitlint/config-conventional, or null. Merge and revert commits are
// left alone, as commitlint does.
function commitProblem(subject) {
  if (/^(Merge|Revert) /.test(subject)) return null;
  if (subject.length > 100) return "longer than 100 characters";
  if (!CONVENTIONAL.test(subject)) return `not "type(scope): summary" with a type of ${COMMIT_TYPES.join(", ")}`;
  const summary = subject.slice(subject.indexOf(": ") + 2);
  if (/^[A-Z][a-z]/.test(summary) || (summary === summary.toUpperCase() && /[A-Z]/.test(summary))) {
    return "the summary starts with a capital letter (conventional commits keep it lower case)";
  }
  return /\.$/.test(subject) ? "ends with a full stop" : null;
}

// The hook ids of each repository in .pre-commit-config.yaml (a line-by-line read of its usual layout).
function preCommitHooks(root) {
  const hooks = {};
  let repo = null;
  let text = "";
  try {
    text = fs.readFileSync(path.join(root, ".pre-commit-config.yaml"), "utf8");
  } catch {
    return hooks;
  }
  for (const line of text.split("\n")) {
    const r = /^\s*-?\s*repo:\s*["']?([^\s"']+)/.exec(line);
    if (r) {
      repo = r[1];
      hooks[repo] = hooks[repo] || [];
      continue;
    }
    const id = /^\s*-\s*id:\s*["']?([\w.-]+)/.exec(line);
    if (id && repo) hooks[repo].push(id[1]);
  }
  return hooks;
}

// pre-commit could not install a hook's own tools (not a problem in the code): which, and what to do.
function installFailure(output, hooks) {
  if (!/An unexpected error has occurred/.test(output)) return null;
  const repos = [...output.matchAll(/Installing environment for (\S+?)\.?\n/g)].map((m) => m[1]);
  const repo = repos.at(-1) || "a hook";
  const ids = hooks[repo] || [];
  const cause = (/npm error code (\w+)|error: (.+)/.exec(output) || [])[0] || "see the output";
  const npm = /EALLOWGIT/.test(output) ? " npm 11.12 and later refuse the install pre-commit makes for Node hooks (EALLOWGIT); an older npm works." : "";
  const hint = ids.length
    ? ` If the change has no file ${ids.join(", ")} check${ids.length > 1 ? "" : "s"}, run check again with skip_hooks: [${ids.map((i) => `"${i}"`).join(", ")}], and say so; otherwise fix the install first.`
    : "";
  return `pre-commit could not install the tools of ${repo} (${cause}). This is not a problem in the code.${npm}${hint}`;
}

function createLint({ git, runFn, env, uv, dataDir, log = () => {} }) {
  const uvRun = (cwd, pin, args, timeoutMs) => runFn(uv, ["tool", "run", "--from", pin, ...args], { cwd, env, timeoutMs });

  // Frappe's Semgrep rules, as CI clones them, kept in the plugin's data folder and refreshed weekly.
  async function frappeRules() {
    const dir = path.join(dataDir, "frappe-semgrep-rules");
    const marker = path.join(dir, ".git");
    if (!fs.existsSync(marker)) {
      fs.rmSync(dir, { recursive: true, force: true });
      const res = await runFn("git", ["clone", "--quiet", "--depth", "1", FRAPPE_RULES, dir], { env, timeoutMs: 120000 });
      if (res.code !== 0) throw fail("SEMGREP_RULES", `Frappe's Semgrep rules could not be downloaded: ${tail(res.stderr, 4)}`);
    } else if (Date.now() - fs.statSync(marker).mtimeMs > RULES_MAX_AGE_MS) {
      const res = await runFn("git", ["-C", dir, "pull", "--quiet", "--ff-only"], { env, timeoutMs: 60000 });
      if (res.code === 0) fs.utimesSync(marker, new Date(), new Date());
    }
    return dir;
  }

  async function preCommit(root, from, changed, skip) {
    if (!changed.length) return { status: "skipped", detail: "no changed files" };
    const skipped = skip.length ? { skipped: skip } : {};
    const res = await runFn(uv, ["tool", "run", "--from", PINS.preCommit, "pre-commit", "run", "--from-ref", from, "--to-ref", "HEAD", "--show-diff-on-failure", "--color=never"], {
      cwd: root,
      env: skip.length ? { ...env, SKIP: skip.join(",") } : env,
      timeoutMs: 900000,
    });
    const touched = (await git.out(root, ["status", "--porcelain=v1"])).split("\n").filter(Boolean);
    if (res.timedOut) return { status: "failed", detail: "pre-commit took longer than 15 minutes", ...skipped };
    const install = installFailure(`${res.stdout}\n${res.stderr}`, preCommitHooks(root));
    if (install) return { status: "failed", installError: true, detail: install, ...skipped };
    if (touched.length) {
      return {
        status: "failed",
        detail: `pre-commit fixed ${touched.length} file(s): review the changes, commit them, and check again.\n${tail(res.stdout, 30)}`,
      };
    }
    return res.code === 0
      ? { status: "passed", detail: tail(res.stdout, 12), ...skipped }
      : { status: "failed", detail: tail(res.stdout || res.stderr, 40), ...skipped };
  }

  async function semgrep(root, from, configs) {
    const args = ["semgrep", "scan"];
    for (const c of configs) {
      if (c.kind === "frappe") args.push("--config", path.join(await frappeRules(), c.sub));
      else if (c.kind === "registry") args.push("--config", c.name);
      else args.push("--config", c.path);
    }
    args.push("--baseline-commit", from, "--metrics=off", "--disable-version-check", "--json", "--quiet");
    const res = await uvRun(root, PINS.semgrep, args, 900000);
    if (res.timedOut) return { status: "failed", detail: "Semgrep took longer than 15 minutes" };
    let report;
    try {
      report = JSON.parse(res.stdout);
    } catch {
      return { status: "failed", detail: `Semgrep did not finish: ${tail(res.stderr || res.stdout, 12)}` };
    }
    const findings = (report.results || []).map(
      (r) => `${r.path}:${r.start && r.start.line} ${String(r.check_id).split(".").pop()}: ${String((r.extra && r.extra.message) || "").split("\n")[0].slice(0, 200)}`,
    );
    return findings.length
      ? { status: "failed", detail: `${findings.length} new finding(s):\n${findings.slice(0, 30).join("\n")}` }
      : { status: "passed", detail: "no new findings" };
  }

  async function direct(root, tool, files) {
    const py = files.filter((f) => f.endsWith(".py"));
    if (!py.length) return { status: "skipped", detail: "no changed Python files" };
    const args = tool === "ruff" ? ["ruff", "check", ...py] : ["flake8", ...py];
    const res = await uvRun(root, PINS[tool], args, 300000);
    return res.code === 0 ? { status: "passed", detail: "" } : { status: "failed", detail: tail(res.stdout || res.stderr, 40) };
  }

  function commits(list) {
    const bad = list.map((c) => ({ ...c, problem: commitProblem(c.subject) })).filter((c) => c.problem);
    return bad.length
      ? { status: "failed", detail: bad.map((c) => `${c.sha} "${c.subject}": ${c.problem}`).join("\n") }
      : { status: "passed", detail: `${list.length} commit title(s)` };
  }

  // Runs the plan; every step's outcome is kept, and the run passes when no blocking step failed.
  async function check(root, base, skip = [], remote = "origin") {
    const p = plan(root);
    const from = await git.mergeBase(root, base, remote);
    const changed = await git.changedFiles(root, from);
    const steps = [];
    const step = async (name, fromCi, blocking, fn) => {
      log(`lint: ${name}`);
      try {
        steps.push({ name, fromCi, blocking, ...(await fn()) });
      } catch (e) {
        steps.push({ name, fromCi, blocking, status: "failed", detail: e.message });
      }
    };
    if (p.preCommit) await step("pre-commit", p.preCommit.fromCi, true, () => preCommit(root, from, changed, skip));
    if (p.semgrep) await step("semgrep", p.semgrep.fromCi, true, () => semgrep(root, from, p.semgrep.configs));
    if (p.flake8) await step("flake8", true, true, () => direct(root, "flake8", changed));
    if (p.ruff) await step("ruff", true, true, () => direct(root, "ruff", changed));
    await step("commit titles", p.commits.fromCi, p.commits.blocking, async () => commits(await git.commitsSince(root, from)));
    const passed = steps.every((s) => s.status !== "failed" || !s.blocking);
    return { passed, mergeBase: from, changedFiles: changed.length, steps };
  }

  return { check };
}

module.exports = { createLint, plan, semgrepConfigs, commitProblem, preCommitHooks, installFailure, PINS, CONVENTIONAL };
