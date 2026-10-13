import type { PluginToolDef } from "@pi-desktop/agent-runtime";
import type { LocalToolResult } from "@pi-desktop/host-runtime";

import { MAX_OUTPUT_CHARS, gitEnv, runGit, runRepoGit } from "./repo-git.js";
import { MODULE, SandboxError, type Sandbox, type SandboxResult } from "./sandbox.js";
import { TOOL_DEFINITIONS } from "./tools.js";

/** The fix session's four tools (ToolSearch activates at most four per query). */
export const FIX_TOOL_NAMES = ["sandbox", "my_changes", "repo_git", "fix_done"] as const;
export const FIX_TOOL_SEARCH_QUERY = FIX_TOOL_NAMES.join(" ");
/** The review session's two tools. */
export const REVIEW_TOOL_NAMES = ["my_changes", "review_done"] as const;
export const REVIEW_TOOL_SEARCH_QUERY = REVIEW_TOOL_NAMES.join(" ");

const REPO_GIT = TOOL_DEFINITIONS.find((tool) => tool.name === "repo_git")!;
const MY_CHANGES: PluginToolDef = {
  name: "my_changes",
  description: "The changes made so far in the app being fixed: every changed or new file and the diff against the code the customer's site runs.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  risk: "low",
};

export const FIX_TOOL_DEFINITIONS: PluginToolDef[] = [
  {
    name: "sandbox",
    description:
      "Run something on this run's sandbox copy of the customer's site, which runs your edited app: check (one test module, such as demo_app.tests.test_copilot_margin: your reproduction), tests (the app's own tests) or migrate (bench migrate with your change).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["check", "tests", "migrate"] },
        module: { type: "string", description: "check: the dotted test module, inside the app you fix." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    risk: "low",
  },
  MY_CHANGES,
  REPO_GIT,
  {
    name: "fix_done",
    description:
      "Say the fix is ready. The worker then runs the checks again itself, has the change reviewed and opens the pull request. Call it once, at the end.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", maxLength: 200, description: "One line: what the fix does, for the pull request's title." },
        test_module: { type: "string", description: "The test module that reproduces the bug: it fails without your change and passes with it." },
        explanation: { type: "string", maxLength: 3000, description: "What was wrong and what you changed, for the pull request." },
        people_checks: { type: "array", maxItems: 10, items: { type: "string" }, description: "What a person should still check before approving." },
        risk_notes: { type: "string", maxLength: 2000 },
      },
      required: ["summary", "test_module", "explanation"],
      additionalProperties: false,
    },
    risk: "low",
  },
];

export const REVIEW_TOOL_DEFINITIONS: PluginToolDef[] = [
  MY_CHANGES,
  {
    name: "review_done",
    description: "Your review of the change. Call it once: an empty list when you find nothing.",
    parameters: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["must_fix", "note"] },
              file: { type: "string" },
              note: { type: "string", maxLength: 1000 },
            },
            required: ["severity", "note"],
          },
        },
      },
      required: ["findings"],
      additionalProperties: false,
    },
    risk: "low",
  },
];

export type FixDone = { summary: string; test_module: string; explanation: string; people_checks: string[]; risk_notes: string };
export type Finding = { severity: "must_fix" | "note"; file?: string; note: string };
export type CheckRecord = { action: string; module?: string; ok: boolean; at: number };

/** What a fix or review session's tools work on. */
export type FixToolState = {
  app: string;
  dir: string;
  homeDir: string;
  apps: Record<string, string>;
  sandbox: Sandbox;
  sandboxId: string;
  checks: CheckRecord[];
  done?: FixDone;
  findings?: Finding[];
};

