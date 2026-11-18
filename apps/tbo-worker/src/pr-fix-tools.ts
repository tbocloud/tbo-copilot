import type { PluginToolDef } from "@pi-desktop/agent-runtime";
import type { LocalToolResult } from "@pi-desktop/host-runtime";

import { changes, runFixTool, type CheckRecord } from "./fix-tools.js";
import { MAX_OUTPUT_CHARS, gitEnv, runGit, runRepoGit } from "./repo-git.js";
import type { Sandbox } from "./sandbox.js";
import { TOOL_DEFINITIONS } from "./tools.js";

/**
 * The tools of a developer's pull request's fix (Phase 26): the sandbox, the change so far, the
 * repository's history, and pr_fix_done, which answers every finding. Four, as ToolSearch
 * activates at most four per query.
 */
export const PR_FIX_TOOL_NAMES = ["sandbox", "my_changes", "repo_git", "pr_fix_done"] as const;
export const PR_FIX_TOOL_SEARCH_QUERY = PR_FIX_TOOL_NAMES.join(" ");

/** One line per finding: TBO Support posts it as the reply to CodeRabbit's thread. */
export const MAX_REPLY_CHARS = 500;

const REPO_GIT = TOOL_DEFINITIONS.find((tool) => tool.name === "repo_git")!;

export const PR_FIX_TOOL_DEFINITIONS: PluginToolDef[] = [
  {
    name: "sandbox",
    description:
      "Run something on this job's sandbox site, which runs the pull request's app with your edits: check (one test module, such as demo_app.tests.test_invoice), tests (the app's own tests) or migrate (bench migrate with your change).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["check", "tests", "migrate"] },
        module: { type: "string", description: "check: the dotted test module, inside the app." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    risk: "low",
  },
  {
    name: "my_changes",
    description: "Your changes so far: every changed or new file and the diff against the pull request's head commit.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    risk: "low",
  },
  REPO_GIT,
  {
    name: "pr_fix_done",
    description:
      "Answer every finding once, at the end: fixed (with one line on what you changed) or not_fixed (with one line on why not). The worker then checks your change on the sandbox, commits it and pushes it to the pull request's branch. Call it once.",
    parameters: {
      type: "object",
      properties: {
        fixed: {
          type: "array",
          description: "The findings your change fixes.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The finding's id, as given." },
              note: { type: "string", maxLength: MAX_REPLY_CHARS, description: "One line: what you changed for it. Posted as the reply to the finding." },
            },
            required: ["id", "note"],
            additionalProperties: false,
          },
        },
        not_fixed: {
          type: "array",
          description: "The findings you leave as they are.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The finding's id, as given." },
              why: { type: "string", maxLength: MAX_REPLY_CHARS, description: "One line: why you left it. Posted as the reply to the finding." },
            },
            required: ["id", "why"],
            additionalProperties: false,
          },
        },
      },
      required: ["fixed", "not_fixed"],
      additionalProperties: false,
    },
    risk: "low",
  },
];

export type PrFixDone = {
  fixed: Array<{ id: string; note: string }>;
  not_fixed: Array<{ id: string; why: string }>;
};

/** What a pull request's fix session's tools work on. */
export type PrFixToolState = {
  app: string;
  /** The clone of the pull request at its head commit, the one folder the session may edit. */
  dir: string;
  homeDir: string;
  /** The sandbox site, when it could be started. */
  sandbox?: Sandbox;
  sandboxId?: string;
  /** Why there is no sandbox, for the model. */
  noSandbox?: string;
  checks: CheckRecord[];
  /** The findings the model was shown, each to be answered once. */
  findingIds: string[];
  done?: PrFixDone;
};

