"use strict";

// Runs main.js against a fake TBO Copilot host and a fake TBO Support, with an
// in-memory store, so the sign-in flows and the tool wiring are tested without
// the app, the Keychain or a site.

const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../../tbo.support/manifest.json");

const saved = new Map();
const sessions = new Map();
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
  async saveSession(host, session) {
    storeCalls.push(["saveSession", host]);
    sessions.set(host, JSON.parse(JSON.stringify({ ...session, ai: undefined })));
  },
  async loadSession(host) {
    return sessions.get(host) || null;
  },
  async removeSession(host) {
    storeCalls.push(["removeSession", host]);
    sessions.delete(host);
  },
});

const SITE = "https://teams.teambackoffice.com";
const HOST = "teams.teambackoffice.com";
const GOOD = { key: "abc123key", secret: "def456secret" };
const registered = { tools: [], commands: [] };
const opened = [];
const providerCalls = [];
const toasts = [];
let settings = {};

// TBO Support, as far as the plugin sees it
const hub = {
  finishAnswers: [],
  refreshStatus: 200,
  refreshReason: "",
  tokens: new Set(),
  issued: 0,
  calls: [],
};
const ok = (message) => ({ status: 200, headers: {}, bodyText: JSON.stringify({ message }) });
function newToken() {
  hub.issued += 1;
  const token = `bearer-${hub.issued}`;
  hub.tokens.add(token);
  return token;
}
const AI = { base_url: "https://ai.example.test/v1", key: "sk-person-1", models: ["tbo-default"], monthly_limit: 50 };

async function hubFetch(input) {
  const path = new URL(input.url).pathname.replace("/api/method/", "");
  hub.calls.push({ path, method: input.method, auth: input.headers.Authorization });
  const body = input.body ? JSON.parse(input.body) : {};
  if (path === "tbo_desktop.api.start_sign_in") {
    return ok({ code: "K7P-4QX", device_code: "device-1", verify_url: `${SITE}/copilot-desktop/sign-in?code=K7P-4QX`, expires_in: 600, interval: 1 });
  }
  if (path === "tbo_desktop.api.finish_sign_in") {
    const next = hub.finishAnswers.shift() || "approved";
    if (next !== "approved") return ok({ status: next });
    return ok({
      status: "approved",
      computer_token: "computer-1",
      access_token: newToken(),
      access_expires_in: 43200,
      expires_at: "2026-12-06 10:00:00",
      user: { email: "rahul@teambackoffice.com", full_name: "Rahul" },
      ai: AI,
    });
  }
  if (path === "tbo_desktop.api.refresh") {
    assert.equal(body.computer_token, "computer-1");
    if (hub.refreshStatus !== 200) {
      return { status: hub.refreshStatus, headers: {}, bodyText: JSON.stringify({ message: { status: "signed_out", reason: hub.refreshReason } }) };
    }
    return ok({ access_token: newToken(), access_expires_in: 43200, expires_at: "2026-12-06 10:00:00", user: { email: "rahul@teambackoffice.com", full_name: "Rahul" }, ai: AI });
  }
  if (path === "tbo_desktop.api.sign_out") return ok({ ok: true });
  if (path === "frappe.auth.get_logged_user") {
    const auth = input.headers.Authorization;
    if (auth === `token ${GOOD.key}:${GOOD.secret}`) return ok("agent@example.com");
    if (auth && auth.startsWith("Bearer ") && hub.tokens.has(auth.slice(7))) return ok("rahul@teambackoffice.com");
    return { status: 401, headers: {}, bodyText: '{"exc_type":"AuthenticationError"}' };
  }
  return { status: 404, headers: {}, bodyText: "{}" };
}

global.pi = {
  plugin: {
    getManifest: () => manifest,
    getSettings: async () => settings,
    setSettings: async (p) => Object.assign(settings, p),
    getDataPath: async () => "/tmp/tbo-support-test",
  },
  app: { getVersion: async () => "0.16.1" },
  agent: {
    registerTool: async (tool) => registered.tools.push(tool),
    unregisterTool: async () => {},
  },
  commands: {
    register: async (c) => registered.commands.push(c),
    unregister: async () => {},
  },
  providers: {
    setBaseUrl: async (id, url) => providerCalls.push(["setBaseUrl", id, url]),
    setCredential: async (id, key) => providerCalls.push(["setCredential", id, key]),
    clearCredential: async (id) => providerCalls.push(["clearCredential", id]),
  },
  shell: { openExternal: async (url) => opened.push(url) },
  ui: { openPanel: async () => {}, showToast: async (m) => toasts.push(m) },
  net: { fetch: hubFetch },
};

const plugin = require("../../tbo.support/main.js");
const tool = () => registered.tools[0];
const signedOut = async () => {
  await plugin.onPanelInvoke("tbo-support.sign-out");
  providerCalls.length = 0;
};

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

test("onLoad registers the tool and three commands", async () => {
  await plugin.onLoad();
  assert.equal(registered.tools.length, 1);
  assert.equal(tool().name, "tbo_support");
  assert.deepEqual(
    registered.commands.map((c) => c.id),
    manifest.contributes.commands.map((c) => c.id),
  );
});

