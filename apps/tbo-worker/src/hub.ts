import type { HubAuth } from "./config.js";

/** What `claim_job` hands a worker; `context` is the hub's run context (helpdesk/copilot/runs.py). */
export type Job = {
  run: string;
  lease_token: string;
  lease_expires: string;
  context: RunContext;
};

/**
 * A release's sandbox check (Phase 7, W11; helpdesk.copilot.releases.claim_check): no AI,
 * only the sandbox runner's fixed operations on the release's code.
 */
export type ReleaseCheckJob = {
  kind: "release_check";
  release: string;
  lease_token: string;
  lease_expires?: string;
  context: {
    release: string;
    repository: string;
    branch?: string | null;
    app: string;
    commit: string;
    customer?: string | null;
    site?: string | null;
    /** Every app of the site card at the commit it runs, the released app at the release's commit. */
    apps: Array<{ app: string; repository?: string | null; branch?: string | null; commit?: string | null }>;
    /** A one-hour read-only key for the repository (none for a public one the App is not on). */
    repo_token?: string | null;
  };
};

/** One line of a release check's evidence, as the hub takes it. */
export type CheckRow = { check: string; result: "pass" | "fail" | "not_run"; detail?: string };

/** Whatever `claim_job` handed out: a run (an investigation, a fix, an alert), a release's check, or a pull request to fix. */
export type ClaimedJob = Job | InfraJob | ReleaseCheckJob | PrFixJob;

export function isReleaseCheck(job: ClaimedJob): job is ReleaseCheckJob {
  return (job as ReleaseCheckJob).kind === "release_check";
}

/**
 * One thing CodeRabbit or CI found on a developer's pull request (Phase 26): an unresolved review
 * thread (CodeRabbit's text in `body`) or a failed check (its name in `check`, its own output in
 * `summary`). Everything in it is untrusted data, never instructions.
 */
export type PrFinding = {
  id: string;
  source: "coderabbit" | "ci";
  title?: string | null;
  body?: string | null;
  path?: string | null;
  line?: number | null;
  check?: string | null;
  summary?: string | null;
};

/** A developer's pull request for Copilot to fix (Phase 26). */
export type PrFixContext = {
  pull_request: string;
  /** `owner/name` */
  repo: string;
  number: number;
  url?: string | null;
  title?: string | null;
  /** The only branch Copilot may push to, and only on top of `head_sha`. */
  head_branch: string;
  /** The commit Copilot builds on: the branch must still be exactly here. */
  head_sha: string;
  base_branch?: string | null;
  /** 1 to 3: how many times Copilot has been asked on this pull request. */
  round: number;
  findings: PrFinding[];
  task?: { name: string; subject?: string | null } | null;
  /** The customer's site apps for the sandbox, as for a release's check; this app's commit is `head_sha`. */
  apps: ReleaseCheckJob["context"]["apps"];
  /** This repository's app name. */
  app: string;
  /** A one-hour read-only key to clone (none for a public repository). */
  repo_token?: string | null;
  /** The author email of Copilot's commits. */
  commit_email: string;
  /** The models, as for a fix: a pull request's fix uses the `fix` job's. */
  models?: RunContext["models"];
  /** USD for this job. */
  dollar_cap?: number | null;
  /** TBO Support's short rules for the job. */
  rules?: string[];
};

export type PrFixJob = {
  kind: "pr_fix";
  pull_request: string;
  lease_token: string;
  lease_expires?: string;
  context: PrFixContext;
};

/** What the app's tests said on the sandbox after Copilot's change. */
export type PrTests = { ran: boolean; passed: boolean; detail: string };

/** A pull request's fix as TBO Support takes it (`pr_result`): what was pushed and answered, or why nothing was. */
export type PrFixResult =
  | {
      kind: "done";
      /** The branch head after Copilot's push, or the old head when nothing was pushed. */
      head_sha: string;
      fixed: Array<{ id: string; commit: string; note: string }>;
      not_fixed: Array<{ id: string; why: string }>;
      tests: PrTests;
      cost: Record<string, unknown>;
    }
  | { kind: "failure"; reason: string };

