import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A plugin tool's planSafeActions must reach the runtime through the real host process: the
// actions it lists run in Plan and Goal mode, every other action is refused there (ADR 0211).

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "..", "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

const TOOL = {
  name: "lookup",
  description: "Reads or changes something.",
  risk: "medium",
  planSafeActions: ["status"],
  schema: {
    type: "object",
    properties: { action: { type: "string", enum: ["status", "change"] } },
    required: ["action"],
  },
};

function toolPlugin() {
  const dir = mkdtempSync(join(tmpdir(), "pi-plan-safe-"));
  const manifest = {
    schemaVersion: 1,
    id: "com.example.plansafe",
    name: "Plan safe",
    version: "0.0.1",
    main: "main.js",
    permissions: ["agent.tool.register"],
    contributes: { agentTools: [TOOL] },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(
    join(dir, "main.js"),
    `const TOOL = ${JSON.stringify(TOOL)};
module.exports = {
  async onLoad() {
    await pi.agent.registerTool({ ...TOOL, execute: async (args) => ({ ran: args.action }) });
  },
};
`,
    "utf8",
  );
  return dir;
}

test("a plugin tool's plan-safe actions run in Plan mode through the host process; the others are refused", async (t) => {
  const runtime = new PluginRuntime({ hostEntry: hostProcessEntry, spawnProcess: forkPluginProcess, audit: () => {} });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  await runtime.loadFromPath(toolPlugin());
  const tool = runtime.getTools().find((x) => x.name === "lookup");
  assert.ok(tool, "the tool is registered");
  assert.deepEqual([...(tool.planSafeActions ?? [])], ["status"]);
  assert.deepEqual(await tool.execute({ action: "status" }, { mode: "plan" }), { ran: "status" });
  await assert.rejects(tool.execute({ action: "change" }, { mode: "plan" }), { code: "PERMISSION_DENIED" });
  assert.deepEqual(await tool.execute({ action: "change" }, { mode: "agent" }), { ran: "change" });
});
