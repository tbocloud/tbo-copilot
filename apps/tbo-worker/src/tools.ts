import type { PluginToolDef } from "@pi-desktop/agent-runtime";
import type { LocalToolResult } from "@pi-desktop/host-runtime";

import { HubError, type HubClient } from "./hub.js";
import { MAX_OUTPUT_CHARS, REPO_GIT_COMMANDS, runRepoGit } from "./repo-git.js";

/** The four tools a run's model gets. Four, because ToolSearch activates at most four per query. */
export const RUN_TOOL_NAMES = ["hub_get_run_context", "hub_customer_erp_read", "hub_submit_investigation", "repo_git"] as const;

/** At most this many records per correction: more is a data patch in the customer's app. */
export const MAX_CHANGE_RECORDS = 1000;
/** At most this many records left to a person in one report. */
export const MAX_SET_ASIDE = 200;
/** A customization's draft scope, as TBO Support keeps it in the estimate (helpdesk api.customization). */
export const MAX_SCOPE_CHARS = 4000;
export const MAX_DONE_WHEN = 15;
/** At most this many site errors a report names (Phase 9: they link the ticket to Copilot's known issues). */
export const MAX_ERROR_SIGNATURES = 10;
/** The causes a correction belongs to (customer_mistake only when an agent asked for it). */
export const CORRECTED_CATEGORIES = ["wrong_setting", "data_damaged_by_bug", "customer_mistake"];
/** Never corrected by Copilot; the hub and the customer's site refuse them too. */
export const NEVER_CHANGED = [
  "User", "Role", "Has Role", "DocPerm", "Custom DocPerm", "User Permission", "Role Profile", "Module Profile",
  "System Settings", "Email Account", "Email Domain", "OAuth Client", "Social Login Key", "Connected App", "Token Cache",
  "Server Script", "Client Script", "Scheduled Job Type", "Custom Field", "Property Setter", "DocType", "Workflow",
  "Print Format", "Bulk Update", "Data Import",
];
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
  "customization_request",
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
        proposal: {
          type: "object",
          properties: {
            action: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            risk: { type: "string" },
            notes: { type: "string" },
            estimate_hours: { type: "number" },
            scope: { type: "string", maxLength: MAX_SCOPE_CHARS, description: "customization_request: what would be built, in plain words the customer can approve." },
            done_when: {
              type: "array",
              maxItems: MAX_DONE_WHEN,
              items: { type: "string", maxLength: 300 },
              description: "customization_request: the checks that show it is done, one behaviour each, each one a test can show.",
            },
          },
        },
        customer_message: { type: "string", maxLength: 4000 },
        questions: { type: "array", maxItems: 10, items: { type: "string" } },
        change_set: {
          type: "object",
          description:
            "Only for wrong_setting, data_damaged_by_bug, or customer_mistake when the context says prepare_correction: every record to correct with its new values. A senior approves it before anything changes.",
          properties: {
            summary: { type: "string", maxLength: 2000 },
            customer_note: { type: "string", maxLength: 2000, description: "What the customer reads once it is applied." },
            found_by: { type: "string", maxLength: 2000, description: "How the records were found: the doctype and filters." },
            changes: {
              type: "array",
              maxItems: MAX_CHANGE_RECORDS,
              items: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["update", "create"] },
                  doctype: { type: "string" },
                  name: { type: "string", description: "The record to update; not for create." },
                  values: { type: "object", description: "Field: new value." },
                  rows: { type: "array", items: { type: "object" }, description: "Existing table rows to change: {table, name, values}." },
                  add_rows: { type: "array", items: { type: "object" }, description: "New table rows: {table, values}." },
                  why: { type: "string", maxLength: 1000 },
                },
                required: ["doctype"],
              },
            },
            set_aside: {
              type: "array",
              maxItems: MAX_SET_ASIDE,
              items: {
                type: "object",
                properties: { doctype: { type: "string" }, name: { type: "string" }, why: { type: "string" } },
                required: ["doctype", "name"],
              },
              description: "Records a person must correct: submitted documents, and anything Copilot may not change.",
            },
          },
        },
        error_signatures: {
          type: "array",
          maxItems: MAX_ERROR_SIGNATURES,
          items: { type: "string", maxLength: 600 },
          description:
            "The site errors the finding rests on, each as 'app | method | the error's last line', from get_error_log (its app, method and the last line of error). TBO Support keeps only errors the site gave this run.",
        },
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
  /** The run context says an agent asked for the correction of the customer's own mistake. */
  prepareCorrection?: boolean;
};

