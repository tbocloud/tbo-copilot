import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { InfraContext, InfraJob, Job, PrFixJob } from "../hub.js";

export type HubCall = { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };

/**
 * TBO Support as far as the worker sees it: the worker API (REST) and the
 * MCP endpoint with the run token. It hands out `jobs` one by one and records
 * every call; `submit_investigation` ends the lease like the real hub. An
 * infrastructure run (Phase 25) reads Press and reports with
 * `submit_infra_investigation`; it is refused the investigation's report, as there. A pull
 * request to fix (Phase 26) goes out to a worker that claims with `pr_fix` when no run is left,
 * and is answered through `pr_heartbeat`, `pr_push_key` and `pr_result`.
 */
export class StubHub {
  readonly calls: HubCall[] = [];
  readonly jobs: Array<Job | InfraJob> = [];
  readonly erpReplies: Record<string, string> = {};
  /** Press's answers to `press_read`, by `what`. */
  readonly pressReplies: Record<string, string> = {};
  /** The ticket's files the worker may download (`copilot_worker.ticket_file`), by file URL. */
  readonly ticketFiles: Record<string, Buffer> = {};
  heartbeatAction = "continue";
  /** Pull requests to fix, handed out when no run is left. */
  readonly prJobs: PrFixJob[] = [];
  prHeartbeatAction = "continue";
  /** The branch the push key is for; the pull request's head branch when unset. */
  prPushBranch: string | undefined;
  /** Runs before the push key is handed out (a cancel arriving while the worker gets ready to push). */
  prPushKeyHook: (() => Promise<void>) | undefined;
  /** Makes the MCP endpoint answer 200 with this raw body (a broken proxy, an HTML page). */
  rawMcpReply: string | undefined;
  private server: Server | undefined;
  private leases = new Map<string, string>();
  private ended = new Set<string>();
  url = "";

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  callsTo(name: string): HubCall[] {
    return this.calls.filter((call) => call.path.endsWith(name) || (call.body.params as { name?: string } | undefined)?.name === name);
  }

