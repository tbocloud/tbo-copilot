"use strict";

// Runs main.js against a fake PI-Desktop host, with an in-memory key store, so
// the sign-in flow and the tool wiring are tested without the app or Keychain.

const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../../tbo.support/manifest.json");

const saved = new Map();
const storeCalls = [];
const credentials = require("../../tbo.support/lib/credentials");
credentials.createStore = () => ({
  async save(host, creds) {
    storeCalls.push(["save", host]);
    saved.set(host, creds);
  },
  async load(host) {
    return saved.get(host) || null;
  },
  async remove(host) {
    storeCalls.push(["remove", host]);
    saved.delete(host);
  },
});

const GOOD = { key: "abc123key", secret: "def456secret" };
const registered = { tools: [], commands: [] };
let settings = {};
const fetchCalls = [];

global.pi = {
  plugin: {
    getManifest: () => manifest,
    getSettings: async () => settings,
    setSettings: async (p) => Object.assign(settings, p),
    getDataPath: async () => "/tmp/tbo-support-test",
  },
  agent: {
    registerTool: async (tool) => registered.tools.push(tool),
    unregisterTool: async () => {},
  },
  commands: {
    register: async (c) => registered.commands.push(c),
    unregister: async () => {},
  },
  ui: { openPanel: async () => {}, showToast: async () => {} },
  net: {
    fetch: async (input) => {
      fetchCalls.push(input);
      const ok = input.headers.Authorization === `token ${GOOD.key}:${GOOD.secret}`;
      if (!ok) return { status: 401, headers: {}, bodyText: '{"exc_type":"AuthenticationError"}' };
      return { status: 200, headers: {}, bodyText: '{"message":"agent@example.com"}' };
    },
  },
};

const plugin = require("../../tbo.support/main.js");

test("onLoad registers the tool and three commands", async () => {
  await plugin.onLoad();
  assert.equal(registered.tools.length, 1);
  assert.equal(registered.tools[0].name, "tbo_support");
  assert.equal(typeof registered.tools[0].execute, "function");
  assert.deepEqual(
    registered.commands.map((c) => c.id),
    manifest.contributes.commands.map((c) => c.id),
  );
});

test("before sign-in the panel shows signed out and the tool says how to sign in", async () => {
  const state = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(state.ok, true);
  assert.equal(state.signedIn, false);
  assert.equal(state.site, "https://teams.teambackoffice.com");
  await assert.rejects(registered.tools[0].execute({ action: "who_am_i" }, { log() {} }), { code: "NOT_SIGNED_IN" });
});

test("a wrong key is tested and never saved", async () => {
  const res = await plugin.onPanelInvoke("tbo-support.sign-in", { key: "wrongkey1", secret: "wrongsecret1" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "AUTH");
  assert.equal(storeCalls.filter((c) => c[0] === "save").length, 0);
});

test("a good key is tested, saved, and then used by the tool", async () => {
  const res = await plugin.onPanelInvoke("tbo-support.sign-in", { ...GOOD });
  assert.equal(res.ok, true);
  assert.equal(res.user, "agent@example.com");
  assert.deepEqual(storeCalls.at(-1), ["save", "teams.teambackoffice.com"]);
  const logs = [];
  const me = await registered.tools[0].execute({ action: "who_am_i" }, { log: (m) => logs.push(m) });
  assert.equal(me.user, "agent@example.com");
  assert.deepEqual(logs, ["tbo_support who_am_i"]);
  assert.ok(fetchCalls.every((c) => c.url.startsWith("https://teams.teambackoffice.com/api/") && c.method === "GET"));
});

test("sign-out removes the key", async () => {
  const res = await plugin.onPanelInvoke("tbo-support.sign-out");
  assert.equal(res.ok, true);
  assert.equal(res.signedIn, false);
  await assert.rejects(registered.tools[0].execute({ action: "who_am_i" }, { log() {} }), { code: "NOT_SIGNED_IN" });
});

test("a site outside net.domains is refused", async () => {
  settings = { siteUrl: "https://evil.example.com" };
  const state = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(state.signedIn, false);
  assert.match(state.error, /may only reach teams\.teambackoffice\.com/);
  settings = {};
});

test("unknown panel channels are refused", async () => {
  const res = await plugin.onPanelInvoke("tbo-support.delete-everything");
  assert.equal(res.ok, false);
  assert.equal(res.code, "UNSUPPORTED");
});