function result(ok: boolean, text: string): LocalToolResult {
  const content = text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[cut at ${MAX_OUTPUT_CHARS} characters]` : text;
  return ok ? { ok: true, content } : { ok: false, isError: true, content };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One line of the model's words, cut to the reply's length. */
function oneLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_REPLY_CHARS);
}

/**
 * The files the session changed, added or removed in the clone, relative to it, each as its real
 * path: NUL-separated, so git never quotes a name (café.py) and no name is trimmed.
 */
export async function changedPaths(dir: string, homeDir: string): Promise<string[]> {
  const env = gitEnv(homeDir);
  await runGit(dir, ["add", "--intent-to-add", "--all"], env);
  const names = await runGit(dir, ["diff", "--no-ext-diff", "--name-only", "--no-renames", "-z"], env);
  return names.split("\0").filter((name) => name !== "");
}

/**
 * pr_fix_done's answer: every finding shown once, as fixed or not, each with one line. A fix
 * listed without a change, or a change listed under no fix, is refused: the commit must be what
 * the replies say. The answer, or what is wrong with it.
 */
export function checkPrFixDone(args: Record<string, unknown>, ids: string[], changed: boolean): PrFixDone | string {
  const wanted = new Set(ids);
  const seen = new Set<string>();
  const problems: string[] = [];
  const take = (list: unknown, field: "note" | "why"): Array<{ id: string; text: string }> => {
    const out: Array<{ id: string; text: string }> = [];
    for (const item of (Array.isArray(list) ? list : []).map(record)) {
      const id = String(item.id ?? "").trim();
      const text = oneLine(item[field]);
      if (!wanted.has(id)) problems.push(`"${id.slice(0, 80)}" is not one of this job's findings`);
      else if (seen.has(id)) problems.push(`${id} is answered twice`);
      else if (!text) problems.push(`${id} needs ${field}: one line ${field === "note" ? "on what you changed" : "on why you left it"}`);
      else out.push({ id, text });
      seen.add(id);
    }
    return out;
  };
  const fixed = take(args.fixed, "note").map(({ id, text }) => ({ id, note: text }));
  const notFixed = take(args.not_fixed, "why").map(({ id, text }) => ({ id, why: text }));
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length) problems.push(`no answer for ${missing.join(", ")}: list each finding under fixed or not_fixed`);
  if (!problems.length && fixed.length && !changed) {
    problems.push("fixed lists findings, but the app has no changes: make the change, or move them to not_fixed with the reason");
  }
  if (!problems.length && !fixed.length && changed) {
    problems.push("the app has changes, but no finding is listed as fixed: say which finding the change is for, or put the files back as they were");
  }
  return problems.length ? problems.join("; ") : { fixed, not_fixed: notFixed };
}

export async function runPrFixTool(state: PrFixToolState, name: string, input: unknown): Promise<LocalToolResult> {
  const args = record(input);
  try {
    switch (name) {
      case "sandbox":
        if (!state.sandbox || !state.sandboxId) {
          return result(false, `This job has no sandbox (${state.noSandbox ?? "none is available"}). Check your change by reading it; the pull request's CI runs after the push.`);
        }
        return runFixTool({ app: state.app, dir: state.dir, homeDir: state.homeDir, apps: { [state.app]: state.dir }, sandbox: state.sandbox, sandboxId: state.sandboxId, checks: state.checks }, name, args);
      case "repo_git": {
        const reply = await runRepoGit({ [state.app]: state.dir }, args, { homeDir: state.homeDir });
        return result(reply.ok, reply.text);
      }
      case "my_changes":
        return result(true, await changes(state.dir, state.homeDir));
      case "pr_fix_done": {
        const answer = checkPrFixDone(args, state.findingIds, (await changedPaths(state.dir, state.homeDir)).length > 0);
        if (typeof answer === "string") return result(false, `Not recorded: ${answer}.`);
        state.done = answer;
        return result(true, "Recorded. The worker now checks the change on the sandbox, commits it and pushes it to the pull request's branch. Stop here.");
      }
      default:
        return result(false, `${name} is not a tool of this stage`);
    }
  } catch (error) {
    return result(false, `${name} failed: ${(error as Error).message}`);
  }
}
