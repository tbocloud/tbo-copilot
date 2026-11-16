import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// TBO Phase 22: `tbo-copilot://` links reach the bundled tbo.support plugin,
// and only that plugin. Electron is the boundary; this stand-in records what
// the module registers.
const electron = `data:text/javascript,${encodeURIComponent(`
  const state = (globalThis.__deepLinkElectron ??= { listeners: new Map(), registered: [], isDefault: false });
  export const app = {
    on(name, listener) { state.listeners.set(name, [...(state.listeners.get(name) ?? []), listener]); },
    isDefaultProtocolClient: () => state.isDefault,
    setAsDefaultProtocolClient(scheme) { state.registered.push(scheme); return true; },
  };
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "../electron/main/plugin-host-process.mjs");
const {
  DEEP_LINK_EVENT,
  DEEP_LINK_MAX_LENGTH,
  DEEP_LINK_PENDING_TTL_MS,
  DEEP_LINK_PLUGIN_ID,
  MAX_PENDING_DEEP_LINKS,
  acceptDeepLink,
  createDeepLinkRouter,
  deepLinksFromArgv,
  listenForDeepLinks,
  registerDeepLinks,
  shouldRegisterProtocolClient,
} = await import("../electron/main/bootstrap/deep-links.ts");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const electronState = globalThis.__deepLinkElectron;

const TASK_LINK = "tbo-copilot://task/TASK-2026-00123?site=https%3A%2F%2Fdemo-tbo.tbocloud.in";

test("only bounded tbo-copilot:// strings are accepted", () => {
  assert.equal(DEEP_LINK_EVENT, "app:openUrl");
  assert.equal(DEEP_LINK_PLUGIN_ID, "tbo.support");
  assert.equal(acceptDeepLink(TASK_LINK), TASK_LINK);
  const longest = "tbo-copilot://" + "a".repeat(DEEP_LINK_MAX_LENGTH - "tbo-copilot://".length);
  assert.equal(acceptDeepLink(longest), longest);
  for (const rejected of [
    longest + "a",
    "https://demo-tbo.tbocloud.in/task/TASK-2026-00123",
    "TBO-COPILOT://task/TASK-2026-00123",
    " tbo-copilot://task/TASK-2026-00123",
    "xtbo-copilot://task/TASK-2026-00123",
    "tbo-copilot:task/TASK-2026-00123",
    "",
    null,
    undefined,
    42,
    { url: TASK_LINK },
  ]) {
    assert.equal(acceptDeepLink(rejected), null, String(rejected));
  }
  assert.deepEqual(
    deepLinksFromArgv(["C:\\TBO Copilot\\TBO Copilot.exe", "--allow-file-access-from-files", TASK_LINK, "https://example.com"]),
    [TASK_LINK],
  );
});

function routerHarness() {
  const state = { booted: false, quitting: false, running: false, clock: 1_000 };
  const delivered = [];
  let restores = 0;
  const router = createDeepLinkRouter({
    deliver: (url) => {
      if (!state.running) return false;
      delivered.push(url);
      return true;
    },
    restoreMainWindow: () => { restores += 1; },
    isApplicationBooted: () => state.booted,
    isQuitting: () => state.quitting,
    now: () => state.clock,
  });
  return { state, delivered, router, restores: () => restores };
}

test("links wait for boot and for the plugin, then arrive once and in order", () => {
  const { state, delivered, router, restores } = routerHarness();
  router.receive(TASK_LINK);
  router.receive("tbo-copilot://task/TASK-2026-00124");
  router.receive("https://not-a-link.example");
  assert.deepEqual(delivered, []);
  assert.equal(restores(), 0, "before boot the startup sequence opens the window");

  state.booted = true;
  router.flush();
  assert.deepEqual(delivered, [], "booted, but the plugin is not running yet");

  state.running = true;
  router.flush();
  assert.deepEqual(delivered, [TASK_LINK, "tbo-copilot://task/TASK-2026-00124"]);
  router.flush();
  assert.equal(delivered.length, 2, "a delivered link is never replayed");

  router.receive("tbo-copilot://task/TASK-2026-00125");
  assert.equal(delivered.at(-1), "tbo-copilot://task/TASK-2026-00125");
  assert.equal(restores(), 1, "a link after boot brings the window up");
});

