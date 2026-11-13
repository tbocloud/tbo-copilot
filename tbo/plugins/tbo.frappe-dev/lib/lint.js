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
// one download or refresh of Frappe's rules at a time per folder, however many checks start
const rulesInFlight = new Map();
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
  // a command continued over lines with a backslash is one command
  for (const line of text.replace(/\\[ \t]*\r?\n[ \t]*/g, " ").split("\n")) {
    if (!/semgrep/i.test(line)) continue;
    for (const m of line.matchAll(/--config[= ]+("[^"]+"|'[^']+'|\S+)/g)) {
      const value = m[1].replace(/^["']|["']$/g, "");
      const frappe = /frappe-semgrep-rules\/?(.*)$/.exec(value);
      if (frappe) configs.push({ kind: "frappe", sub: frappe[1].replace(/^\/+|\/+$/g, "") || "rules" });
      else if (/^[rps]\/[\w.-]+$/.test(value)) configs.push({ kind: "registry", name: value });
      else {
        // a rules file in the repository, never one outside it
        const full = path.resolve(root, value);
        const rel = path.relative(root, full);
        if (rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && fs.existsSync(full)) {
          configs.push({ kind: "local", path: rel.split(path.sep).join("/") });
        }
      }
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

// The hooks of .pre-commit-config.yaml with their file filters (types, types_or, files), read line by
// line in the file's usual layout: inline lists ([a, b]) and block lists both.
function preCommitHookList(root) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(root, ".pre-commit-config.yaml"), "utf8");
  } catch {
    return [];
  }
  const hooks = [];
  let repo = null;
  let hook = null;
  let listKey = null;
  let listIndent = -1;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    const r = /^\s*-?\s*repo:\s*["']?([^\s"']+)/.exec(line);
    if (r) {
      repo = r[1];
      hook = null;
      listKey = null;
      continue;
    }
    const id = /^\s*-\s*id:\s*["']?([\w.-]+)/.exec(line);
    if (id && repo) {
      hook = { repo, id: id[1], types: [], types_or: [], files: null };
      hooks.push(hook);
      listKey = null;
      continue;
    }
    if (!hook) continue;
    if (listKey && indent > listIndent && /^\s*-\s*\S/.test(line)) {
      hook[listKey].push(line.replace(/^\s*-\s*/, "").replace(/["']/g, "").trim());
      continue;
    }
    listKey = null;
    const kv = /^\s*(types|types_or|files)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    const v = value.trim();
    if (key === "files") hook.files = v.replace(/^["']|["']$/g, "") || null;
    else if (v.startsWith("[")) hook[key] = v.replace(/[[\]"']/g, "").split(",").map((x) => x.trim()).filter(Boolean);
    else if (!v) {
      listKey = key;
      listIndent = indent;
    } else hook[key] = [v.replace(/["']/g, "")];
  }
  return hooks;
}

// The hook ids of each repository in .pre-commit-config.yaml.
function preCommitHooks(root) {
  const byRepo = {};
  for (const h of preCommitHookList(root)) (byRepo[h.repo] = byRepo[h.repo] || []).push(h.id);
  return byRepo;
}

// The file extensions of the identify tags pre-commit hooks filter on (the ones TBO's configs use).
const TYPE_EXTENSIONS = {
  python: [".py", ".pyi"],
  pyi: [".pyi"],
  javascript: [".js", ".mjs", ".cjs", ".jsx"],
  jsx: [".jsx"],
  ts: [".ts", ".mts", ".cts"],
  tsx: [".tsx"],
  vue: [".vue"],
  html: [".html", ".htm"],
  css: [".css"],
  scss: [".scss"],
  sass: [".sass"],
  less: [".less"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  markdown: [".md", ".markdown"],
  toml: [".toml"],
  shell: [".sh", ".bash"],
  sql: [".sql"],
  xml: [".xml"],
  svg: [".svg"],
  jinja: [".jinja", ".jinja2", ".j2"],
};

// Whether a hook may check a file: true, false, or null when its declared filters cannot tell
// (no filter in the config, or a type this list does not know, such as "text").
function hookMayCheck(hook, file) {
  const tags = [...hook.types, ...hook.types_or];
  if (!tags.length && !hook.files) return null;
  if (!tags.every((t) => t === "file" || Object.hasOwn(TYPE_EXTENSIONS, t))) return null;
  if (hook.files) {
    let re;
    try {
      re = new RegExp(hook.files);
    } catch {
      return null;
    }
    if (!re.test(file)) return false;
  }
  const ext = path.extname(file).toLowerCase();
  const matches = (t) => t === "file" || TYPE_EXTENSIONS[t].includes(ext);
  if (hook.types.length && !hook.types.every(matches)) return false;
  if (hook.types_or.length && !hook.types_or.some(matches)) return false;
  return true;
}

// A hook may be left out only when a check on this commit could not install its tools, and its own
// filters show it checks none of the changed files. Otherwise the skip is refused.
function checkSkips(root, skip, changed, installFailed) {
  const hooks = preCommitHookList(root);
  for (const id of skip) {
    if (!installFailed.includes(id)) {
      throw fail("SKIP_REFUSED", `"${id}" may be skipped only after a check on this commit said its tools could not be installed.`);
    }
    const hook = hooks.find((h) => h.id === id);
    if (!hook) throw fail("SKIP_REFUSED", `"${id}" is not a hook in .pre-commit-config.yaml.`);
    for (const file of changed) {
      const may = hookMayCheck(hook, file);
      if (may === null) {
        throw fail("SKIP_REFUSED", `"${id}" does not say in .pre-commit-config.yaml which files it checks, so skipping it cannot be shown safe; fix its install instead.`);
      }
      if (may) throw fail("SKIP_REFUSED", `"${id}" checks ${file}, which this branch changes; fix its install instead of skipping it.`);
    }
  }
}

// pre-commit could not install a hook's own tools (not a problem in the code): which, and what to do.
function installFailure(output, hooks) {
  if (!/An unexpected error has occurred/.test(output)) return null;
  return installFailureOf(output, hooks).text;
}

// The repository whose tools failed, its hook ids, and the message.
function installFailureOf(output, hooks) {
  const repos = [...output.matchAll(/Installing environment for (\S+?)\.?\n/g)].map((m) => m[1]);
  const repo = repos.at(-1) || "a hook";
  const ids = hooks[repo] || [];
  const cause = (/npm error code (\w+)|error: (.+)/.exec(output) || [])[0] || "see the output";
  const npm = /EALLOWGIT/.test(output) ? " npm 11.12 and later refuse the install pre-commit makes for Node hooks (EALLOWGIT); an older npm works." : "";
  const hint = ids.length
    ? ` If the change has no file ${ids.join(", ")} check${ids.length > 1 ? "" : "s"}, run check again with skip_hooks: [${ids.map((i) => `"${i}"`).join(", ")}], and say so; otherwise fix the install first.`
    : "";
  return { ids, text: `pre-commit could not install the tools of ${repo} (${cause}). This is not a problem in the code.${npm}${hint}` };
}

function createLint({ git, runFn, env, uv, dataDir, log = () => {} }) {
  const uvRun = (cwd, pin, args, timeoutMs) => runFn(uv, ["tool", "run", "--from", pin, ...args], { cwd, env, timeoutMs });

  // Frappe's Semgrep rules, as CI clones them, kept in the plugin's data folder and refreshed weekly.
  function frappeRules() {
    const dir = path.join(dataDir, "frappe-semgrep-rules");
    if (!rulesInFlight.has(dir)) {
      rulesInFlight.set(
        dir,
        fetchRules(dir).finally(() => rulesInFlight.delete(dir)),
      );
    }
    return rulesInFlight.get(dir);
  }

  async function fetchRules(dir) {
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

  async function preCommit(root, from, head, changed, skip) {
    if (!changed.length) return { status: "skipped", detail: "no changed files" };
    const skipped = skip.length ? { skipped: skip } : {};
    const res = await runFn(uv, ["tool", "run", "--from", PINS.preCommit, "pre-commit", "run", "--from-ref", from, "--to-ref", head, "--show-diff-on-failure", "--color=never"], {
      cwd: root,
      env: skip.length ? { ...env, SKIP: skip.join(",") } : env,
      timeoutMs: 900000,
    });
    const touched = (await git.out(root, ["status", "--porcelain=v1"])).split("\n").filter(Boolean);
    if (res.timedOut) return { status: "failed", detail: "pre-commit took longer than 15 minutes", ...skipped };
    const output = `${res.stdout}\n${res.stderr}`;
    if (/An unexpected error has occurred/.test(output)) {
      const install = installFailureOf(output, preCommitHooks(root));
      return { status: "failed", installError: true, failedHooks: install.ids, detail: install.text, ...skipped };
    }
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
    // without --error Semgrep exits 0 with or without findings; anything else is a failed scan
    if (res.code !== 0 && res.code !== 1) {
      return { status: "failed", detail: `Semgrep stopped with exit code ${res.code}: ${tail(res.stderr, 8)}` };
    }
    // a rule or the scan itself failed: the scan did not cover what it should (warnings, such as a
    // file Semgrep could only partly parse, do not count)
    const errors = (report.errors || []).filter((e) => (e.level || "error") === "error");
    if (errors.length) {
      const first = errors.slice(0, 5).map((e) => String(e.message || e.type || "error").split("\n")[0].slice(0, 200));
      return { status: "failed", detail: `Semgrep reported ${errors.length} error(s):\n${first.join("\n")}` };
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
  // `head` is the commit the check is for: every step reads it, not whatever HEAD becomes meanwhile.
  async function check(root, base, skip = [], remote = "origin", head = "HEAD") {
    const p = plan(root);
    const from = await git.mergeBase(root, base, remote, head);
    const changed = await git.changedFiles(root, from, head);
    const steps = [];
    const step = async (name, fromCi, blocking, fn) => {
      log(`lint: ${name}`);
      try {
        steps.push({ name, fromCi, blocking, ...(await fn()) });
      } catch (e) {
        steps.push({ name, fromCi, blocking, status: "failed", detail: e.message });
      }
    };
    if (p.preCommit) await step("pre-commit", p.preCommit.fromCi, true, () => preCommit(root, from, head, changed, skip));
    if (p.semgrep) await step("semgrep", p.semgrep.fromCi, true, () => semgrep(root, from, p.semgrep.configs));
    if (p.flake8) await step("flake8", true, true, () => direct(root, "flake8", changed));
    if (p.ruff) await step("ruff", true, true, () => direct(root, "ruff", changed));
    await step("commit titles", p.commits.fromCi, p.commits.blocking, async () => commits(await git.commitsSince(root, from, head)));
    const passed = steps.every((s) => s.status !== "failed" || !s.blocking);
    return { passed, mergeBase: from, changedFiles: changed.length, steps };
  }

  return { check };
}

module.exports = {
  createLint,
  plan,
  semgrepConfigs,
  commitProblem,
  preCommitHooks,
  preCommitHookList,
  hookMayCheck,
  checkSkips,
  installFailure,
  PINS,
  CONVENTIONAL,
};