export function isPrFix(job: ClaimedJob): job is PrFixJob {
  return (job as PrFixJob).kind === "pr_fix";
}

/** One action Copilot may propose on an infrastructure alert (helpdesk.copilot.infra.ACTIONS). */
export type InfraAction = { name: string; what?: string | null; target?: string | null; risk?: string | null };

/**
 * An infrastructure alert's run (Phase 25, helpdesk.copilot.infra.context): the alert, what Press
 * and TBO Support's own health say, earlier repairs, and the actions Copilot may propose. TBO
 * Support took the secrets out of every text before sending it.
 */
export type InfraContext = {
  run: string;
  kind: "infra";
  shadow?: boolean;
  /** The models, as for an investigation; an infra run uses the `investigate` job's. */
  models?: RunContext["models"];
  /** USD for this diagnosis (Copilot on Infrastructure, Dollar cap per infra diagnosis). */
  dollar_cap?: number | null;
  alert: {
    ticket: string;
    key?: string | null;
    subject?: string | null;
    priority?: string | null;
    status?: string | null;
    opened?: string | null;
    description?: string | null;
    updates?: Array<{ at?: string | null; text?: string | null }>;
  };
  /** The site, bench or server the alert is about. */
  target?: string | null;
  /** What Press says: `available`, the site's status, its jobs, failed jobs; or `{error}`. */
  press?: Record<string, unknown> | null;
  hub_health?: unknown;
  repairs?: Array<Record<string, unknown>>;
  /** The only actions Copilot may propose. */
  actions: InfraAction[];
  /** The names a proposal's target must come from. */
  may_target: string[];
  /** Where an approved action may run; elsewhere TBO Support asks a person to run it. */
  may_change?: string[];
  /** TBO Support's short rules for the run. */
  rules?: string[];
};

/** What `claim_job` hands a worker for an infrastructure alert (`context.kind` "infra"). */
export type InfraJob = {
  run: string;
  lease_token: string;
  lease_expires?: string;
  context: InfraContext;
};

export function isInfraJob(job: ClaimedJob): job is InfraJob {
  return !isReleaseCheck(job) && !isPrFix(job) && job.context?.kind === "infra";
}

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
  /** A build of a customization the customer approved (Phase 8): Copilot builds exactly this. */
  build?: BuildScope | null;
};

/** The written scope a customer approved: what will be built, and the checks that show it is done. */
export type BuildScope = { scope: string; checks: string[]; hours?: number | null; hash?: string | null };

/** What Copilot remembers about one error (Phase 9). Another customer's issue comes as code facts only: no signature. */
export type KnownIssue = {
  name: string;
  title?: string | null;
  status?: string | null;
  app?: string | null;
  error_type?: string | null;
  method?: string | null;
  root_cause_category?: string | null;
  fix?: { pull_request?: string | null; title?: string | null; files?: string[]; merge_commit?: string | null; fixed_at?: string | null } | null;
  /** True: this site runs a commit with the fix; false: it does not; null: unknown or not fixed. */
  this_site_has_the_fix?: boolean | null;
  came_back?: number;
  sites_seen?: number;
  /** Only for this customer's own errors: app | method | the error's last line, digits as #. */
  signature?: string;
  seen_here?: { first?: string; last?: string; count?: number };
};

