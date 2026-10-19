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

/** A fix job's part of the run context (helpdesk.copilot.fixes.fix_context). */
export type FixContext = {
  task: string;
  closes: string;
  branch: string;
  attempt: number;
  max_usd: number;
  commit_email: string;
  repositories: string[];
  /** What people asked for when they rejected earlier fixes of this run (newest first). */
  guidance?: string[];
};

export type Diagnosis = {
  root_cause_category?: string | null;
  confidence?: number | null;
  summary?: string | null;
  evidence?: unknown;
  proposal?: Record<string, unknown> | null;
};

export type RunContext = {
  run: string;
  kind: string;
  diagnosis?: Diagnosis | null;
  fix?: FixContext | null;
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
  /** The ticket's attachments; the worker downloads the pictures and videos (`HubClient.ticketFile`). */
  files?: Array<{ file_name?: string; file_url?: string; is_private?: number; file_size?: number }>;
  previous_runs?: Array<Record<string, unknown>>;
  /** An agent asked for the correction of the customer's own mistake (Phase 3). */
  prepare_correction?: boolean;
  /** This ticket's corrections so far: a new look prepares only the records they missed. */
  corrections?: Array<{ change_set: string; status: string; summary?: string; found_by?: string; applied_at?: string; records?: number }>;
  /** The pilot's per-run caps from TBO Support (HDS Copilot Settings); a fix has its own in `fix.max_usd`. */
  limits?: { max_usd?: number };
  /** Each worker job's models in TBO Support's order (main, then fallback), with USD per million tokens; never a key. */
  models?: Partial<Record<"investigate" | "fix" | "review", Array<{ section: string; model: string; price_in?: number; price_out?: number; price_cached?: number }>>>;
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

  /** The next run for this worker: an investigation, or a fix job when it can fix (`capabilities` "investigate,fix"). */
  async claimJob(workerId: string, run?: string, capabilities = "investigate"): Promise<Job | null> {
    const job = await this.method<Job | Record<string, never>>(
      "helpdesk.api.copilot_worker.claim_job",
      { worker_id: workerId, free_slots: 1, capabilities, ...(run ? { run } : {}) },
      this.worker,
    );
    return job && "run" in job ? (job as Job) : null;
  }

  /** A fix job's one-hour key to clone and push one of the site's repositories (the hub's GitHub App). */
  async repoToken(run: string, leaseToken: string, repository: string): Promise<{ token: string; expires_at: string; repository: string }> {
    return this.method("helpdesk.api.copilot_worker.repo_token", { run, lease_token: leaseToken, repository }, this.worker);
  }

  /** One picture or video of the run's ticket, as bytes, while the lease holds. */
  async ticketFile(run: string, leaseToken: string, fileUrl: string): Promise<Buffer> {
    const response = await this.fetchImpl(this.url + METHOD + "helpdesk.api.copilot_worker.ticket_file", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `token ${this.worker.apiKey}:${this.worker.apiSecret}` },
      body: JSON.stringify({ run, lease_token: leaseToken, file_url: fileUrl }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status >= 400) {
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON
      }
      const { message, excType } = frappeError(parsed, `ticket_file failed with HTTP ${response.status}`);
      throw new HubError(message, response.status, excType);
    }
    return Buffer.from(await response.arrayBuffer());
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
    const reply = (body && typeof body === "object" ? body : null) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message?: string };
    } | null;
    if (status >= 400 || reply?.error) {
      const message = reply?.error?.message || `the hub refused ${name} (HTTP ${status})`;
      throw new HubError(message, status >= 400 ? status : 400);
    }
    // the hub answers with plain JSON-RPC; anything else must never pass for a result (a report that was not stored)
    if (!reply?.result || typeof reply.result !== "object" || !Array.isArray(reply.result.content)) {
      throw new HubError(`the hub gave no result for ${name} (HTTP ${status})`, 502);
    }
    const text = reply.result.content.map((block) => block.text ?? "").join("\n");
    return { text, isError: Boolean(reply.result.isError) };
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
