import type { HubAuth } from "./config.js";

/** What `claim_job` hands a worker; `context` is the hub's run context (helpdesk/copilot/runs.py). */
export type Job = {
  run: string;
  lease_token: string;
  lease_expires: string;
  context: RunContext;
};

export type SiteApp = {
  app: string;
  repository?: string | null;
  branch?: string | null;
  deployed_commit?: string | null;
  drift_status?: string | null;
};

export type RunContext = {
  run: string;
  kind: string;
  shadow?: boolean;
  base_app?: string | null;
  base_commit?: string | null;
  ticket: {
    name: string;
    subject?: string | null;
    description?: string | null;
    status?: string | null;
    priority?: string | null;
    ticket_type?: string | null;
    customer?: string | null;
    raised_by?: string | null;
    created?: string | null;
  };
  triage?: Record<string, unknown>;
  customer?: Record<string, unknown> | null;
  site?: { registry?: string; environment?: string; site_url?: string; apps: SiteApp[] } | null;
  connection?: string | null;
  conversation?: Array<{ kind?: string; direction?: string; sender?: string; content?: string; at?: string }>;
  files?: Array<Record<string, unknown>>;
  previous_runs?: Array<Record<string, unknown>>;
};

export type WorkerEvent = { seq: number; type: string; payload: Record<string, unknown> };
export type ToolText = { text: string; isError: boolean };

/** A refused or failed hub call. `status` 401/403 on the worker's calls means the lease is gone. */
export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly excType?: string,
  ) {
    super(message);
  }

  get leaseGone(): boolean {
    return this.status === 401 || this.status === 403 || this.excType === "PermissionError";
  }
}

type FetchLike = typeof fetch;

const METHOD = "/api/method/";
const MCP_PATH = `${METHOD}helpdesk.api.copilot_mcp.handle`;

/** The readable part of a Frappe error body: the first server message, else the exception line. */
export function frappeError(body: unknown, fallback: string): { message: string; excType?: string } {
  if (!body || typeof body !== "object") return { message: fallback };
  const data = body as Record<string, unknown>;
  const excType = typeof data.exc_type === "string" ? data.exc_type : undefined;
  if (typeof data._server_messages === "string") {
    try {
      const first = JSON.parse(JSON.parse(data._server_messages)[0]) as { message?: string };
      if (first.message) return { message: stripHtml(first.message), excType };
    } catch {
      // fall through to the exception text
    }
  }
  if (typeof data.exception === "string") return { message: data.exception.split("\n").pop() || fallback, excType };
  return { message: fallback, excType };
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "").trim();
}

/**
 * TBO Support as the worker sees it: the worker API (REST, the worker user's
 * key), the run's tools on the hub's MCP server (the run token), and, for the
 * evaluation only, three agent calls with an agent's key.
 */
export class HubClient {
  private nextId = 1;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly agent?: HubAuth;

  constructor(
    private readonly url: string,
    private readonly worker: HubAuth,
    options: { fetch?: FetchLike; timeoutMs?: number; agent?: HubAuth } = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 100_000;
    this.agent = options.agent;
  }

  private async post(path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const response = await this.fetchImpl(this.url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: keep the text for the error
    }
    return { status: response.status, body: parsed };
  }

  private async method<T>(name: string, args: Record<string, unknown>, auth: HubAuth): Promise<T> {
    const { status, body } = await this.post(METHOD + name, args, { Authorization: `token ${auth.apiKey}:${auth.apiSecret}` });
    if (status >= 400) {
      const { message, excType } = frappeError(body, `${name} failed with HTTP ${status}`);
      throw new HubError(message, status, excType);
    }
    return (body as { message: T }).message;
  }

  // --- the worker API -------------------------------------------------------

  /** The user the worker's key belongs to (a harmless call for `check`). */
  async whoAmI(): Promise<string> {
    return this.method<string>("frappe.auth.get_logged_user", {}, this.worker);
  }

  async claimJob(workerId: string, run?: string): Promise<Job | null> {
    const job = await this.method<Job | Record<string, never>>(
      "helpdesk.api.copilot_worker.claim_job",
      { worker_id: workerId, free_slots: 1, capabilities: "investigate", ...(run ? { run } : {}) },
      this.worker,
    );
    return job && "run" in job ? (job as Job) : null;
  }

  async heartbeat(run: string, leaseToken: string, stage: string): Promise<{ action: string }> {
    return this.method("helpdesk.api.copilot_worker.heartbeat", { run, lease_token: leaseToken, stage }, this.worker);
  }

  async postEvents(run: string, leaseToken: string, events: WorkerEvent[]): Promise<number[]> {
    const result = await this.method<{ acked: number[] }>(
      "helpdesk.api.copilot_worker.post_events",
      { run, lease_token: leaseToken, events },
      this.worker,
    );
    return result.acked ?? [];
  }

  async submitFailure(run: string, leaseToken: string, reason: string): Promise<void> {
    await this.method(
      "helpdesk.api.copilot_worker.submit_result",
      { run, lease_token: leaseToken, result: { kind: "failure", reason: reason.slice(0, 2000) } },
      this.worker,
    );
  }

  // --- the run's tools on the hub's MCP server -----------------------------

  /** One `tools/call` with the run token; a tool's own refusal comes back as `isError`, not an exception. */
  async callTool(runToken: string, name: string, args: Record<string, unknown>): Promise<ToolText> {
    const id = this.nextId++;
    const { status, body } = await this.post(
      MCP_PATH,
      { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      { "X-Copilot-Run-Token": runToken, Accept: "application/json, text/event-stream" },
    );
    const reply = body as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } } | null;
    if (status >= 400 || reply?.error) {
      const message = reply?.error?.message || `the hub refused ${name} (HTTP ${status})`;
      throw new HubError(message, status >= 400 ? status : 400);
    }
    const text = (reply?.result?.content ?? []).map((block) => block.text ?? "").join("\n");
    return { text, isError: Boolean(reply?.result?.isError) };
  }

  // --- an agent's calls (evaluation) ---------------------------------------

  private requireAgent(): HubAuth {
    if (!this.agent) throw new HubError("TBO_HUB_AGENT_API_KEY and TBO_HUB_AGENT_API_SECRET are needed for this", 0);
    return this.agent;
  }

  async startRun(ticket: string, baseApp: string, baseCommit: string): Promise<RunInfo> {
    return this.method("helpdesk.api.copilot.start_run", { ticket, base_app: baseApp, base_commit: baseCommit }, this.requireAgent());
  }

  async cancelRun(ticket: string): Promise<RunInfo> {
    return this.method("helpdesk.api.copilot.cancel_run", { ticket }, this.requireAgent());
  }

  async getRun(ticket: string): Promise<RunInfo> {
    return this.method("helpdesk.api.copilot.get_run", { ticket }, this.requireAgent());
  }
}

/** `helpdesk.api.copilot.get_run`, the parts the evaluation reads. */
export type RunInfo = {
  run: string | null;
  state?: string;
  root_cause?: string | null;
  confidence?: number | null;
  summary?: string | null;
  evidence?: Array<Record<string, unknown>>;
  proposal?: Record<string, unknown>;
  failure_reason?: string | null;
  model_used?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
  can_cancel?: boolean;
};
