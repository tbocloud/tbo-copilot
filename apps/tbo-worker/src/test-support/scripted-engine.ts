import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { LocalToolResult } from "@pi-desktop/host-runtime";
import type { MessageUsage, ToolPermissionRequest } from "@pi-desktop/shared";

import type { ModelConfig } from "../config.js";
import type { Engine, SessionOptions, TurnObserver, TurnResult } from "../engine.js";

/**
 * One step of a scripted turn: a tool call, a model request's usage, a closing text, waiting until
 * the turn is aborted, the engine's Write tool (asked of the session's permission rule first, as
 * host-core asks in `ask` mode; refused when the session has none), or `act`: a change in the
 * session's folder made past every tool and rule (a test's stand-in for a hole in them).
 */
export type EngineStep =
  | { tool: string; args?: Record<string, unknown> }
  | { usage: MessageUsage }
  | { text: string }
  | { wait: true }
  | { write: string; content: string }
  | { act: (root: string) => void | Promise<void> };

/**
 * The engine as the worker drives it, without host-core, the sidecar or a model: each runTurn
 * plays the next scripted turn. Tool calls go through the worker's router, as the engine's local
 * tools do, and the observer hears of each step. An abort ends the turn before its next step.
 */
export class ScriptedEngine {
  readonly sessions: Array<{ id: string; root: string; title: string; options: SessionOptions }> = [];
  readonly prompts: Array<{ session: string; content: string }> = [];
  readonly results: Array<{ session: string; tool: string; result: LocalToolResult }> = [];
  readonly closed: string[] = [];
  private readonly aborted = new Set<string>();
  private readonly waiting = new Map<string, () => void>();
  private count = 0;

  constructor(
    private readonly runTool: (sessionId: string, name: string, args: unknown) => Promise<LocalToolResult>,
    private readonly turns: EngineStep[][],
    private readonly profiles: string[] = ["infra"],
  ) {}

  get engine(): Engine {
    return this as unknown as Engine;
  }

  async configureModel(model: ModelConfig): Promise<{ providerId: string; modelId: string }> {
    return { providerId: `provider ${model.providerName}`, modelId: model.modelId };
  }

  hasProfile(name: string): boolean {
    return this.profiles.includes(name);
  }

  async openSession(root: string, title: string, _model: unknown, options: SessionOptions = {}): Promise<string> {
    this.count += 1;
    const id = `session-${this.count}`;
    this.sessions.push({ id, root, title, options });
    return id;
  }

  async runTurn(sessionId: string, content: string, observer: TurnObserver = {}): Promise<TurnResult> {
    this.aborted.delete(sessionId); // an abort ends the turn it lands in, never a later one
    this.prompts.push({ session: sessionId, content });
    const steps = this.turns.shift() ?? [{ text: "Done." }];
    let text = "";
    for (const [index, step] of steps.entries()) {
      if (this.aborted.has(sessionId)) return { reason: "aborted", text };
      if ("tool" in step) {
        const toolCallId = `${sessionId}-${this.prompts.length}-${index}`;
        observer.onToolStart?.({ toolCallId, toolName: step.tool, args: step.args ?? {} });
        const result = await this.runTool(sessionId, step.tool, step.args ?? {});
        this.results.push({ session: sessionId, tool: step.tool, result });
        const output = String(result.content ?? "");
        observer.onToolEnd?.({ toolCallId, toolName: step.tool, isError: !result.ok, ms: 1, result: output.slice(0, 600), text: output });
        // an abort the tool set off (the hub took the report) lands before the next step, as in the engine
        await new Promise((resolve) => setImmediate(resolve));
      } else if ("write" in step) {
        const session = this.sessions.find((item) => item.id === sessionId)!;
        const toolCallId = `${sessionId}-${this.prompts.length}-${index}`;
        const request: ToolPermissionRequest = {
          requestId: toolCallId,
          sessionId,
          toolCallId,
          toolName: "Write",
          argsPreview: { path: step.write, content: step.content },
          risk: "medium",
          reason: "Write needs approval",
        };
        observer.onToolStart?.({ toolCallId, toolName: "Write", args: request.argsPreview });
        const allowed = session.options.decide?.(request) === "allow-once";
        if (allowed) {
          const target = resolve(session.root, step.write);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, step.content);
          observer.onPermissionAllowed?.(request);
        } else {
          observer.onPermissionDenied?.(request);
        }
        const output = allowed ? `Wrote ${step.write}` : "Permission denied";
        observer.onToolEnd?.({ toolCallId, toolName: "Write", isError: !allowed, ms: 1, result: output, text: output });
      } else if ("act" in step) {
        await step.act(this.sessions.find((item) => item.id === sessionId)!.root);
      } else if ("usage" in step) {
        observer.onUsage?.(step.usage);
      } else if ("text" in step) {
        text = step.text;
        observer.onAssistantText?.(step.text);
      } else {
        await new Promise<void>((resolve) => {
          if (this.aborted.has(sessionId)) resolve();
          else this.waiting.set(sessionId, resolve);
        });
      }
    }
    return { reason: this.aborted.has(sessionId) ? "aborted" : "completed", text };
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.add(sessionId);
    this.waiting.get(sessionId)?.();
    this.waiting.delete(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
  }
}
