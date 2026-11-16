import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// TBO Phase 22: plugins with `desktop.control` keep a desktop project group
// for a task's folders through `pi.desktop.invoke`. The operations reuse the
// project-group IPC handlers, so a plugin gets exactly the renderer's checks.
const electron = `data:text/javascript,${encodeURIComponent(`
  export const app = { getPath: () => "/tmp", getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => "0.0.0", on() {} };
  export class BrowserWindow { static getAllWindows() { return []; } static fromWebContents() { return null; } }
  export const dialog = {};
  export const shell = {};
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "../electron/main/plugin-host-process.mjs");
const { IPC } = await import("@pi-desktop/shared");
const { registerWorkspaceIpc } = await import("../electron/main/ipc/workspace-ipc.ts");
const { createMcpControlController, createMcpControlOperations } = await import("../electron/main/mcp-control.ts");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const GROUP_OPERATIONS = [
  { id: "project/groups/list", channel: IPC.invoke.projectGroupList, risk: "read", argumentShape: [] },
  { id: "project/groups/create", channel: IPC.invoke.projectGroupCreate, risk: "write", argumentShape: ["input"] },
  { id: "project/groups/update", channel: IPC.invoke.projectGroupUpdate, risk: "write", argumentShape: ["input"] },
];

test("the reviewed catalog lists the three project-group operations on their IPC channels", () => {
  const operations = createMcpControlOperations(IPC.invoke);
  for (const expected of GROUP_OPERATIONS) {
    const operation = operations.find((candidate) => candidate.id === expected.id);
    assert.ok(operation, expected.id);
    assert.equal(operation.channel, expected.channel);
    assert.equal(operation.risk, expected.risk);
    assert.deepEqual(operation.argumentShape, expected.argumentShape);
    assert.equal(operation.pluginOnly, undefined, "same surface as project/set");
  }
  // Rename, memory and instructions stay unreviewed.
  assert.equal(operations.some((operation) => operation.channel === IPC.invoke.projectGroupRename), false);
  assert.equal(operations.some((operation) => operation.channel === IPC.invoke.projectGroupMemorySave), false);
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

// The panel bridge forwards one `pi.desktop.invoke` input and reports the outcome.
const INVOKING_PLUGIN = `
  module.exports = {
    onPanelInvoke: async (_channel, input) => {
      try {
        return { ok: true, result: await pi.desktop.invoke(input) };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    },
  };
`;

function writePlugin(root, id, permissions) {
  const dir = join(root, id);
  mkdirSync(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name: id,
    version: "0.0.1",
    main: "main.js",
    permissions,
  }), "utf8");
  writeFileSync(join(dir, "main.js"), INVOKING_PLUGIN, "utf8");
  return dir;
}

function fakeHost() {
  const calls = [];
  const groups = [];
  const record = (id, name, folders) => ({
    id,
    name,
    primaryPath: folders[0],
    roots: folders.map((path, position) => ({ path, name: path.split(/[\\/]/).at(-1), position })),
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    lastOpenedAt: 1,
  });
  return {
    calls,
    isAvailable: () => true,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "project.groups.list") return { groups: [...groups] };
      if (method === "project.group.create") {
        const group = record(`g${groups.length + 1}`, params.name, params.folders);
        groups.push(group);
        return { group };
      }
      if (method === "project.group.update") {
        const index = groups.findIndex((group) => group.id === params.groupId);
        if (index < 0) throw Object.assign(new Error("project group not found"), { errorCode: "INVALID_PARAMS" });
        groups[index] = record(params.groupId, params.name, params.folders);
        return { group: groups[index] };
      }
      throw new Error(`unexpected host call ${method}`);
    },
  };
}

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "tbo-project-groups-"));
  const host = fakeHost();
  const handlers = new Map();
  const registrar = {
    ipcMain: {},
    handle: (channel, handler) => handlers.set(channel, handler),
    handleWithEvent: () => {},
    assertMainWindowSender: () => {},
  };
  const runtime = new PluginRuntime({ hostEntry: hostProcessEntry, spawnProcess: forkPluginProcess });
  registerWorkspaceIpc({
    registrar,
    getMainWindow: () => null,
    getHost: () => host,
    getSidecar: () => null,
    dataDir: join(root, "data"),
    isDevelopmentBuild: false,
    plugins: runtime,
    browserHost: {},
    clipboardHistory: {},
    recordPastedClipboardFiles: () => {},
    currentWorkspacePath: () => null,
    setCurrentWorkspacePath: () => {},
    withGitBranch: async (workspace) => workspace,
    stripWinLongPrefix: (path) => path,
  });
  // The production controller over the real handlers, as startup wires it.
  runtime.setServices({
    desktopControl: createMcpControlController({
      channels: IPC.invoke,
      invoke: (channel, args) => handlers.get(channel)(...args),
    }),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, host, runtime };
}

