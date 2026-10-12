import { readFile } from "node:fs/promises";

import type { WorkerConfig } from "./config.js";
import type { HubClient, RunInfo } from "./hub.js";
import type { Logger } from "./log.js";
import type { RunReport, Worker } from "./supervisor.js";

/**
 * One evaluation case: a real fix in a customer app, the ticket a customer
 * would have written, and the commit before the fix. The expected answer
 * lives only in the private cases file, never on the ticket.
 */
export type EvalCase = {
  id: string;
  ticket: string;
  /** bug: scored on the root cause; customization: scored on not calling it a defect. */
  kind: "bug" | "customization";
  app: string;
  repository: string;
  base_commit: string;
  expected_root_cause?: string;
  /** Other answers that count as right, for a case that fits two categories (default: the expected one). */
  accepted_root_causes?: string[];
  fix_files: string[];
  fix_pr?: string;
};

export type EvalResult = {
  case: EvalCase;
  run: string | null;
  outcome: RunReport["outcome"] | "not_started";
  reason?: string;
  rootCause: string | null;
  confidence: number | null;
  right: boolean;
  filesFound: string[];
  summary: string;
  toolCalls: number;
  tokens: number;
  costUsd: number;
  minutes: number;
};

const DEFECTS = new Set(["bug", "data_damaged_by_bug", "wrong_setting", "core_issue"]);

export async function loadCases(path: string): Promise<EvalCase[]> {
  const data = JSON.parse(await readFile(path, "utf8")) as { cases?: EvalCase[] } | EvalCase[];
  const cases = Array.isArray(data) ? data : data.cases ?? [];
  for (const item of cases) {
    if (!item.id || !item.ticket || !item.app || !item.repository || !item.base_commit) {
      throw new Error(`case ${item.id ?? "?"} needs id, ticket, app, repository and base_commit`);
    }
  }
  return cases;
}

/** The fix's files the diagnosis named: by full path, by the path below the app folder, or by file name. */
export function filesNamed(fixFiles: string[], text: string): string[] {
  const haystack = text.toLowerCase();
  return fixFiles.filter((file) => {
    const path = file.toLowerCase();
    const below = path.split("/").slice(1).join("/");
    const name = path.split("/").pop() ?? path;
    return haystack.includes(path) || (below && haystack.includes(below)) || haystack.includes(name);
  });
}

export function score(item: EvalCase, info: RunInfo): { right: boolean; filesFound: string[] } {
  const rootCause = info.root_cause ?? null;
  const accepted = item.accepted_root_causes?.length ? item.accepted_root_causes : [item.expected_root_cause ?? "bug"];
  const right = item.kind === "bug" ? rootCause !== null && accepted.includes(rootCause) : rootCause !== null && !DEFECTS.has(rootCause);
  const text = JSON.stringify([info.summary ?? "", info.evidence ?? [], info.proposal ?? {}]);
  return { right, filesFound: filesNamed(item.fix_files, text) };
}

/**
 * Runs each case end to end through the hub: cancel what is active on the
 * ticket, start a run at the case's base commit (as an agent), let this
 * worker claim exactly that run, then read and score the diagnosis.
 */
export async function runEvaluation(
  cases: EvalCase[],
  deps: { cfg: WorkerConfig; hub: HubClient; worker: Pick<Worker, "runOnce">; log: Logger; signal?: AbortSignal },
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const item of cases) {
    if (deps.signal?.aborted) break;
    deps.cfg.repoMap[item.app] = item.repository;
    deps.log("info", "evaluation case", { id: item.id, ticket: item.ticket, app: item.app });
    const empty = { rootCause: null, confidence: null, right: false, filesFound: [], summary: "", toolCalls: 0, tokens: 0, costUsd: 0, minutes: 0 };
    try {
      const current = await deps.hub.getRun(item.ticket);
      if (current.run && current.can_cancel) await deps.hub.cancelRun(item.ticket);
      const started = await deps.hub.startRun(item.ticket, item.app, item.base_commit);
      if (!started.run || started.state !== "Queued") {
        results.push({ case: item, run: started.run, outcome: "not_started", reason: `the run is ${started.state ?? "missing"}`, ...empty });
        continue;
      }
      const report = await deps.worker.runOnce(started.run);
      const info = await deps.hub.getRun(item.ticket);
      const { right, filesFound } = score(item, info);
      results.push({
        case: item,
        run: started.run,
        outcome: report?.outcome ?? "not_started",
        ...(report?.reason ? { reason: report.reason } : {}),
        rootCause: info.root_cause ?? null,
        confidence: info.confidence ?? null,
        right,
        filesFound,
        summary: info.summary ?? info.failure_reason ?? "",
        toolCalls: report?.toolCalls ?? 0,
        tokens: (report?.tokensIn ?? 0) + (report?.tokensOut ?? 0),
        costUsd: report?.costUsd ?? 0,
        minutes: report?.minutes ?? 0,
      });
      if (report?.outcome === "stopped") break; // the worker was stopped: no more cases
    } catch (error) {
      results.push({ case: item, run: null, outcome: "not_started", reason: String((error as Error).message ?? error), ...empty });
    }
  }
  return results;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The report as Markdown: totals first, then one row per case. */
export function reportMarkdown(results: EvalResult[], meta: { model: string; date: string }): string {
  const bugs = results.filter((r) => r.case.kind === "bug");
  const custom = results.filter((r) => r.case.kind === "customization");
  const ran = results.filter((r) => r.outcome === "submitted");
  const cell = (text: string) => text.replace(/\|/g, "/").replace(/\n/g, " ");
  const lines = [
    `# Copilot evaluation, ${meta.date}`,
    "",
    `Model: ${meta.model}. Cases: ${results.length}; diagnosed: ${ran.length}.`,
    "",
    "| Measure | Result |",
    "|---|---|",
    `| Bugs: root cause right | ${bugs.filter((r) => r.right).length} of ${bugs.length} |`,
    `| Customizations: not called a defect | ${custom.filter((r) => r.right).length} of ${custom.length} |`,
    `| Fix files named (all cases) | ${results.reduce((n, r) => n + r.filesFound.length, 0)} of ${results.reduce((n, r) => n + r.case.fix_files.length, 0)} |`,
    `| Median minutes per diagnosed case | ${median(ran.map((r) => r.minutes))} |`,
    `| Median tokens per diagnosed case | ${median(ran.map((r) => r.tokens))} |`,
    `| Total cost (USD, at the configured prices) | ${results.reduce((n, r) => n + r.costUsd, 0).toFixed(2)} |`,
    "",
    "| Case | Ticket | Expected | Copilot | Confidence | Right | Fix files named | Tool calls | Tokens | Minutes | Outcome |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.case.id} | ${r.case.ticket} | ${r.case.kind === "bug" ? (r.case.accepted_root_causes ?? [r.case.expected_root_cause ?? "bug"]).join(" or ") : "not a defect"} | ${r.rootCause ?? "-"} | ${r.confidence ?? "-"} | ${r.right ? "yes" : "no"} | ${r.filesFound.length} of ${r.case.fix_files.length} | ${r.toolCalls} | ${r.tokens} | ${r.minutes} | ${cell(r.outcome + (r.reason ? `: ${r.reason}` : ""))} |`,
    );
  }
  lines.push("", "## Diagnoses", "");
  for (const r of results) lines.push(`- **${r.case.id}** (${r.case.ticket}): ${cell(r.summary || "-")}`);
  lines.push("");
  return lines.join("\n");
}