  events(): Array<{ seq: number; type: string; payload: Record<string, unknown> }> {
    return this.callsTo("post_events").flatMap((call) => call.body.events as Array<{ seq: number; type: string; payload: Record<string, unknown> }>);
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private leaseOk(run: string, token: string): boolean {
    return this.leases.get(run) === token && !this.ended.has(run);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
    const path = req.url ?? "";
    this.calls.push({ path, headers: req.headers, body });
    const refused = () => this.send(res, 403, { exc_type: "PermissionError", _server_messages: JSON.stringify([JSON.stringify({ message: "This lease is not valid" })]) });

    if (path.endsWith("frappe.auth.get_logged_user")) return this.send(res, 200, { message: "worker@example.com" });
    if (path.endsWith("copilot_worker.claim_job")) {
      const job = this.jobs.find((candidate) => !this.leases.has(candidate.run) && (!body.run || body.run === candidate.run));
      const prFix = String(body.capabilities ?? "").split(",").includes("pr_fix");
      const pr = !job && !body.run && prFix ? this.prJobs.find((candidate) => !this.leases.has(candidate.pull_request)) : undefined;
      if (pr) {
        this.leases.set(pr.pull_request, pr.lease_token);
        return this.send(res, 200, { message: pr });
      }
      if (!job) return this.send(res, 200, { message: {} });
      this.leases.set(job.run, job.lease_token);
      return this.send(res, 200, { message: job });
    }
    if (path.endsWith("copilot_worker.ticket_file")) {
      if (!this.leaseOk(String(body.run), String(body.lease_token))) return refused();
      const file = this.ticketFiles[String(body.file_url)];
      if (!file) return refused();
      res.writeHead(200, { "Content-Type": "image/png" });
      return void res.end(file);
    }
    if (path.endsWith("copilot_worker.repo_token")) {
      if (!this.leaseOk(String(body.run), String(body.lease_token))) return refused();
      return this.send(res, 200, { message: { token: "push-key", expires_at: "2026-10-13T03:00:00Z", repository: body.repository } });
    }
    if (path.endsWith("copilot_worker.pr_heartbeat")) {
      if (!this.leaseOk(String(body.pull_request), String(body.lease_token))) return refused();
      return this.send(res, 200, { message: { action: this.prHeartbeatAction } });
    }
    if (path.endsWith("copilot_worker.pr_push_key")) {
      if (!this.leaseOk(String(body.pull_request), String(body.lease_token))) return refused();
      const pr = this.prJobs.find((candidate) => candidate.pull_request === body.pull_request)!;
      await this.prPushKeyHook?.();
      return this.send(res, 200, {
        message: { token: "pr-push-key", expires_at: "2026-11-18T10:00:00Z", repository: pr.context.repo, branch: this.prPushBranch ?? pr.context.head_branch },
      });
    }
    if (path.endsWith("copilot_worker.pr_result")) {
      if (!this.leaseOk(String(body.pull_request), String(body.lease_token))) return refused();
      this.ended.add(String(body.pull_request));
      return this.send(res, 200, { message: { pull_request: body.pull_request, ok: true } });
    }
    if (path.endsWith("copilot_worker.heartbeat")) {
      if (!this.leaseOk(String(body.run), String(body.lease_token))) return refused();
      return this.send(res, 200, { message: { ok: true, action: this.heartbeatAction } });
    }
    if (path.endsWith("copilot_worker.post_events")) {
      if (!this.leaseOk(String(body.run), String(body.lease_token))) return refused();
      return this.send(res, 200, { message: { acked: (body.events as Array<{ seq: number }>).map((event) => event.seq) } });
    }
    if (path.endsWith("copilot_worker.submit_result")) {
      if (!this.leaseOk(String(body.run), String(body.lease_token))) return refused();
      const infraRun = this.jobs.find((job) => job.run === body.run)?.context.kind === "infra";
      if (infraRun && (body.result as { kind?: string } | undefined)?.kind !== "failure") {
        const message = "An infrastructure run reports with submit_infra_investigation.";
        return this.send(res, 417, { exc_type: "ValidationError", _server_messages: JSON.stringify([JSON.stringify({ message })]) });
      }
      this.ended.add(String(body.run));
      return this.send(res, 200, { message: { run: body.run, state: "Failed" } });
    }
    if (path.endsWith("copilot_mcp.handle") && this.rawMcpReply !== undefined) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(this.rawMcpReply);
      return;
    }
    if (path.endsWith("copilot_mcp.handle")) {
      const [run, token] = String(req.headers["x-copilot-run-token"] ?? "").split(":");
      const id = body.id;
      if (!run || !token || !this.leaseOk(run, token)) return this.send(res, 401, { jsonrpc: "2.0", id, error: { code: -32001, message: "The run token is not valid" } });
      const params = body.params as { name: string; arguments: Record<string, unknown> };
      const text = (value: string, isError = false) => this.send(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: value }], isError } });
      const job = this.jobs.find((candidate) => candidate.run === run);
      const infra = job?.context.kind === "infra";
      if (params.name === "get_run_context") return text(JSON.stringify(job?.context ?? {}));
      if (params.name === "post_event") return text(JSON.stringify({ seq: params.arguments.seq, stored: true }));
      if (params.name === "press_read") {
        if (!infra) return text("Press reads are for infrastructure runs.", true);
        const what = String(params.arguments.what);
        return this.pressReplies[what] ? text(this.pressReplies[what]!) : text(`Press refused ${what}`, true);
      }
      if (params.name === "submit_infra_investigation") {
        if (!infra) return text("Only an infrastructure run reports this way; use submit_investigation.", true);
        this.ended.add(run);
        // helpdesk.copilot.infra.check_proposal, in short: in Copilot May Change it asks, elsewhere a person runs it
        const proposal = (params.arguments.proposal ?? {}) as { action?: string; target?: string };
        const mayChange = (job.context as InfraContext).may_change ?? [];
        const decision = !proposal.action ? "none" : mayChange.includes(String(proposal.target).toLowerCase()) ? "ask" : "person";
        const whyNot = decision === "person" ? `${proposal.target} is not on the list of places Copilot may change.` : null;
        return text(JSON.stringify({ run, state: decision === "ask" ? "Awaiting Approval" : "Handed Over", decision, why_not: whyNot }));
      }
      if (params.name === "submit_investigation" && infra) return text("This is an infrastructure run; report with submit_infra_investigation.", true);
      if (params.name === "customer_erp_read") {
        const tool = String(params.arguments.tool);
        return this.erpReplies[tool] ? text(this.erpReplies[tool]!) : text(`The customer site refused ${tool}`, true);
      }
      if (params.name === "submit_change") {
        this.ended.add(run);
        return text(`Run ${run}: Copilot's change ${String(params.arguments.repository)}#${String(params.arguments.number)} recorded.`);
      }
      if (params.name === "submit_investigation") {
        this.ended.add(run);
        return text(`Run ${run} is now Preparing Fix (root cause ${String(params.arguments.root_cause_category)}).`);
      }
      return text(`Unknown tool ${params.name}`, true);
    }
    this.send(res, 404, { exc_type: "DoesNotExistError" });
  }
}
