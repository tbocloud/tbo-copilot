import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { PluginToolDef } from "@pi-desktop/agent-runtime";
import {
  AgentSidecar,
  HostProcess,
  RuntimeService,
  createHeadlessLaunchResolver,
  type LaunchResolver,
  type LocalToolResult,
} from "@pi-desktop/host-runtime";
import type { AgentEventEnvelope, AskToolRequest, MessageUsage, ToolPermissionRequest } from "@pi-desktop/shared";

import type { ModelConfig } from "./config.js";
import type { Logger } from "./log.js";
import { PERMISSION_DECISION, answersFor, type PermissionDecider } from "./policy.js";

/** What a session's model is told and given: the investigation's, or another stage's (the fix). */
export type SessionProfile = { tools: PluginToolDef[]; persona: string; rules: string };

export type SessionOptions = {
  /** A profile from EngineOptions.profiles; the investigation's tools and prompt when absent. */
  profile?: string;
  /** Answers this session's permission prompts; every prompt is refused when absent. */
  decide?: PermissionDecider;
};

export type EngineOptions = {
  hostCoreBinary: string;
  sidecarEntry: string;
  nodeBinary: string;
  dataDir: string;
  /** The engine's HOME: an empty folder, so no desktop setup (subagents, global instructions, prompts) reaches a run. */
  homeDir: string;
  log: Logger;
  tools: PluginToolDef[];
  runTool: (sessionId: string, name: string, args: unknown, signal: AbortSignal) => Promise<LocalToolResult>;
  persona: string;
  rules: string;
  /** Other stages' tools and prompts, chosen per session (openSession's `profile`). */
  profiles?: Record<string, SessionProfile>;
};

export type TurnObserver = {
  onToolStart?(event: { toolCallId: string; toolName: string; args: unknown; delegate?: string }): void;
  onToolEnd?(event: { toolCallId: string; toolName: string; isError: boolean; ms: number; result: string }): void;
  onPermissionDenied?(request: ToolPermissionRequest): void;
  onPermissionAllowed?(request: ToolPermissionRequest): void;
  onInputAnswered?(request: AskToolRequest): void;
  onUsage?(usage: MessageUsage): void;
  onAssistantText?(text: string): void;
};

export type TurnResult = { reason: "completed" | "aborted" | "error"; errorCode?: string; text: string };

const SECRET_ENV = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;

/** The parent's environment without secrets, with the engine's own HOME: what host-core and the sidecar get. */
export function childEnvironment(homeDir: string, dataDir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) env[key] = SECRET_ENV.test(key) || key.startsWith("TBO_") ? undefined : value;
  return { ...env, HOME: homeDir, PI_DESKTOP_DATA_DIR: dataDir };
}

/** The text of an assistant message, whether the runtime gives a string or content blocks. */
export function messageText(message: { content?: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
      .join("")
      .trim();
  }
  return "";
}

/** A tool result as a short string for the run's events. */
export function preview(value: unknown, limit = 600): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    const blocks = (value as { content?: unknown } | null)?.content;
    text = Array.isArray(blocks)
      ? blocks.map((block) => String((block as { text?: unknown })?.text ?? "")).join("\n")
      : JSON.stringify(value ?? "");
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * The pi engine without a desktop or a network server: host-core and the
 * agent sidecar as child processes, driven in-process through the runtime
 * service (as apps/pi-host composes them, without RACP). Sessions run in
 * agent mode with permission mode `ask`, and every prompt is answered `deny`.
 */
export class Engine {
  private constructor(
    private readonly host: HostProcess,
    private readonly sidecar: AgentSidecar,
    readonly runtime: RuntimeService,
    private readonly options: EngineOptions,
    private readonly sessions: Map<string, SessionOptions>,
  ) {}