test("before sign-in the panel shows signed out and the tool says how to sign in", async () => {
  const state = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(state.ok, true);
  assert.equal(state.signedIn, false);
  assert.equal(state.local, false);
  assert.equal(state.site, SITE);
  await assert.rejects(tool().execute({ action: "who_am_i" }, { log() {} }), { code: "NOT_SIGNED_IN" });
});

test("Sign in with Microsoft: browser opened, wait for Allow, then TBO Support and TBO AI are ready", async () => {
  hub.finishAnswers = ["pending", "approved"];
  const started = await plugin.onPanelInvoke("tbo-support.microsoft");
  assert.equal(started.ok, true);
  assert.equal(started.pending.code, "K7P-4QX");
  assert.deepEqual(opened, [`${SITE}/copilot-desktop/sign-in?code=K7P-4QX`]);
  const waiting = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(waiting.pending.code, "K7P-4QX");

  await waitFor(async () => (await plugin.onPanelInvoke("tbo-support.state")).signedIn);
  const state = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(state.method, "microsoft");
  assert.equal(state.fullName, "Rahul");
  assert.equal(state.ai.ready, true);
  assert.deepEqual(providerCalls, [
    ["setBaseUrl", "tbo-ai", "https://ai.example.test/v1"],
    ["setCredential", "tbo-ai", "sk-person-1"],
  ]);
  assert.equal(sessions.get(HOST).ai, undefined); // the AI key lives in the app's provider row only
  assert.ok(toasts.at(-1).includes("TBO AI is ready"));

  const me = await tool().execute({ action: "who_am_i" }, { log() {} });
  assert.equal(me.user, "rahul@teambackoffice.com");
  assert.equal(hub.calls.at(-1).auth, "Bearer bearer-1");
});

test("a token TBO Support refuses is renewed once and the call retried", async () => {
  hub.tokens.delete("bearer-1"); // revoked on the site
  const me = await tool().execute({ action: "who_am_i" }, { log() {} });
  assert.equal(me.user, "rahul@teambackoffice.com");
  assert.ok(hub.calls.some((c) => c.path === "tbo_desktop.api.refresh"));
  assert.equal(sessions.get(HOST).accessToken, "bearer-2");
  assert.equal(providerCalls.length, 2); // the same AI key: not stored again
});

test("when TBO Support ends the sign-in, the session and the AI key are removed", async () => {
  hub.tokens.clear();
  hub.refreshStatus = 401;
  hub.refreshReason = "You do not have the role TBO Copilot Desktop. Ask a System Manager.";
  await assert.rejects(tool().execute({ action: "who_am_i" }, { log() {} }), { code: "SIGNED_OUT", message: /role/ });
  assert.equal(sessions.has(HOST), false);
  assert.deepEqual(providerCalls.at(-1), ["clearCredential", "tbo-ai"]);
  assert.ok(toasts.at(-1).startsWith("Your TBO sign-in ended"));
  const state = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(state.signedIn, false);
  hub.refreshStatus = 200;
});

test("a denied sign-in is reported once and nothing is kept", async () => {
  hub.finishAnswers = ["denied"];
  await plugin.onPanelInvoke("tbo-support.microsoft");
  await waitFor(async () => {
    const s = await plugin.onPanelInvoke("tbo-support.state");
    return s.pending && s.pending.error;
  });
  assert.equal(sessions.has(HOST), false);
  const after = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(after.pending, null);
});

test("cancel stops waiting", async () => {
  hub.finishAnswers = ["pending", "pending", "pending"];
  await plugin.onPanelInvoke("tbo-support.microsoft");
  const res = await plugin.onPanelInvoke("tbo-support.cancel");
  assert.equal(res.ok, true);
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).pending, null);
});

test("sign-out tells TBO Support and clears the AI key", async () => {
  hub.finishAnswers = ["approved"];
  await plugin.onPanelInvoke("tbo-support.microsoft");
  await waitFor(async () => sessions.has(HOST));
  const res = await plugin.onPanelInvoke("tbo-support.sign-out");
  assert.equal(res.signedIn, false);
  assert.equal(hub.calls.at(-1).path, "tbo_desktop.api.sign_out");
  assert.deepEqual(providerCalls.at(-1), ["clearCredential", "tbo-ai"]);
  assert.equal(sessions.has(HOST), false);
});

test("API key: a wrong key is never saved, a good one is saved and used", async () => {
  await signedOut();
  const wrong = await plugin.onPanelInvoke("tbo-support.sign-in", { key: "wrongkey1", secret: "wrongsecret1" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "AUTH");
  assert.equal(storeCalls.filter((c) => c[0] === "save").length, 0);

  const good = await plugin.onPanelInvoke("tbo-support.sign-in", { ...GOOD });
  assert.equal(good.ok, true);
  assert.equal(good.method, "key");
  assert.deepEqual(storeCalls.at(-1), ["save", HOST]);
  const me = await tool().execute({ action: "who_am_i" }, { log() {} });
  assert.equal(me.user, "agent@example.com");
  await signedOut();
  await assert.rejects(tool().execute({ action: "who_am_i" }, { log() {} }), { code: "NOT_SIGNED_IN" });
});

test("a local bench shows the key form; a site outside net.domains is refused", async () => {
  settings = { siteUrl: "http://tbo.localhost:8002" };
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).local, true);
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
  await plugin.onUnload();
});
