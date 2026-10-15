import { createConnection } from "node:net";

/**
 * The sandbox runner, a small service on the worker server that builds
 * throwaway copies of a customer's site and runs a fixed list of commands in
 * them. The worker reaches it over a local socket, one JSON request per line;
 * the AI never does. Only these operations exist: nothing here takes a
 * command line.
 */
/**
 * `skipped`: nothing to run (an app without tests), which is neither a pass nor a failure.
 * `failure`: why a run did not pass, from the test report (a failed assertion, or an error
 * before or while the test ran); the runner says it, it is never guessed from the output.
 */
export type SandboxResult = {
  ok: boolean;
  exit_code: number;
  output: string;
  ms: number;
  skipped?: boolean;
  failure?: "assertion" | "error";
};

/** One record of a correction, as the hub and the customer's site take it (Phase 3). */
export type ChangeRecord = {
  action: "update" | "create";
  doctype: string;
  name?: string;
  values: Record<string, unknown>;
  rows?: Array<{ table: string; name: string; values: Record<string, unknown> }>;
  add_rows?: Array<{ table: string; values: Record<string, unknown> }>;
};
/** What a copy of the site said when the change was tried with its own code: saved, or why not. */
export type ChangeTrial = { doctype: string; name?: string; ok: boolean; error?: string };

export type SandboxSpec = {
  run: string;
  customer?: string | null;
  site?: string | null;
  /** Every app of the site at the commit it runs (Frappe, ERPNext and the customer's apps). */
  apps: Array<{ app: string; repository?: string | null; branch?: string | null; commit?: string | null }>;
  /** The app being fixed: its clone is mounted over the copy's own, so the copy runs the edited code. */
  mount: { app: string; dir: string };
};

export interface Sandbox {
  /** A copy for this run: a cleaned copy of the customer's site, or a fresh site when there is none. */
  /** `tested_on` says it in words: "a copy of the customer's site", "a fresh ERPNext site". */
  start(spec: SandboxSpec): Promise<{ id: string; tested_on?: string; note?: string }>;
  migrate(id: string): Promise<SandboxResult>;
  /** One test module (the AI's reproduction), e.g. `demo_app.tests.test_margin`. */
  check(id: string, app: string, module: string): Promise<SandboxResult>;
  /** The app's own tests. */
  tests(id: string, app: string): Promise<SandboxResult>;
  /** Error signatures logged on the copy since `since` (ISO time). */
  errorsSince(id: string, since: string): Promise<string[]>;
  /** A correction tried record by record on the copy, saved with the site's own code: the dry run. */
  tryChangeSet(id: string, changes: ChangeRecord[]): Promise<ChangeTrial[]>;
  stop(id: string): Promise<void>;
}

export const MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
export const APP = /^[a-z][a-z0-9_]{0,79}$/;

export class SandboxError extends Error {}

/** The runner over its Unix socket. */
export class SocketSandbox implements Sandbox {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 45 * 60_000,
  ) {}

  private call<T>(op: string, args: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new SandboxError(`the sandbox runner did not answer ${op} in time`));
      }, this.timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ op, ...args })}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        settled = true;
        clearTimeout(timer);
        socket.end();
        try {
          const reply = JSON.parse(buffer.slice(0, end)) as { ok: boolean; result?: T; error?: string };
          if (reply.ok) resolve(reply.result as T);
          else reject(new SandboxError(reply.error || `the sandbox runner refused ${op}`));
        } catch {
          reject(new SandboxError(`the sandbox runner's answer to ${op} could not be read`));
        }
      });
      socket.on("error", (error) => {
        settled = true;
        clearTimeout(timer);
        reject(new SandboxError(`the sandbox runner cannot be reached: ${error.message}`));
      });
      // the runner crashed or hung up before answering: no need to wait out the timeout
      socket.on("close", () => {
        clearTimeout(timer);
        if (!settled) reject(new SandboxError(`the sandbox runner closed the connection without answering ${op}`));
      });
    });
  }

  start(spec: SandboxSpec): Promise<{ id: string; tested_on?: string; note?: string }> {
    return this.call("start", { spec });
  }

  migrate(id: string): Promise<SandboxResult> {
    return this.call("migrate", { id });
  }

  async check(id: string, app: string, module: string): Promise<SandboxResult> {
    if (!APP.test(app) || !MODULE.test(module)) throw new SandboxError(`not a test module: ${module}`);
    const result = await this.call<SandboxResult>("check", { id, app, module });
    // whether the bug was shown rests on this: a runner that cannot say stops the job,
    // instead of the model retrying a test that may be right
    if (!result.ok && !result.skipped && result.failure !== "assertion" && result.failure !== "error") {
      throw new SandboxError(`the sandbox runner's answer to check did not say how ${module} failed (an assertion or an error)`);
    }
    return result;
  }

  tests(id: string, app: string): Promise<SandboxResult> {
    if (!APP.test(app)) return Promise.reject(new SandboxError(`not an app: ${app}`));
    return this.call("tests", { id, app });
  }

  errorsSince(id: string, since: string): Promise<string[]> {
    return this.call("errors_since", { id, since });
  }

  tryChangeSet(id: string, changes: ChangeRecord[]): Promise<ChangeTrial[]> {
    return this.call("try_change_set", { id, changes });
  }

  stop(id: string): Promise<void> {
    return this.call("stop", { id });
  }
}