function result(ok: boolean, text: string): LocalToolResult {
  const content = text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[cut at ${MAX_OUTPUT_CHARS} characters]` : text;
  return ok ? { ok: true, content } : { ok: false, isError: true, content };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A test module inside the app being fixed, such as demo_app.tests.test_margin. */
export function checkModule(app: string, module: unknown): string | undefined {
  return typeof module === "string" && MODULE.test(module) && module.startsWith(`${app}.`) ? module : undefined;
}

export function describeRun(what: string, run: SandboxResult): string {
  const tail = run.output.length > 6_000 ? `…${run.output.slice(-6_000)}` : run.output;
  const failed = run.failure === "assertion" ? "FAILED on an assertion" : run.failure === "error" ? "ERRORED (not an assertion)" : "FAILED";
  return `${what}: ${run.ok ? "PASSED" : `${failed} (exit ${run.exit_code})`} in ${Math.round(run.ms / 100) / 10} s\n${tail}`;
}

/** The working tree's changes against the commit the clone started at, new files included. */
export async function changes(dir: string, homeDir: string): Promise<string> {
  const env = gitEnv(homeDir);
  await runGit(dir, ["add", "--intent-to-add", "--all"], env);
  const status = await runGit(dir, ["status", "--porcelain", "--untracked-files=all"], env);
  if (!status.trim()) return "No changes yet.";
  const diff = await runGit(dir, ["diff", "--no-color", "--no-ext-diff", "--stat", "--patch"], env);
  return `${status.trim()}\n\n${diff}`;
}

export async function runFixTool(state: FixToolState, name: string, input: unknown): Promise<LocalToolResult> {
  const args = record(input);
  try {
    switch (name) {
      case "sandbox": {
        const action = String(args.action ?? "");
        if (action === "check") {
          const module = checkModule(state.app, args.module);
          if (!module) return result(false, `module must be a dotted test module inside ${state.app}, such as ${state.app}.tests.test_copilot_fix`);
          const run = await state.sandbox.check(state.sandboxId, state.app, module);
          state.checks.push({ action, module, ok: run.ok, at: Date.now() });
          return result(true, describeRun(`check ${module}`, run));
        }
        if (action === "tests" || action === "migrate") {
          const run = action === "tests" ? await state.sandbox.tests(state.sandboxId, state.app) : await state.sandbox.migrate(state.sandboxId);
          state.checks.push({ action, ok: run.ok, at: Date.now() });
          return result(true, describeRun(action, run));
        }
        return result(false, "action must be check, tests or migrate");
      }
      case "my_changes":
        return result(true, await changes(state.dir, state.homeDir));
      case "repo_git": {
        const reply = await runRepoGit(state.apps, args, { homeDir: state.homeDir });
        return result(reply.ok, reply.text);
      }
      case "fix_done": {
        const summary = String(args.summary ?? "").replace(/\s+/g, " ").trim();
        const module = checkModule(state.app, args.test_module);
        const explanation = String(args.explanation ?? "").trim();
        if (!summary || !module || !explanation) {
          return result(false, `Not recorded: summary, explanation and test_module (a test module inside ${state.app}) are required.`);
        }
        state.done = {
          summary: summary.slice(0, 200),
          test_module: module,
          explanation: explanation.slice(0, 3000),
          people_checks: (Array.isArray(args.people_checks) ? args.people_checks : []).map((item) => String(item).slice(0, 300)).slice(0, 10),
          risk_notes: String(args.risk_notes ?? "").slice(0, 2000),
        };
        return result(true, "Recorded. The worker now runs the checks itself, has the change reviewed and opens the pull request. Stop here.");
      }
      case "review_done": {
        const findings = (Array.isArray(args.findings) ? args.findings : [])
          .map((item) => record(item))
          .filter((item) => typeof item.note === "string" && item.note.trim())
          .map((item) => ({
            severity: item.severity === "must_fix" ? ("must_fix" as const) : ("note" as const),
            ...(typeof item.file === "string" && item.file ? { file: item.file.slice(0, 300) } : {}),
            note: String(item.note).slice(0, 1000),
          }))
          .slice(0, 20);
        state.findings = findings;
        return result(true, "Recorded. Stop here.");
      }
      default:
        return result(false, `${name} is not a tool of this stage`);
    }
  } catch (error) {
    if (error instanceof SandboxError) return result(false, `The sandbox could not do it: ${error.message}`);
    return result(false, `${name} failed: ${(error as Error).message}`);
  }
}