  static async start(options: EngineOptions): Promise<Engine> {
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(options.homeDir, { recursive: true, mode: 0o700 });
    const state: { host: HostProcess | null; sidecar: AgentSidecar | null } = { host: null, sidecar: null };
    const sessions = new Map<string, SessionOptions>();
    const profileOf = (sessionId: string): SessionProfile => {
      const name = sessions.get(sessionId)?.profile;
      return (name && options.profiles?.[name]) || { tools: options.tools, persona: options.persona, rules: options.rules };
    };
    const log = options.log;
    const base = createHeadlessLaunchResolver({ getHost: () => state.host, dataDir: options.dataDir, log: (level, message, data) => log(level, message, data) });
    const launch: LaunchResolver = {
      async resolve(sessionId, session, settings, overrides) {
        const resolved = await base.resolve(sessionId, session, settings, overrides);
        const profile = profileOf(sessionId);
        return {
          ...resolved,
          sidecarParams: {
            ...resolved.sidecarParams,
            pluginTools: profile.tools,
            pluginSkills: [],
            trustedExtensions: [],
            // no delegates: a subagent definition can carry its own permission mode
            subagents: [],
            subagentProviders: {},
            subagentModelKeys: [],
            // a repository's AGENTS.md is data to read, not instructions
            projectInstructions: undefined,
            projectMemory: undefined,
            customSystemPrompt: { replace: profile.persona, append: profile.rules },
          },
        };
      },
    };
    const runtime = new RuntimeService({ getHost: () => state.host, getSidecar: () => state.sidecar, launch, log: (level, message, data) => log(level, message, data) });
    const env = childEnvironment(options.homeDir, options.dataDir);

    const host = new HostProcess({
      binaryPath: options.hostCoreBinary,
      dataDir: options.dataDir,
      env,
      onStderr: (text) => log("debug", "host-core", { text: text.slice(0, 2_000) }),
    });
    state.host = host;
    try {
      await host.handshake();
      await host.call("session.recoverInflightMessages").catch(() => undefined);
    } catch (error) {
      await host.dispose();
      throw error;
    }
    runtime.attachHost(host);

    const sidecar = new AgentSidecar({
      launch: { command: options.nodeBinary, args: [options.sidecarEntry], env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv },
      onStderr: (text) => log("debug", "sidecar", { text: text.slice(0, 2_000) }),
    });
    // no repository instructions; an empty list, because an absent JSON-RPC result stalls each file tool for 2 s
    sidecar.setProjectInstructionResolver(async () => ({ entries: [] }));
    // every profile's tools are registered once; each session is offered only its own profile's
    const names = new Set([...options.tools, ...Object.values(options.profiles ?? {}).flatMap((profile) => profile.tools)].map((tool) => tool.name));
    for (const name of names) {
      sidecar.setLocalTool(name, ({ sessionId, args, signal }) => options.runTool(sessionId, name, args, signal));
    }
    state.sidecar = sidecar;
    runtime.attachSidecar(sidecar);
    sidecar.setHost(host);
    try {
      await sidecar.call("sidecar.configure", { hostBinary: options.hostCoreBinary, dataDir: options.dataDir });
    } catch (error) {
      await sidecar.dispose();
      await host.dispose();
      throw error;
    }
    log("info", "engine ready", { dataDir: options.dataDir });
    return new Engine(host, sidecar, runtime, options, sessions);
  }

  /** Creates or updates the worker's model provider and makes it the default; permission mode `ask` by default too. */
  async configureModel(model: ModelConfig): Promise<{ providerId: string; modelId: string }> {
    const { providers } = await this.host.call<{ providers: Array<{ id: string; name: string }> }>("providers.list", { includeDisabled: true });
    const fields = {
      name: model.providerName,
      vendorKey: "custom",
      type: "openai_compatible",
      protocol: "openai_compatible",
      baseUrl: model.baseUrl,
      authKind: "api_key_and_base_url",
      apiStyle: model.apiStyle,
      models: [{ id: model.modelId, contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens }],
      defaultModelId: model.modelId,
      secretValue: model.apiKey,
      supportsReasoning: false,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    };
    const existing = (providers ?? []).find((provider) => provider.name === model.providerName);
    const saved = existing
      ? await this.host.call<{ provider: { id: string } }>("providers.update", { id: existing.id, ...fields, enabled: true })
      : await this.host.call<{ provider: { id: string } }>("providers.create", fields);
    await this.host.call("settings.set", { defaultProviderId: saved.provider.id, defaultModelId: model.modelId, defaultPermissionMode: "ask" });
    return { providerId: saved.provider.id, modelId: model.modelId };
  }

  /** A session in agent mode, permission mode `ask`, rooted at the run's folder. */
  async openSession(projectPath: string, title: string, model: { providerId: string; modelId: string }, options: SessionOptions = {}): Promise<string> {
    await this.host.call("projects.create", { path: projectPath });
    const { session } = await this.host.call<{ session: { id: string } }>("session.create", {
      title,
      mode: "agent",
      projectPath,
      providerId: model.providerId,
      modelId: model.modelId,
    });
    await this.host.call("session.configure", { id: session.id, mode: "agent", permissionMode: "ask" });
    this.sessions.set(session.id, options);
    return session.id;
  }