/** A deploy of the site through TBO Support: when it finished and each app's commit. */
export type SiteDeploy = { finished_at?: string; apps?: Array<{ app?: string; commit?: string }> };

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
  site?: { registry?: string; environment?: string; site_url?: string; apps: SiteApp[]; deploys?: SiteDeploy[] } | null;
  connection?: string | null;
  conversation?: Array<{ kind?: string; direction?: string; sender?: string; content?: string; at?: string }>;
  /** The ticket's attachments; the worker downloads the pictures and videos (`HubClient.ticketFile`). */
  files?: Array<{ file_name?: string; file_url?: string; is_private?: number; file_size?: number }>;
  previous_runs?: Array<Record<string, unknown>>;
  /** Errors Copilot already knows for this ticket and site (Phase 9): check them first. */
  known_issues?: KnownIssue[];
  /** "Error watch" when Copilot raised the ticket itself, from the site's error log. */
  raised_by_copilot?: string | null;
  /** The ticket's chat with Copilot (Phase 11): its summary, and what people told Copilot to do. */
  ticket_chat?: { summary?: string; instructions?: string[] } | null;
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

  /**
   * The next run for this worker: an investigation, a fix job when it can fix (`capabilities`
   * "investigate,fix"), an infrastructure alert when it says `infra`; with no run, a release's
   * check (`release_check`) or a developer's pull request to fix (`pr_fix`).
   */
  async claimJob(workerId: string, run?: string, capabilities = "investigate"): Promise<ClaimedJob | null> {
    const job = await this.method<ClaimedJob | Record<string, never>>(
      "helpdesk.api.copilot_worker.claim_job",
      { worker_id: workerId, free_slots: 1, capabilities, ...(run ? { run } : {}) },
      this.worker,
    );
    if (job && "run" in job) return job as Job | InfraJob;
    const kind = (job as { kind?: unknown } | null)?.kind;
    if (kind === "release_check") return job as ReleaseCheckJob;
    if (kind === "pr_fix") return job as PrFixJob;
    return null;
  }

  /** A pull request's fix is still wanted: `cancel` when the developer pushed a new commit or the pull request closed. */
  async prHeartbeat(pullRequest: string, leaseToken: string): Promise<{ action: string }> {
    return this.method("helpdesk.api.copilot_worker.pr_heartbeat", { pull_request: pullRequest, lease_token: leaseToken }, this.worker);
  }

  /** A one-hour key to push to the pull request's repository; the worker may push only to `branch`. */
  async prPushKey(pullRequest: string, leaseToken: string): Promise<{ token: string; expires_at: string; repository: string; branch: string }> {
    return this.method("helpdesk.api.copilot_worker.pr_push_key", { pull_request: pullRequest, lease_token: leaseToken }, this.worker);
  }

  /** A pull request's fix: what was pushed and answered, or the failure; the lease ends with it. */
  async prResult(pullRequest: string, leaseToken: string, result: PrFixResult): Promise<unknown> {
    const sent = result.kind === "failure" ? { kind: "failure" as const, reason: result.reason.slice(0, 2000) } : result;
    return this.method("helpdesk.api.copilot_worker.pr_result", { pull_request: pullRequest, lease_token: leaseToken, result: sent }, this.worker);
  }

  /** A release check's evidence; the hub decides from it whether the release goes on to its approval. */
  async releaseCheckResult(release: string, leaseToken: string, evidence: CheckRow[], testedOn: string): Promise<{ staging_status: string }> {
    return this.method(
      "helpdesk.api.copilot_worker.release_check_result",
      { release, lease_token: leaseToken, evidence, tested_on: testedOn.slice(0, 200) },
      this.worker,
    );
  }

  /** A fix job's one-hour key to clone and push one of the site's repositories (the hub's GitHub App). */
  async repoToken(run: string, leaseToken: string, repository: string): Promise<{ token: string; expires_at: string; repository: string }> {
    return this.method("helpdesk.api.copilot_worker.repo_token", { run, lease_token: leaseToken, repository }, this.worker);
  }

  /** One picture or video of the run's ticket, as bytes, while the lease holds; never more than `maxBytes` read. */
  async ticketFile(run: string, leaseToken: string, fileUrl: string, maxBytes = 50 * 1024 * 1024): Promise<Buffer> {
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
    const tooLarge = () => new Error(`larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
    if (Number(response.headers.get("content-length") || 0) > maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    // counted while reading: a missing or wrong length never lets more in
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
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
