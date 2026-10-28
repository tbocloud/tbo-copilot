#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, envFilePath, envFileWarning, githubTokenFromGh, loadConfig, type WorkerConfig } from "./config.js";
import { Engine } from "./engine.js";
import { loadCases, reportMarkdown, runEvaluation } from "./evaluate.js";
import { BUILD_PERSONA, BUILD_RULES, FIX_PERSONA, FIX_RULES, REVIEW_PERSONA, REVIEW_RULES } from "./fix-prompt.js";
import { FIX_TOOL_DEFINITIONS, REVIEW_TOOL_DEFINITIONS } from "./fix-tools.js";
import { HubClient } from "./hub.js";
import { createLogger, type Logger, type LogLevel } from "./log.js";
import { PERSONA, RULES } from "./prompt.js";
import { SocketSandbox } from "./sandbox.js";
import { RunToolRouter, Worker } from "./supervisor.js";
import { TOOL_DEFINITIONS } from "./tools.js";

const USAGE = `tbo-worker <command>

  start                 claim Copilot runs from TBO Support and investigate them until stopped (Ctrl-C)
  once [--run NAME]     investigate one queued run (the named one, if given) and exit
  check                 check the settings, the hub key and the engine; the model is not called
  eval --cases FILE [--only A1,A2] [--report FILE]
                        run the evaluation cases (needs an agent's key) and write a report

Settings come from ~/.tbo-worker/env (set TBO_WORKER_DIR for another folder);
see apps/tbo-worker/README.md.`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function startEngine(cfg: WorkerConfig, router: RunToolRouter, log: Logger): Promise<Engine> {
  return Engine.start({
    hostCoreBinary: cfg.hostCoreBinary,
    sidecarEntry: cfg.sidecarEntry,
    nodeBinary: cfg.nodeBinary,
    dataDir: cfg.dataDir,
    homeDir: cfg.homeDir,
    log,
    tools: TOOL_DEFINITIONS,
    runTool: (sessionId, name, args) => router.run(sessionId, name, args),
    persona: PERSONA,
    rules: RULES,
    profiles: {
      fix: { tools: FIX_TOOL_DEFINITIONS, persona: FIX_PERSONA, rules: FIX_RULES },
      // a build of an approved customization: the fix's tools, its own rules
      build: { tools: FIX_TOOL_DEFINITIONS, persona: BUILD_PERSONA, rules: BUILD_RULES },
      review: { tools: REVIEW_TOOL_DEFINITIONS, persona: REVIEW_PERSONA, rules: REVIEW_RULES },
    },
  });
}

async function check(cfg: WorkerConfig, hub: HubClient, log: Logger): Promise<number> {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  say(`worker id   ${cfg.workerId}`);
  say(`hub         ${cfg.hubUrl}`);
  say(`hub user    ${await hub.whoAmI()}`);
  for (const provider of cfg.providers) say(`provider    ${provider.section} at ${provider.baseUrl} (${provider.apiStyle}); its models come from TBO Support`);
  if (cfg.model) say(`model       ${cfg.model.modelId} at ${cfg.model.baseUrl}${cfg.providers.length ? " (when TBO Support names no model for a provider above)" : ""}`);
  say(`github      ${cfg.githubToken ? "token found" : "no token (set GITHUB_TOKEN or log in with gh): only public repositories can be read"}`);
  say(`sandbox     ${cfg.sandboxSocket ? `runner at ${cfg.sandboxSocket}: investigations and fixes` : "none (TBO_SANDBOX_SOCKET not set): investigations only"}`);
  const engine = await startEngine(cfg, new RunToolRouter(hub), log);
  try {
    // a session opens on the older single model, or on the first provider (its models come from TBO Support)
    const model = await engine.configureModel(cfg.model ?? { ...cfg.providers[0]!, modelId: "engine-check", priceInPerMillion: 0, priceOutPerMillion: 0 });
    const probe = await mkdtemp(join(cfg.dir, "check-"));
    const session = await engine.openSession(probe, "tbo-worker check", model);
    await engine.closeSession(session, probe);
    await rm(probe, { recursive: true, force: true });
    say(`engine      ok (host-core ${cfg.hostCoreBinary})`);
  } finally {
    await engine.stop();
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 1;
  }
  let cfg: WorkerConfig;
  try {
    cfg = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\nPut them in ${envFilePath(process.env.TBO_WORKER_DIR ?? "~/.tbo-worker")} (mode 600).\n`);
      return 2;
    }
    throw error;
  }
  if (!cfg.githubToken) {
    const token = githubTokenFromGh();
    if (token) cfg.githubToken = token;
  }
  await mkdir(cfg.dir, { recursive: true, mode: 0o700 });
  const log = createLogger({ logsDir: cfg.logsDir, minLevel: (process.env.TBO_LOG_LEVEL as LogLevel) || "info" });
  const warning = envFileWarning(envFilePath(cfg.dir));
  if (warning) log("warn", warning);
  const hub = new HubClient(cfg.hubUrl, cfg.worker, cfg.agent ? { agent: cfg.agent } : {});
  if (command === "check") return check(cfg, hub, log);

  const router = new RunToolRouter(hub);
  const engine = await startEngine(cfg, router, log);
  const worker = new Worker(cfg, hub, engine, router, log, cfg.sandboxSocket ? new SocketSandbox(cfg.sandboxSocket) : undefined);
  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    log("info", "stopping: the current run is interrupted and its lease left to expire (press Ctrl-C again to quit now)");
    controller.abort();
    worker.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    switch (command) {
      case "start":
        await worker.runForever(controller.signal);
        return 0;
      case "once": {
        const report = await worker.runOnce(option(args, "--run"));
        process.stdout.write(`${JSON.stringify(report ?? { run: null, note: "nothing was queued" }, null, 2)}\n`);
        return report && report.outcome !== "submitted" ? 1 : 0;
      }
      case "eval": {
        const casesFile = option(args, "--cases");
        if (!casesFile) throw new Error("eval needs --cases FILE");
        const only = option(args, "--only")?.split(",").map((id) => id.trim());
        const cases = (await loadCases(casesFile)).filter((item) => !only || only.includes(item.id));
        const results = await runEvaluation(cases, { cfg, hub, worker, log, signal: controller.signal });
        const date = new Date().toISOString().slice(0, 16).replace("T", " ");
        const used = [...new Set(results.flatMap((result) => result.model.split(", ")).filter(Boolean))].join(", ");
        const markdown = reportMarkdown(results, { model: used || cfg.model?.modelId || "none answered", date });
        const reportFile = option(args, "--report") ?? join(cfg.dir, "eval", `report-${date.replace(/[ :]/g, "-")}.md`);
        await mkdir(join(reportFile, ".."), { recursive: true });
        await writeFile(reportFile, markdown);
        await writeFile(reportFile.replace(/\.md$/, "") + ".json", JSON.stringify(results, null, 1));
        process.stdout.write(`${markdown}\nReport written to ${reportFile}\n`);
        return 0;
      }
      default:
        process.stderr.write(`Unknown command ${command}.\n\n${USAGE}\n`);
        return 1;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await engine.stop();
  }
}

function invokedDirectly(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