test("a plugin cannot put a file or a missing path in a project group", async (t) => {
  const { root, host, runtime } = await setup(t);
  await runtime.loadFromPath(writePlugin(root, "demo.groups", ["desktop.control"]), ["desktop.control"]);
  const folder = join(root, "repo");
  mkdirSync(folder);
  const file = join(root, "notes.txt");
  writeFileSync(file, "not a folder", "utf8");

  for (const folders of [[folder, file], [join(root, "missing")]]) {
    const refused = await runtime.invokePanelBridge("demo.groups", "desktop.test", {
      operation: "project/groups/create",
      args: [{ name: "TBO · Demo", folders }],
    });
    assert.equal(refused.ok, false, JSON.stringify(folders));
    assert.equal(refused.code, "INVALID_ARGUMENT");
    assert.match(refused.message, /must be directories/);
  }
  assert.equal(host.calls.some((call) => call.method === "project.group.create"), false);
});

test("a plugin lists, creates and updates a project group of real folders", async (t) => {
  const { root, host, runtime } = await setup(t);
  await runtime.loadFromPath(writePlugin(root, "demo.groups", ["desktop.control"]), ["desktop.control"]);
  const app = join(root, "app");
  const theme = join(root, "theme");
  mkdirSync(app);
  mkdirSync(theme);
  const invoke = (input) => runtime.invokePanelBridge("demo.groups", "desktop.test", input);

  const created = await invoke({
    operation: "project/groups/create",
    args: [{ name: "  TBO · Demo  ", folders: [`${app}/`, theme, app] }],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.result.group.id, "g1");
  assert.deepEqual(host.calls.find((call) => call.method === "project.group.create").params, {
    name: "TBO · Demo",
    folders: [resolve(app), resolve(theme)],
  });

  const listed = await invoke({ operation: "project/groups/list" });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result.groups.map((group) => group.id), ["g1"]);

  const updated = await invoke({
    operation: "project/groups/update",
    args: [{ groupId: "g1", name: "TBO · Demo", folders: [app] }],
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.deepEqual(updated.result.group.roots.map((entry) => entry.path), [resolve(app)]);

  // The handler needs all three fields; a partial update is refused unchanged.
  const partial = await invoke({ operation: "project/groups/update", args: [{ groupId: "g1", name: "Renamed" }] });
  assert.equal(partial.ok, false);
  assert.equal(partial.code, "INVALID_ARGUMENT");
  const missing = await invoke({
    operation: "project/groups/update",
    args: [{ groupId: "nope", name: "TBO · Demo", folders: [app] }],
  });
  assert.equal(missing.ok, false, "an unknown group is the host's error");
});

test("project-group operations need desktop.control", async (t) => {
  const { root, host, runtime } = await setup(t);
  await runtime.loadFromPath(writePlugin(root, "demo.nogrant", []), []);
  const folder = join(root, "repo");
  mkdirSync(folder);
  const refused = await runtime.invokePanelBridge("demo.nogrant", "desktop.test", {
    operation: "project/groups/create",
    args: [{ name: "TBO · Demo", folders: [folder] }],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "PERMISSION_DENIED");
  assert.deepEqual(host.calls, []);
});
