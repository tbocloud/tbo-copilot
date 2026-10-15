import type { WorkerEvent } from "./hub.js";
import type { Logger } from "./log.js";

const MAX_PAYLOAD_CHARS = 8_000;

/** Keeps a payload under the hub's limit: long strings are cut, and a still-too-large payload becomes a preview. */
export function boundPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const cut = (value: unknown): unknown => {
    if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
    if (Array.isArray(value)) return value.slice(0, 50).map(cut);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([key, item]) => [key, cut(item)]));
    }
    return value;
  };
  const bounded = cut(payload) as Record<string, unknown>;
  const text = JSON.stringify(bounded);
  return text.length > MAX_PAYLOAD_CHARS ? { preview: text.slice(0, MAX_PAYLOAD_CHARS), cut: true } : bounded;
}

/**
 * The run's events on their way to the hub: numbered, batched, retried. A
 * repeated `seq` is ignored by the hub, so a batch can be sent twice safely.
 * After the lease ends the hub refuses events; `close()` drops what is left.
 */
export class EventOutbox {
  private seq = 0;
  private pending: WorkerEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private failures = 0;

  constructor(
    private readonly send: (events: WorkerEvent[]) => Promise<number[]>,
    private readonly options: { log: Logger; flushMs?: number; maxBatch?: number } = { log: () => undefined },
  ) {}

  push(type: string, payload: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.seq += 1;
    this.pending.push({ seq: this.seq, type, payload: boundPayload(payload) });
    if (this.pending.length >= (this.options.maxBatch ?? 50)) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.options.flushMs ?? 2_000);
  }

  get count(): number {
    return this.seq;
  }

  /**
   * Sends what is pending, one batch after another. Calls are chained, so two
   * flushes never send the same events; a failed batch stays pending for the
   * next flush, and after five failures in a row the pending events are dropped.
   */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  private async drain(): Promise<void> {
    const maxBatch = this.options.maxBatch ?? 50;
    while (this.pending.length && !this.closed) {
      const batch = this.pending.slice(0, maxBatch);
      try {
        const acked = new Set(await this.send(batch));
        this.pending = this.pending.filter((event) => !acked.has(event.seq));
        this.failures = 0;
        if (!batch.some((event) => acked.has(event.seq))) return;
      } catch (error) {
        this.failures += 1;
        this.options.log("warn", "events not delivered", { error: String(error), pending: this.pending.length, failures: this.failures });
        if (this.failures >= 5) this.pending = [];
        return;
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }
}
