import { execFile } from "node:child_process";

/**
 * `repo_git`: read-only git in a run's clones. The model names a command and
 * a few typed values, never raw arguments, so it cannot reach an option that
 * writes (`--output`, `-c`, hooks). Every value is checked, revisions and
 * paths come after `--end-of-options` and `--`, and pathspecs are literal.
 */
export const REPO_GIT_COMMANDS = ["log", "show", "blame", "diff"] as const;
export type RepoGitCommand = (typeof REPO_GIT_COMMANDS)[number];

export type RepoGitArgs = {
  app: string;
  command: RepoGitCommand;
  rev?: string;
  rev2?: string;
  path?: string;
  max_count?: number;
  /** log: commits that add or remove this text (`-S`). */
  search?: string;
  /** log: commits whose message contains this text. */
  message?: string;
  /** blame: `start,end` line range. */
  lines?: string;
};

export class RepoGitError extends Error {}

const REV = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,99}$/;
const LINES = /^\d{1,6},\d{1,6}$/;
export const MAX_OUTPUT_CHARS = 64_000;

function checkRev(value: unknown, what: string): string {
  if (typeof value !== "string" || !REV.test(value) || value.includes("..") || value.endsWith(".lock")) {
    throw new RepoGitError(`${what} must be a commit, tag or branch name such as HEAD~3 or a1b2c3d`);
  }
  return value;
}

function checkPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new RepoGitError("path must be a file path inside the app");
  const path = value.trim().replace(/^\.\/+/, "");
  if (
    path.length > 300 ||
    path.startsWith("/") ||
    path.startsWith("-") ||
    /[\0\n\r]/.test(path) ||
    path.split("/").some((segment) => segment === "..")
  ) {
    throw new RepoGitError("path must be a relative path inside the app, without ..");
  }
  return path;
}

function checkText(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\0\n\r]/.test(value)) {
    throw new RepoGitError(`${what} must be one line of at most 200 characters`);
  }
  return value;
}

/** The git arguments for a request (after `git`), or a RepoGitError saying what is wrong. */
export function buildGitArgs(input: unknown): string[] {
  const args = (input ?? {}) as Partial<RepoGitArgs>;
  if (!REPO_GIT_COMMANDS.includes(args.command as RepoGitCommand)) {
    throw new RepoGitError(`command must be one of ${REPO_GIT_COMMANDS.join(", ")}`);
  }
  const base = ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.hooksPath=/dev/null"];
  const path = args.path === undefined || args.path === "" ? undefined : checkPath(args.path);
  const tail = path ? ["--", path] : ["--"];
  switch (args.command) {
    case "log": {
      const count = args.max_count === undefined ? 20 : Number(args.max_count);
      if (!Number.isInteger(count) || count < 1 || count > 50) throw new RepoGitError("max_count must be 1 to 50");
      const out = [...base, "log", "--no-color", "--date=short", "--format=%h %ad %an %s", "--stat", `--max-count=${count}`];
      if (args.search !== undefined) out.push(`-S${checkText(args.search, "search")}`);
      if (args.message !== undefined) out.push("--fixed-strings", "--regexp-ignore-case", `--grep=${checkText(args.message, "message")}`);
      out.push("--end-of-options");
      if (args.rev !== undefined) out.push(checkRev(args.rev, "rev"));
      return [...out, ...tail];
    }
    case "show":
      return [...base, "show", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", "--patch", "--format=fuller", "--end-of-options", checkRev(args.rev, "rev"), ...tail];
    case "blame": {
      if (!path) throw new RepoGitError("blame needs a path");
      const out = [...base, "blame", "-w"];
      if (args.lines !== undefined) {
        if (typeof args.lines !== "string" || !LINES.test(args.lines)) throw new RepoGitError("lines must look like 120,160");
        out.push("-L", args.lines);
      }
      // blame misreads `--end-of-options` before `--`; the revision is checked and cannot start with a dash
      return [...out, args.rev === undefined ? "HEAD" : checkRev(args.rev, "rev"), ...tail];
    }
    case "diff": {
      const from = checkRev(args.rev, "rev");
      const to = checkRev(args.rev2, "rev2");
      return [...base, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", "--patch", "--end-of-options", `${from}..${to}`, ...tail];
    }
    default:
      throw new RepoGitError("unknown command");
  }
}

/** The environment git runs with: no user or system config, no prompts, no pager. */
export function gitEnv(homeDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: homeDir,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    ...extra,
  };
}

/** Runs git and resolves with stdout; rejects with the stderr text on failure. */
export function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 2000)));
      else resolve(stdout);
    });
  });
}

/** Runs one `repo_git` request in the app's clone; the text is cut at MAX_OUTPUT_CHARS. */
export async function runRepoGit(
  apps: Record<string, string>,
  input: unknown,
  options: { homeDir: string; timeoutMs?: number },
): Promise<{ ok: boolean; text: string }> {
  const app = (input as { app?: unknown } | null)?.app;
  if (typeof app !== "string" || !apps[app]) {
    return { ok: false, text: `app must be one of: ${Object.keys(apps).join(", ") || "(no app was cloned for this run)"}` };
  }
  let args: string[];
  try {
    args = buildGitArgs(input);
  } catch (error) {
    return { ok: false, text: (error as Error).message };
  }
  try {
    const out = await runGit(apps[app]!, args, gitEnv(options.homeDir), options.timeoutMs ?? 30_000);
    if (!out.trim()) return { ok: true, text: "(no output)" };
    return {
      ok: true,
      text: out.length > MAX_OUTPUT_CHARS ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n[cut at ${MAX_OUTPUT_CHARS} characters]` : out,
    };
  } catch (error) {
    return { ok: false, text: `git ${args.find((a) => REPO_GIT_COMMANDS.includes(a as RepoGitCommand))} failed: ${(error as Error).message}` };
  }
}
