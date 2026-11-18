import type { PluginToolDef } from "@pi-desktop/agent-runtime";
import type { LocalToolResult } from "@pi-desktop/host-runtime";

import { HubError, type HubClient } from "./hub.js";
import { MAX_OUTPUT_CHARS } from "./repo-git.js";
import { redactSecrets } from "./suspicious.js";

/**
 * The tools of an infrastructure alert's run (Phase 25): Press reads through TBO Support, a
 * progress note, and the report. No files, repositories, customer sites or sandbox.
 */
export const INFRA_TOOL_NAMES = ["hub_press_read", "hub_post_event", "hub_submit_infra_investigation"] as const;
export type InfraToolName = (typeof INFRA_TOOL_NAMES)[number];
export const INFRA_TOOL_SEARCH_QUERY = INFRA_TOOL_NAMES.join(" ");

/** helpdesk.copilot.mcp.tools_worker.press_read */
export const PRESS_READS = ["site_status", "jobs", "job", "failed_jobs", "site_logs"] as const;
export const MAX_PRESS_HOURS = 72;

/** What TBO Support keeps of a report (helpdesk.copilot.infra: TEXT_CHARS, LINE_CHARS, EVIDENCE_ITEMS). */
export const MAX_SUMMARY_CHARS = 4000;
export const MAX_LINE_CHARS = 500;
export const MAX_EVIDENCE_LINES = 20;
export const MAX_PERSON_STEPS_CHARS = 2000;
export const MAX_NOTE_CHARS = 500;

export const INFRA_TOOL_DEFINITIONS: PluginToolDef[] = [
  {
    name: "hub_press_read",
    description:
      "Read Press through TBO Support, read only, secrets taken out: site_status (site), jobs (site or bench: the recent jobs), job (job: one job's steps and output), failed_jobs (hours: failed jobs on every bench), site_logs (site).",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", enum: [...PRESS_READS] },
        site: { type: "string", maxLength: 200 },
        bench: { type: "string", maxLength: 200 },
        job: { type: "string", maxLength: 140 },
        hours: { type: "integer", minimum: 1, maximum: MAX_PRESS_HOURS },
      },
      required: ["what"],
      additionalProperties: false,
    },
    risk: "low",
  },
  {
    name: "hub_post_event",
    description: "A short progress note for TBO's people on this run: what you are checking and why. Never a secret.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", maxLength: MAX_NOTE_CHARS } },
      required: ["text"],
      additionalProperties: false,
    },
    risk: "low",
  },
  {
    name: "hub_submit_infra_investigation",
    description:
      "Report what you found and at most one action from this run's list, with a target from may_target. Nothing runs before a person approves it. Call it exactly once, at the end; it ends the investigation.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", maxLength: MAX_SUMMARY_CHARS },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        cause: { type: "string", maxLength: MAX_LINE_CHARS, description: "The most likely cause, in one line." },
        evidence: {
          type: "array",
          maxItems: MAX_EVIDENCE_LINES,
          items: { type: "string", maxLength: MAX_LINE_CHARS },
          description: "Short lines, each naming what it rests on (a job, a step, a log line, a status) and what it shows.",
        },
        proposal: {
          type: "object",
          description: "At most one action; leave it out when no listed action would plausibly fix the cause.",
          properties: {
            action: { type: "string", description: "One action name from this run's list." },
            target: { type: "string", description: "One name from may_target." },
            why: { type: "string", maxLength: MAX_LINE_CHARS, description: "The cause, and the evidence that this action addresses it." },
            expected: { type: "string", maxLength: MAX_LINE_CHARS, description: "What should change if it works." },
          },
          required: ["action", "target", "why", "expected"],
          additionalProperties: false,
        },
        person_steps: {
          type: "string",
          maxLength: MAX_PERSON_STEPS_CHARS,
          description: "What a person should check or do, in order. Required when there is no proposal.",
        },
      },
      required: ["summary", "confidence"],
      additionalProperties: false,
    },
    risk: "low",
  },
];