test("without the plugin a link only brings the window up and is later dropped", () => {
  const { state, delivered, router, restores } = routerHarness();
  state.booted = true;
  router.receive(TASK_LINK);
  assert.equal(restores(), 1);
  assert.deepEqual(delivered, []);

  state.clock += DEEP_LINK_PENDING_TTL_MS + 1;
  state.running = true;
  router.flush();
  assert.deepEqual(delivered, [], "a plugin enabled much later never replays an old link");
});

test("held links are bounded and nothing is taken while quitting", () => {
  const { state, delivered, router, restores } = routerHarness();
  for (let index = 0; index < MAX_PENDING_DEEP_LINKS + 3; index += 1) {
    router.receive(`tbo-copilot://task/TASK-2026-${String(index).padStart(5, "0")}`);
  }
  state.booted = true;
  state.running = true;
  router.flush();
  assert.equal(delivered.length, MAX_PENDING_DEEP_LINKS);
  assert.equal(delivered[0], "tbo-copilot://task/TASK-2026-00003", "the oldest links go first");

  state.quitting = true;
  router.receive(TASK_LINK);
  assert.equal(delivered.length, MAX_PENDING_DEEP_LINKS);
  assert.equal(restores(), 0);
});

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => { if (child.connected) child.send(message); },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

// Records every `app:openUrl` payload; the panel bridge reads them back.
const LISTENING_PLUGIN = `
  const received = [];
  module.exports = {
    onLoad: async () => pi.events.on("app:openUrl", (payload) => received.push(payload)),
    onPanelInvoke: async () => received,
  };
`;

function writePlugin(t, id) {
  const dir = mkdtempSync(join(tmpdir(), "tbo-deep-link-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name: id,
    version: "0.0.1",
    main: "main.js",
    permissions: [],
  }), "utf8");
  writeFileSync(join(dir, "main.js"), LISTENING_PLUGIN, "utf8");
  return dir;
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("a link reaches tbo.support alone, after it has loaded", async (t) => {
  const runtime = new PluginRuntime({ hostEntry: hostProcessEntry, spawnProcess: forkPluginProcess });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const other = writePlugin(t, "demo.other");
  await runtime.loadFromPath(other, []);

  // A cold start: the link is on the command line and macOS sends another as
  // `open-url`, both before the runtime exists.
  const { app } = await import("electron");
  listenForDeepLinks(app, ["/app", TASK_LINK]);
  let prevented = false;
  for (const listener of electronState.listeners.get("open-url")) {
    listener({ preventDefault: () => { prevented = true; } }, "tbo-copilot://task/TASK-2026-00200");
  }
  assert.equal(prevented, true);
  for (const listener of electronState.listeners.get("open-url")) {
    listener({ preventDefault() {} }, "https://example.com/not-ours");
  }

  let booted = false;
  let restores = 0;
  const router = registerDeepLinks({
    plugins: runtime,
    restoreMainWindow: () => { restores += 1; },
    isApplicationBooted: () => booted,
    isQuitting: () => false,
    registerProtocolClient: false,
  });
  assert.deepEqual(electronState.registered, [], "development and test runs never take the scheme");

  booted = true;
  router.flush();
  assert.equal(runtime.sendEventTo(DEEP_LINK_PLUGIN_ID, DEEP_LINK_EVENT, [{ url: TASK_LINK }]), false, "not installed");

  await runtime.loadFromPath(writePlugin(t, DEEP_LINK_PLUGIN_ID), []);
  // A second launch while running (Windows and Linux).
  for (const listener of electronState.listeners.get("second-instance")) {
    listener({}, ["/app", "--flag", "tbo-copilot://task/TASK-2026-00300"], "/", {});
  }
  assert.equal(restores, 1, "a link after boot brings the window up");
  await settle();

  assert.deepEqual(await runtime.invokePanelBridge(DEEP_LINK_PLUGIN_ID, "read", {}), [
    { url: TASK_LINK },
    { url: "tbo-copilot://task/TASK-2026-00200" },
    { url: "tbo-copilot://task/TASK-2026-00300" },
  ]);
  assert.deepEqual(await runtime.invokePanelBridge("demo.other", "read", {}), [], "no other plugin sees a link");
});

