import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ADR 0319: a plugin configures the provider rows it owns through
// pi.providers. Electron main checks `provider.register` and the argument
// shapes; host-core (stubbed here) checks ownership. The key is write only.

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => child.connected && child.send(message),
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function writePlugin({ id, permissions, main, net, contributes }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-provider-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions,
      ...(net ? { net } : {}),
      ...(contributes ? { contributes } : {}),
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

async function runCommand(runtime, id) {
  const command = runtime.getCommands().find((entry) => entry.id === id);
  assert.ok(command, `command not registered: ${id}`);
  await command.run();
}

function recordingProviders(calls) {
  return {
    setCredential: async (pluginId, input) => {
      calls.push(["setCredential", pluginId, input]);
      return { ok: true };
    },
    clearCredential: async (pluginId, input) => {
      calls.push(["clearCredential", pluginId, input]);
      return { ok: true };
    },
    setBaseUrl: async (pluginId, input) => {
      calls.push(["setBaseUrl", pluginId, input]);
      return { ok: true };
    },
  };
}

test("pi.providers forwards the plugin id and the declared provider id, write only", async (t) => {
  const calls = [];
  const audit = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    providers: recordingProviders(calls),
    audit: (entry) => audit.push(entry),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    id: "demo.signin",
    permissions: ["provider.register"],
    net: { domains: ["ai.example.com"] },
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "sign-in",
            title: "Sign in",
            run: async () => {
              const stored = await pi.providers.setCredential(" tbo-ai ", "sk-secret-value");
              await pi.ui.showToast("stored:" + String(stored));
              await pi.providers.setBaseUrl("tbo-ai", "https://ai.example.com/v1");
              await pi.providers.clearCredential("tbo-ai");
              for (const [name, call] of [
                ["noId", () => pi.providers.setCredential("", "sk-x")],
                ["longId", () => pi.providers.setCredential("x".repeat(65), "sk-x")],
                ["keyNotString", () => pi.providers.setCredential("tbo-ai", 42)],
                ["keyTooLong", () => pi.providers.setCredential("tbo-ai", "k".repeat(4097))],
                ["urlNotString", () => pi.providers.setBaseUrl("tbo-ai", null)],
                ["urlNotDeclared", () => pi.providers.setBaseUrl("tbo-ai", "https://elsewhere.example.net/v1")]
              ]) {
                try { await call(); }
                catch (error) { await pi.ui.showToast(name + ":" + error.code); }
              }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["provider.register"]);
  await runCommand(runtime, "sign-in");

  assert.deepEqual(calls, [
    ["setCredential", "demo.signin", { providerId: "tbo-ai", apiKey: "sk-secret-value" }],
    ["setBaseUrl", "demo.signin", { providerId: "tbo-ai", baseUrl: "https://ai.example.com/v1" }],
    ["clearCredential", "demo.signin", { providerId: "tbo-ai" }],
  ]);
  assert.deepEqual(runtime.drainToasts(), [
    // Nothing comes back to the plugin: not the key, not the row.
    "stored:undefined",
    "noId:INVALID_PARAMS",
    "longId:INVALID_PARAMS",
    "keyNotString:INVALID_PARAMS",
    "keyTooLong:INVALID_PARAMS",
    "urlNotString:INVALID_PARAMS",
    // The endpoint gets the conversation and the key: only a declared host.
    "urlNotDeclared:PERMISSION_DENIED",
  ]);
  assert.ok(
    !JSON.stringify(audit).includes("sk-secret-value"),
    "the audit log never carries the key",
  );
  assert.ok(audit.some((entry) => entry.api === "providers.setCredential" && entry.ok === true));
  assert.ok(audit.some((entry) => entry.api === "providers.setBaseUrl" && entry.ok === false
    && entry.errorCode === "PERMISSION_DENIED"));
});

test("pi.providers is refused without the provider.register permission", async (t) => {
  const calls = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    providers: recordingProviders(calls),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    id: "demo.no-provider",
    permissions: ["ui.panel"],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "try",
            title: "Try",
            run: async () => {
              for (const [name, call] of [
                ["set", () => pi.providers.setCredential("tbo-ai", "sk-x")],
                ["clear", () => pi.providers.clearCredential("tbo-ai")],
                ["url", () => pi.providers.setBaseUrl("tbo-ai", "https://ai.example.com/v1")]
              ]) {
                try { await call(); }
                catch (error) { await pi.ui.showToast(name + ":" + error.code); }
              }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["ui.panel"]);
  await runCommand(runtime, "try");
  assert.deepEqual(calls, []);
  assert.deepEqual(runtime.drainToasts(), [
    "set:PERMISSION_DENIED",
    "clear:PERMISSION_DENIED",
    "url:PERMISSION_DENIED",
  ]);
});

test("a run-time provider endpoint answers to the plugin's current net.domains at every launch", async (t) => {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    providers: recordingProviders([]),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    id: "demo.endpoint",
    permissions: ["provider.register"],
    net: { domains: ["ai.example.com"] },
    contributes: {
      providers: [
        { id: "signed", name: "Signed in", authKind: "api_key", models: [{ id: "m1" }] },
        { id: "fixed", name: "Fixed", baseUrl: "https://fixed.example.org/v1", authKind: "api_key", models: [{ id: "m1" }] },
      ],
    },
    main: "module.exports = { async onLoad() {} };",
  });
  await runtime.loadFromPath(dir, ["provider.register"]);
  const allowed = (providerId, url) => runtime.ownedProviderEndpointAllowed("demo.endpoint", providerId, url);

  // set at run time: only a declared host
  assert.equal(allowed("plugin:demo.endpoint:signed", "https://ai.example.com/v1"), true);
  assert.equal(allowed("plugin:demo.endpoint:signed", "https://elsewhere.example.net/v1"), false);
  assert.equal(allowed("plugin:demo.endpoint:signed", undefined), false);
  // declared in the manifest: ADR 0259 behaviour, unchanged
  assert.equal(allowed("plugin:demo.endpoint:fixed", "https://fixed.example.org/v1"), true);
  // a plugin that is not loaded has its rows disabled by host-core
  assert.equal(runtime.ownedProviderEndpointAllowed("not.loaded", "plugin:not.loaded:x", "https://x.test"), true);
});