/** What an infrastructure run's tools need: the run token, the run's lists, and its bookkeeping. */
export type InfraTools = {
  runToken: string;
  /** The names of the actions Copilot may propose. */
  actions: string[];
  /** The names a proposal's target must come from. */
  mayTarget: string[];
  /** Tokens, dollars and the model so far; sent with the report. */
  cost: () => Record<string, unknown>;
  /** Records the model's progress note among the run's events. */
  note: (text: string) => void;
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

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The confidence as a number (a model may send "0.8"); NaN when there is none. */
function confidenceOf(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
}

/** The Press read's arguments as TBO Support takes them, or what is wrong with them. */
export function pressReadArguments(args: Record<string, unknown>): Record<string, unknown> | string {
  const what = String(args.what ?? "");
  if (!PRESS_READS.includes(what as (typeof PRESS_READS)[number])) return `what must be one of: ${PRESS_READS.join(", ")}`;
  const site = text(args.site).slice(0, 200);
  const bench = text(args.bench).slice(0, 200);
  const job = text(args.job).slice(0, 140);
  if ((what === "site_status" || what === "site_logs") && !site) return `${what} needs the site`;
  if (what === "job" && !job) return "job needs the job's name";
  if (what === "jobs" && !site && !bench) return "jobs needs the site or the bench";
  const out: Record<string, unknown> = { what };
  if (site) out.site = site;
  if (bench) out.bench = bench;
  if (job) out.job = job;
  if (args.hours !== undefined) {
    const hours = Number(args.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_PRESS_HOURS) return `hours must be a whole number from 1 to ${MAX_PRESS_HOURS}`;
    out.hours = hours;
  }
  return out;
}

/** The report's shape and its one proposal, checked here so the model hears what to fix before the hub sees it. */
export function checkInfraReport(args: Record<string, unknown>, lists: Pick<InfraTools, "actions" | "mayTarget">): string | undefined {
  const summary = text(args.summary);
  if (!summary) return "summary is required";
  if (summary.length > MAX_SUMMARY_CHARS) return `summary holds at most ${MAX_SUMMARY_CHARS} characters`;
  const confidence = confidenceOf(args.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return "confidence must be a number from 0 to 1";
  if (args.cause !== undefined && (typeof args.cause !== "string" || args.cause.length > MAX_LINE_CHARS)) {
    return `cause must be one line of at most ${MAX_LINE_CHARS} characters, or left out`;
  }
  const evidence = args.evidence;
  if (
    evidence !== undefined &&
    !(
      Array.isArray(evidence) &&
      evidence.length <= MAX_EVIDENCE_LINES &&
      evidence.every((line) => typeof line === "string" && line.trim() && line.length <= MAX_LINE_CHARS)
    )
  ) {
    return `evidence must be a list of at most ${MAX_EVIDENCE_LINES} lines of text, each at most ${MAX_LINE_CHARS} characters`;
  }
  if (args.person_steps !== undefined && (typeof args.person_steps !== "string" || args.person_steps.length > MAX_PERSON_STEPS_CHARS)) {
    return `person_steps must be text of at most ${MAX_PERSON_STEPS_CHARS} characters`;
  }
  if (args.proposal === undefined || args.proposal === null) {
    if (!text(args.person_steps)) return "with no proposal, write person_steps: what a person should check or do";
    return undefined;
  }
  const proposal = record(args.proposal);
  if (proposal !== args.proposal) return "proposal must be one object {action, target, why, expected}, or left out";
  const action = text(proposal.action);
  if (!lists.actions.includes(action)) {
    return `proposal.action must be one of this run's actions (${lists.actions.join(", ") || "none"}); when none fits, leave the proposal out and write person_steps`;
  }
  const target = text(proposal.target);
  // TBO Support compares targets without regard to case
  if (!lists.mayTarget.some((name) => name.toLowerCase() === target.toLowerCase())) {
    return lists.mayTarget.length
      ? `proposal.target must be one of may_target (${lists.mayTarget.join(", ")}); never another name`
      : "this alert names no target Copilot may act on: leave the proposal out and write person_steps";
  }
  for (const key of ["why", "expected"] as const) {
    const value = text(proposal[key]);
    if (!value) return `proposal.${key} is required: ${key === "why" ? "the cause and the evidence that this action addresses it" : "what should change if it works"}`;
    if (value.length > MAX_LINE_CHARS) return `proposal.${key} holds at most ${MAX_LINE_CHARS} characters`;
  }
  return undefined;
}

/** The report as TBO Support takes it: only its own fields, and the worker's measured cost. */
export function infraReport(args: Record<string, unknown>, cost: Record<string, unknown>): Record<string, unknown> {
  const proposal = record(args.proposal);
  return {
    summary: text(args.summary),
    confidence: confidenceOf(args.confidence),
    ...(text(args.cause) ? { cause: text(args.cause) } : {}),
    ...(Array.isArray(args.evidence) ? { evidence: (args.evidence as string[]).map((line) => line.trim()) } : {}),
    ...(text(proposal.action)
      ? { proposal: { action: text(proposal.action), target: text(proposal.target), why: text(proposal.why), expected: text(proposal.expected) } }
      : {}),
    ...(text(args.person_steps) ? { person_steps: text(args.person_steps) } : {}),
    cost,
  };
}

/** Runs one of an infrastructure run's tools. Hub refusals reach the model as tool errors, in plain words. */
export async function runInfraTool(hub: HubClient, tools: InfraTools, name: string, input: unknown): Promise<LocalToolResult> {
  const args = record(input);
  try {
    switch (name as InfraToolName) {
      case "hub_press_read": {
        const read = pressReadArguments(args);
        if (typeof read === "string") return result(false, `Not read: ${read}.`);
        const reply = await hub.callTool(tools.runToken, "press_read", read);
        return result(!reply.isError, reply.text);
      }
      case "hub_post_event": {
        const note = text(args.text);
        if (!note) return result(false, "Not noted: text is required.");
        // the worker numbers the run's events (EventOutbox), so the note goes with them, never with a seq of its own
        tools.note(redactSecrets(note.slice(0, MAX_NOTE_CHARS)));
        return result(true, "Noted.");
      }
      case "hub_submit_infra_investigation": {
        if (tools.isSubmitted()) return result(true, "Already submitted. Reply with one short sentence and stop.");
        const problem = checkInfraReport(args, tools);
        if (problem) return result(false, `Not submitted: ${problem}. Fix it and call hub_submit_infra_investigation again.`);
        await tools.beforeSubmit();
        const reply = await hub.callTool(tools.runToken, "submit_infra_investigation", infraReport(args, tools.cost()));
        if (reply.isError) return result(false, `TBO Support refused the report: ${reply.text}`);
        tools.submitted(reply.text);
        return result(true, `Submitted. ${reply.text}\nReply with one short sentence and stop.`);
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