  /** Runs one turn to its end. Permission prompts are denied and questions answered while it runs. */
  async runTurn(sessionId: string, content: string, observer: TurnObserver = {}): Promise<TurnResult> {
    let text = "";
    const started = new Map<string, { name: string; at: number }>();
    let settle!: (result: TurnResult) => void;
    const done = new Promise<TurnResult>((resolve) => {
      settle = resolve;
    });
    const offEvent = this.runtime.onEvent((envelope) => {
      if (envelope.sessionId !== sessionId) return;
      void this.handle(envelope, observer, started, (value) => {
        text = value;
      });
    });
    const offEnd = this.runtime.onTurnEnded((info) => {
      if (info.sessionId !== sessionId) return;
      settle({ reason: info.reason, ...(info.errorCode ? { errorCode: info.errorCode } : {}), text });
    });
    try {
      await this.runtime.prompt({ sessionId, content, effectivePermissionMode: "ask", principal: { subject: "tbo-worker", roles: ["owner"] } });
      return await done;
    } catch (error) {
      const errorCode = (error as { errorCode?: string; data?: { errorCode?: string } }).errorCode ?? (error as { data?: { errorCode?: string } }).data?.errorCode;
      return { reason: "error", errorCode: errorCode ?? "PROMPT_FAILED", text: (error as Error).message };
    } finally {
      offEvent();
      offEnd();
    }
  }

  private async handle(
    envelope: AgentEventEnvelope,
    observer: TurnObserver,
    started: Map<string, { name: string; at: number }>,
    setText: (text: string) => void,
  ): Promise<void> {
    const event = envelope.event;
    try {
      switch (event.type) {
        case "tool_start":
          started.set(event.toolCallId, { name: event.toolName, at: Date.now() });
          observer.onToolStart?.({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, ...(envelope.agentName ? { delegate: envelope.agentName } : {}) });
          return;
        case "tool_end": {
          const begin = started.get(event.toolCallId);
          observer.onToolEnd?.({
            toolCallId: event.toolCallId,
            toolName: begin?.name ?? "unknown",
            isError: Boolean(event.isError),
            ms: begin ? Date.now() - begin.at : 0,
            result: preview(event.result),
          });
          return;
        }
        case "tool_permission_request": {
          const decide = this.sessions.get(envelope.sessionId)?.decide;
          const decision = decide ? decide(event.request) : PERMISSION_DECISION;
          await this.host.call("permissions.resolve", { requestId: event.request.requestId, decision });
          if (decision === PERMISSION_DECISION) observer.onPermissionDenied?.(event.request);
          else observer.onPermissionAllowed?.(event.request);
          return;
        }
        case "asktool_request":
          await this.runtime.respondInput({ requestId: event.request.requestId, sessionId: envelope.sessionId, answers: answersFor(event.request) });
          observer.onInputAnswered?.(event.request);
          return;
        case "usage":
          observer.onUsage?.(event.usage);
          return;
        case "message_end": {
          if (event.message.role !== "assistant") return;
          const value = messageText(event.message);
          if (value) {
            setText(value);
            observer.onAssistantText?.(value);
          }
          return;
        }
        default:
          return;
      }
    } catch (error) {
      this.options.log("warn", "engine event not handled", { type: event.type, error: String(error) });
    }
  }

  async abort(sessionId: string): Promise<void> {
    await this.runtime.abort(sessionId).catch((error: unknown) => this.options.log("warn", "abort failed", { sessionId, error: String(error) }));
  }

  /** Forgets the session, its transcript and its scratch folder. */
  async closeSession(sessionId: string, projectPath?: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.sidecar.clearProjectInstructionRoot(sessionId);
    await this.sidecar.call("agent.disposeSession", { sessionId }).catch(() => undefined);
    await this.host.call("session.delete", { id: sessionId }).catch((error: unknown) => this.options.log("warn", "session not deleted", { sessionId, error: String(error) }));
    if (projectPath) await this.host.call("projects.remove", { path: projectPath }).catch(() => undefined);
    await rm(join(this.options.dataDir, "scratch", sessionId), { recursive: true, force: true });
  }

  async stop(): Promise<void> {
    await this.runtime.dispose().catch(() => undefined);
    await this.sidecar.dispose().catch(() => undefined);
    await this.host.dispose().catch(() => undefined);
  }
}