function result(ok: boolean, text: string): LocalToolResult {
  const content = text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[cut at ${MAX_OUTPUT_CHARS} characters]` : text;
  return ok ? { ok: true, content } : { ok: false, isError: true, content };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The correction's shape: what the hub would refuse, said to the model first. */
export function checkChangeSet(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const set = record(value);
  if (value !== set) return "change_set must be an object";
  const changes = set.changes ?? [];
  if (!Array.isArray(changes)) return "change_set.changes must be a list";
  if (changes.length > MAX_CHANGE_RECORDS) {
    return `change_set holds at most ${MAX_CHANGE_RECORDS} records; for more, propose a data patch in the customer's app instead`;
  }
  for (const [i, raw] of changes.entries()) {
    const change = record(raw);
    const action = change.action ?? "update";
    if (action !== "update" && action !== "create") return `change ${i + 1}: Copilot updates or creates records, never ${String(action)}`;
    if (typeof change.doctype !== "string" || !change.doctype) return `change ${i + 1}: doctype is required`;
    if (NEVER_CHANGED.includes(change.doctype)) return `change ${i + 1}: Copilot never changes ${change.doctype} records`;
    if (action === "update" && (typeof change.name !== "string" || !change.name)) return `change ${i + 1}: name the record it updates`;
    const values = change.values ?? {};
    if (values !== record(values)) return `change ${i + 1}: values must be an object of field: new value`;
    const rows = change.rows ?? [];
    const added = change.add_rows ?? [];
    if (!Array.isArray(rows) || !Array.isArray(added)) return `change ${i + 1}: rows and add_rows must be lists`;
    if (!Object.keys(values as object).length && !rows.length && !added.length) return `change ${i + 1}: it must change something`;
  }
  const aside = set.set_aside ?? [];
  if (!Array.isArray(aside)) return "change_set.set_aside must be a list";
  if (!changes.length && !aside.length) return "change_set must list at least one record to change or set aside; send none when nothing is due";
  if (aside.length > MAX_SET_ASIDE) return `change_set.set_aside holds at most ${MAX_SET_ASIDE} records`;
  for (const [i, raw] of aside.entries()) {
    const item = record(raw);
    if (typeof item.doctype !== "string" || !item.doctype || typeof item.name !== "string" || !item.name) {
      return `set_aside ${i + 1}: name its doctype and record`;
    }
  }
  return undefined;
}

/** The report's shape, checked here so the model hears what to fix before the hub sees it.
 * `prepareCorrection`: the run context says an agent asked for the correction of a customer's mistake. */
export function checkReport(args: Record<string, unknown>, prepareCorrection = false): string | undefined {
  if (!CATEGORIES.includes(args.root_cause_category as (typeof CATEGORIES)[number])) {
    return `root_cause_category must be one of: ${CATEGORIES.join(", ")}`;
  }
  const confidence = Number(args.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return "confidence must be a number from 0 to 1";
  if (typeof args.summary !== "string" || !args.summary.trim()) return "summary is required";
  if (args.evidence !== undefined && !Array.isArray(args.evidence)) return "evidence must be a list";
  const signatures = args.error_signatures;
  if (
    signatures !== undefined &&
    !(
      Array.isArray(signatures) &&
      signatures.length <= MAX_ERROR_SIGNATURES &&
      signatures.every((item) => typeof item === "string" && item.trim() && item.length <= 600)
    )
  ) {
    return `error_signatures must be a list of at most ${MAX_ERROR_SIGNATURES} texts, each "app | method | the error's last line", or left out`;
  }
  if (args.change_set !== undefined && args.change_set !== null) {
    const category = String(args.root_cause_category);
    if (!CORRECTED_CATEGORIES.includes(category)) {
      return `a change_set goes only with ${CORRECTED_CATEGORIES.join(", ")}; leave it out for ${category}`;
    }
    if (category === "customer_mistake" && !prepareCorrection) {
      return "a customer's mistake is explained, not corrected, unless an agent asked for the correction (prepare_correction in the run context): leave change_set out";
    }
  }
  if (args.root_cause_category === "customization_request") {
    if (typeof args.customer_message !== "string" || !args.customer_message.trim()) {
      return "customer_message is required for customization_request: say kindly that it is a change, not a fault";
    }
    // an estimate the model cannot make does not block the report: the agent fills it in on the estimate card
    const proposal = record(args.proposal);
    const hours = proposal.estimate_hours;
    if (hours !== undefined && !(typeof hours === "number" && Number.isFinite(hours) && hours > 0)) {
      return "proposal.estimate_hours must be a positive number of hours, or left out";
    }
    // the draft of the scope the customer approves (Phase 8): optional, but well formed when given
    if (proposal.scope !== undefined && (typeof proposal.scope !== "string" || proposal.scope.length > MAX_SCOPE_CHARS)) {
      return `proposal.scope must be text of at most ${MAX_SCOPE_CHARS} characters, or left out`;
    }
    const doneWhen = proposal.done_when;
    if (
      doneWhen !== undefined &&
      !(Array.isArray(doneWhen) && doneWhen.length <= MAX_DONE_WHEN && doneWhen.every((item) => typeof item === "string" && item.trim() && item.length <= 300))
    ) {
      return `proposal.done_when must be a list of at most ${MAX_DONE_WHEN} checks, each a short sentence, or left out`;
    }
  }
  return checkChangeSet(args.change_set);
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
        const problem = checkReport(args, tools.prepareCorrection === true);
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
