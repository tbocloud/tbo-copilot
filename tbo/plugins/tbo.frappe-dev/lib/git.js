"use strict";

// The repository the agent works in, and the branch rules: a task's branch is named after the
// task, and the branches people share (main, develop, tbo, the repository's default) are never
// pushed to from here.

const fs = require("node:fs");
const path = require("node:path");
const { run, tail, fail } = require("./run");

const TASK = /^TASK-\d{4}-\d{5}$/i;
// the hub's own pattern (helpdesk/github_sync.py): not inside a longer word or number
const TASK_IN = /(?<![A-Za-z0-9])TASK-\d{4}-\d{5}(?!\d)/i;
const SHARED_BRANCHES = new Set(["main", "master", "develop", "tbo", "main-hotfix", "production", "staging"]);
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHORT_NAME_MAX = 40;

function taskId(value) {
  const id = String(value || "")
    .trim()
    .toUpperCase();
  if (!TASK.test(id)) throw fail("INVALID_ARGUMENT", '"task" must be a TBO Support task number such as TASK-2026-00021.');
  return id;
}

function taskOf(branch) {
  const m = TASK_IN.exec(branch || "");
  return m ? m[0].toUpperCase() : null;
}

// The task's subject as a branch's short name: ASCII letters and digits in lower case, joined by
// dashes, at most 40 characters, cut at a dash. Only this reaches the branch: task text is data.
function shortName(subject) {
  const words = String(subject || "")
    .replace(/<[^>]*>/g, " ") // a subject still wrapped in tbo_support's untrusted-content tags
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (words.length <= SHORT_NAME_MAX) return words;
  const cut = words.slice(0, SHORT_NAME_MAX + 1);
  const at = cut.lastIndexOf("-");
  return (at >= 12 ? cut.slice(0, at) : words.slice(0, SHORT_NAME_MAX)).replace(/-+$/, "");
}

function branchFor(task, subject, kind) {
  const prefix = kind === "fix" ? "fix" : "feature";
  const name = shortName(subject);
  return name ? `${prefix}/${task}-${name}` : `${prefix}/${task}`;
}

function checkBranchName(name, what) {
  const bad =
    !BRANCH_NAME.test(name) || name.includes("..") || name.includes("//") || name.endsWith("/") || name.endsWith(".lock") || name.includes("@{");
  if (bad) throw fail("INVALID_ARGUMENT", `${what} "${name}" is not a branch name.`);
  return name;
}

function githubSlug(url) {
  const m = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function createGit({ runFn = run, env } = {}) {
  async function git(cwd, args, { timeoutMs = 60000, allowFail = false } = {}) {
    const res = await runFn("git", args, { cwd, env, timeoutMs });
    if (res.timedOut) throw fail("TIMEOUT", `git ${args[0]} took too long; check the network and try again.`);
    if (res.code !== 0 && !allowFail) {
      throw fail("GIT_ERROR", `git ${args[0]} failed: ${tail(res.stderr || res.stdout, 8)}`);
    }
    return res;
  }

  const out = async (cwd, args, options) => (await git(cwd, args, options)).stdout.trim();

  async function isRepo(dir) {
    const res = await git(dir, ["rev-parse", "--show-toplevel"], { allowFail: true });
    return res.code === 0 ? res.stdout.trim() : null;
  }

  // The repository to work in: `repo` (a folder inside the workspace) or the workspace itself.
  // A workspace that is a bench, not a repository, names the app repositories it holds.
  async function resolve(workspace, repo) {
    if (!workspace) throw fail("NO_WORKSPACE", "Open the app's folder (or its bench) as the workspace first.");
    const wanted = repo ? path.resolve(workspace, String(repo)) : workspace;
    const rel = path.relative(fs.realpathSync(workspace), fs.existsSync(wanted) ? fs.realpathSync(wanted) : wanted);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw fail("INVALID_ARGUMENT", `"repo" must be a folder inside the workspace (${workspace}).`);
    const root = fs.existsSync(wanted) ? await isRepo(wanted) : null;
    if (root) return root;
    const found = [];
    for (const parent of [wanted, path.join(wanted, "apps")]) {
      let names = [];
      try {
        names = fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("."));
      } catch {
        continue;
      }
      for (const d of names) if (fs.existsSync(path.join(parent, d.name, ".git"))) found.push(path.relative(workspace, path.join(parent, d.name)));
    }
    const hint = found.length ? ` Pass "repo" as one of: ${found.slice(0, 12).join(", ")}.` : "";
    throw fail("NOT_A_REPO", `${wanted} is not a git repository.${hint}`);
  }

  async function info(root) {
    const branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true })).stdout.trim() || null;
    const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true })).stdout.trim() || null;
    // the address as configured (not rewritten by url.*.insteadOf): what the hub's GitHub settings name
    const url = (await git(root, ["config", "--get", "remote.origin.url"], { allowFail: true })).stdout.trim() || null;
    const dirty = (await out(root, ["status", "--porcelain=v1", "--untracked-files=normal"])).split("\n").filter(Boolean);
    return { root, branch, head, remote: url, github: githubSlug(url), defaultBranch: await defaultBranch(root), dirty, task: taskOf(branch) };
  }

  async function defaultBranch(root) {
    const sym = (await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowFail: true })).stdout.trim();
    if (sym.startsWith("origin/")) return sym.slice("origin/".length);
    for (const name of ["main", "master", "develop"]) {
      if (await hasRef(root, `refs/remotes/origin/${name}`)) return name;
    }
    return null;
  }

  async function hasRef(root, ref) {
    return (await git(root, ["show-ref", "--verify", "--quiet", ref], { allowFail: true })).code === 0;
  }

  // The branches never pushed to from here: the shared ones, the default and the task's base.
  function shared(branch, repo, base) {
    return SHARED_BRANCHES.has(branch) || branch === repo.defaultBranch || branch === base;
  }

  async function baseOf(root, branch) {
    return (await git(root, ["config", "--get", `branch.${branch}.tboBase`], { allowFail: true })).stdout.trim() || null;
  }

  async function setBase(root, branch, base) {
    await git(root, ["config", `branch.${branch}.tboBase`, base]);
  }

  // A branch (local or on origin) already named after the task, whatever its short name.
  async function taskBranch(root, task) {
    const local = (await out(root, ["branch", "--list", "--format=%(refname:short)"])).split("\n").filter((b) => taskOf(b) === task);
    if (local.length) return { name: local[0], where: "local" };
    const remote = (await git(root, ["ls-remote", "--heads", "origin"], { allowFail: true, timeoutMs: 30000 })).stdout
      .split("\n")
      .map((line) => line.split("refs/heads/")[1])
      .filter((b) => b && taskOf(b) === task);
    return remote.length ? { name: remote[0], where: "origin" } : null;
  }

  async function mergeBase(root, base) {
    return out(root, ["merge-base", "HEAD", `refs/remotes/origin/${base}`]);
  }

  async function changedFiles(root, from) {
    return (await out(root, ["diff", "--name-only", "--diff-filter=ACMR", from, "HEAD"])).split("\n").filter(Boolean);
  }

  async function commitsSince(root, from) {
    const text = await out(root, ["log", "--no-merges", "--format=%h%x00%s", `${from}..HEAD`]);
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\0");
        return { sha, subject };
      });
  }

  return { git, out, resolve, info, hasRef, shared, baseOf, setBase, taskBranch, mergeBase, changedFiles, commitsSince };
}

module.exports = { createGit, taskId, taskOf, shortName, branchFor, checkBranchName, githubSlug, SHARED_BRANCHES };
