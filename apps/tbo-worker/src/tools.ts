import type { PluginToolDef } from "@pi-desktop/agent-runtime";
import type { LocalToolResult } from "@pi-desktop/host-runtime";

import { HubError, type HubClient } from "./hub.js";
import { MAX_OUTPUT_CHARS, REPO_GIT_COMMANDS, runRepoGit } from "./repo-git.js";

/** The four tools a run's model gets. Four, because ToolSearch activates at most four per query. */
export const RUN_TOOL_NAMES = ["hub_get_run_context", "hub_customer_erp_read", "hub_submit_investigation", "repo_git"] as const;
export type RunToolName = (typeof RUN_TOOL_NAMES)[number];
export const TOOL_SEARCH_QUERY = RUN_TOOL_NAMES.join(" ");

/** helpdesk.copilot.router.CATEGORIES */
export const CATEGORIES = [
  "question",
  "not_allowed_request",
  "customer_mistake",
  "wrong_setting",
  "bug",
  "data_damaged_by_bug",
  "core_issue",
  "unclear",
] as const;

/** helpdesk.copilot.mcp.tools_worker.CUSTOMER_READ_TOOLS */
export const CUSTOMER_READ_TOOLS = [
  "get_doc",
  "get_list",
  "get_count",
  "get_meta",
  "get_error_log",
  "execute_report",
  "get_installed_apps",
  "get_site_info",
  "get_code_identity",
  "get_customizations",
  "get_deploy_status",
  "get_version_history",
] as const;

export const TOOL_DEFINITIONS: PluginToolDef[] = [
  {
    name: "hub_get_run_context",
    description: "This run's ticket, triage, customer, site and apps, conversation, files and earlier runs, fresh from TBO Support.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    risk: "low",
  },
  {
    name: "hub_customer_erp_read",
    description:
      "Read the ticket's customer ERPNext site through TBO Support with one allow-listed read tool, for example get_error_log, get_version_history, get_doc, get_list or get_customizations. Results are capped.",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", enum: [...CUSTOMER_READ_TOOLS] },
        arguments: { type: "object", description: "The read tool's arguments, for example {\"doctype\": \"Sales Invoice\", \"name\": \"ACC-SINV-2026-00042\"}." },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    risk: "low",
  },
  {
    name: "hub_submit_investigation",
    description: "Report the root cause, confidence, evidence and proposal for this run. Call it exactly once, at the end; it ends the investigation.",
    parameters: {
      type: "object",
      properties: {
        root_cause_category: { type: "string", enum: [...CATEGORIES] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        summary: { type: "string", maxLength: 4000 },
        evidence: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: { type: { type: "string" }, ref: { type: "string" }, note: { type: "string" } },
          },
        },
        proposal: { type: "object", properties: { action: { type: "string" }, files: { type: "array", items: { type: "string" } }, risk: { type: "string" }, notes: { type: "string" } } },
        customer_message: { type: "string", maxLength: 4000 },
        questions: { type: "array", maxItems: 10, items: { type: "string" } },
      },
      required: ["root_cause_category", "confidence", "summary", "evidence"],
      additionalProperties: false,
    },
    risk: "low",
  },
  {
    name: "repo_git",
    description:
      "Read-only git in one of this run's app clones (apps/<app>): log (path, search, message, rev, max_count), show (rev, path), blame (path, lines, rev) or diff (rev, rev2, path).",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app folder name under apps/." },
        command: { type: "string", enum: [...REPO_GIT_COMMANDS] },
        rev: { type: "string" },
        rev2: { type: "string" },
        path: { type: "string" },
        max_count: { type: "integer", minimum: 1, maximum: 50 },
        search: { type: "string", description: "log: commits that add or remove this text." },
        message: { type: "string", description: "log: commits whose message contains this text." },
        lines: { type: "string", description: "blame: a line range such as 120,160." },
      },
      required: ["app", "command"],
      additionalProperties: false,
    },
    risk: "low",
  },
];

/** What a run's tools need: the run token, the clones, and the run's own bookkeeping. */
export type RunTools = {
  runToken: string;
  apps: Record<string, string>;
  homeDir: string;
  /** Tokens, dollars and the model so far; replaces whatever cost the model reports. */
  cost: () => Record<string, unknown>;
  /** Sends the run's pending events; called before the report, because the lease ends with it. */
  beforeSubmit: () => Promise<void>;
  /** The hub accepted the report. */
  submitted: (result: string) => void;
  isSubmitted: () => boolean;
};

function result(ok: boolean, text: string): LocalToolResult {
  const content = text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[cut at ${MAX_OUTPUT_CHARS} characters]` : text;
  return ok ? { ok: true, content } : { ok: false, isError: true, content };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The report's shape, checked here so the model hears what to fix before the hub sees it. */
export function checkReport(args: Record<string, unknown>): string | undefined {
  if (!CATEGORIES.includes(args.root_cause_category as (typeof CATEGORIES)[number])) {
    return `root_cause_category must be one of: ${CATEGORIES.join(", ")}`;
  }
  const confidence = Number(args.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return "confidence must be a number from 0 to 1";
  if (typeof args.summary !== "string" || !args.summary.trim()) return "summary is required";
  if (args.evidence !== undefined && !Array.isArray(args.evidence)) return "evidence must be a list";
  return undefined;
}

/** Runs one of the run's tools. Hub refusals reach the model as tool errors, in plain words. */
export async function runTool(hub: HubClient, tools: RunTools, name: string, input: unknown): Promise<LocalToolResult> {
  const args = record(input);
  try {
    switch (name as RunToolName) {
      case "hub_get_run_context": {
        const reply = await hub.callTool(tools.runToken, "get_run_context", {});
        return result(!reply.isError, reply.text);
      }
      case "hub_customer_erp_read": {
        const tool = String(args.tool ?? "");
        if (!CUSTOMER_READ_TOOLS.includes(tool as (typeof CUSTOMER_READ_TOOLS)[number])) {
          return result(false, `tool must be one of: ${CUSTOMER_READ_TOOLS.join(", ")}`);
        }
        const reply = await hub.callTool(tools.runToken, "customer_erp_read", { tool, arguments: record(args.arguments) });
        return result(!reply.isError, reply.text);
      }
      case "hub_submit_investigation": {
        if (tools.isSubmitted()) return result(true, "Already submitted. Reply with one short sentence and stop.");
        const problem = checkReport(args);
        if (problem) return result(false, `Not submitted: ${problem}. Fix it and call hub_submit_investigation again.`);
        await tools.beforeSubmit();
        const reply = await hub.callTool(tools.runToken, "submit_investigation", { ...args, cost: tools.cost() });
        if (reply.isError) return result(false, `TBO Support refused the report: ${reply.text}`);
        tools.submitted(reply.text);
        return result(true, `Submitted. ${reply.text}\nReply with one short sentence and stop.`);
      }
      case "repo_git": {
        const reply = await runRepoGit(tools.apps, args, { homeDir: tools.homeDir });
        return result(reply.ok, reply.text);
      }
      default:
        return result(false, `${name} is not a tool of this run`);
    }
  } catch (error) {
    if (error instanceof HubError && error.leaseGone) {
      return result(false, "This run's lease has ended; TBO Support no longer accepts calls for it. Stop now.");
    }
    return result(false, `${name} failed: ${(error as Error).message}`);
  }
}