test("a plugin still running onLoad is not sent the event", async (t) => {
  const runtime = new PluginRuntime({ hostEntry: hostProcessEntry, spawnProcess: forkPluginProcess });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin(t, "demo.slow");
  writeFileSync(join(dir, "main.js"), `
    const received = [];
    module.exports = {
      onLoad: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        pi.events.on("app:openUrl", (payload) => received.push(payload));
      },
      onPanelInvoke: async () => received,
    };
  `, "utf8");
  const loading = runtime.loadFromPath(dir, []);
  while (!runtime.listLoaded().some((loaded) => loaded.manifest.id === "demo.slow")) await settle();
  assert.equal(runtime.sendEventTo("demo.slow", DEEP_LINK_EVENT, [{ url: TASK_LINK }]), false);
  await loading;
  assert.equal(runtime.sendEventTo("demo.slow", DEEP_LINK_EVENT, [{ url: TASK_LINK }]), true);
  assert.deepEqual(await runtime.invokePanelBridge("demo.slow", "read", {}), [{ url: TASK_LINK }]);
});

test("only an installed run of the default profile takes the scheme", () => {
  const installed = { isDevelopmentBuild: false, singleInstanceRequired: true };
  assert.equal(shouldRegisterProtocolClient(installed, {}), true);
  assert.equal(shouldRegisterProtocolClient({ ...installed, isDevelopmentBuild: true }, {}), false);
  assert.equal(shouldRegisterProtocolClient({ ...installed, singleInstanceRequired: false }, {}), false, "E2E and test profiles");
  assert.equal(
    shouldRegisterProtocolClient(installed, { PORTABLE_EXECUTABLE_FILE: "C:\\Downloads\\TBO-Copilot-Portable.exe" }),
    false,
    "the portable EXE runs from a temporary folder",
  );
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.build.protocols, [{ name: "TBO Copilot", schemes: ["tbo-copilot"] }]);
});

test("installed builds register the scheme once", async () => {
  const plugins = { sendEventTo: () => false, setServices: () => {} };
  const deps = { plugins, restoreMainWindow() {}, isApplicationBooted: () => true, isQuitting: () => false };
  electronState.registered.length = 0;
  registerDeepLinks({ ...deps, registerProtocolClient: true });
  assert.deepEqual(electronState.registered, ["tbo-copilot"]);
  electronState.isDefault = true;
  registerDeepLinks({ ...deps, registerProtocolClient: true });
  assert.deepEqual(electronState.registered, ["tbo-copilot"], "already the handler: no second write");
});

test("entry listens for links before ready, only in the instance that holds the lock", () => {
  const entry = readFileSync(new URL("../electron/main/entry.ts", import.meta.url), "utf8");
  const locked = entry.indexOf("if (hasSingleInstanceLock) {");
  const listen = entry.indexOf("listenForDeepLinks(app)");
  assert.ok(locked > 0 && listen > locked, "inside the lock holder's branch");
  assert.ok(listen < entry.indexOf("prepareStorage("), "before storage and the runtime import");
  const main = readFileSync(new URL("../electron/main/index.ts", import.meta.url), "utf8");
  assert.match(main, /registerProtocolClient: shouldRegisterProtocolClient\(\{ isDevelopmentBuild, singleInstanceRequired \}\)/);
  assert.match(main, /flushPendingApplicationMenuCommands\(\);\s*deepLinks\.flush\(\);/);
});
