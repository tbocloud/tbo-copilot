import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Job } from "../hub.js";

export type HubCall = { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };

/**
 * TBO Support as far as the worker sees it: the worker API (REST) and the
 * MCP endpoint with the run token. It hands out `jobs` one by one and records
 * every call; `submit_investigation` ends the lease like the real hub.
 */
export class StubHub {
  readonly calls: HubCall[] = [];
  readonly jobs: Job[] = [];
  readonly erpReplies: Record<string, string> = {};
  /** The ticket's files the worker may download (`copilot_worker.ticket_file`), by file URL. */
  readonly ticketFiles: Record<string, Buffer> = {};
  heartbeatAction = "continue";
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
      if (params.name === "get_run_context") return text(JSON.stringify(this.jobs.find((job) => job.run === run)?.context ?? {}));
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
