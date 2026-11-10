"use strict";

// Runs main.js against a fake TBO Copilot host and a fake TBO Support, with an
// in-memory store, so the sign-in flows and the tool wiring are tested without
// the app, the Keychain or a site.

const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../../tbo.support/manifest.json");

// The plugin's own startup sync runs 2 s after onLoad. These tests drive each
// step themselves (the sync is tested through the settings event below), so
// that one timer is held back instead of firing in the middle of a test.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => (ms === 2000 ? { unref() {} } : realSetTimeout(fn, ms, ...args));

const saved = new Map();
const sessions = new Map();
const storeCalls = [];
// Slow or failing store calls, for the tests of overlapping steps.
const storeHooks = { saveSessionDelayMs: 0, onSaveSession: null, removeSessionFailures: 0, loadSessionFailures: 0 };
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
    if (storeHooks.onSaveSession) storeHooks.onSaveSession();
    if (storeHooks.saveSessionDelayMs) await new Promise((r) => realSetTimeout(r, storeHooks.saveSessionDelayMs));
    sessions.set(host, JSON.parse(JSON.stringify({ ...session, ai: undefined })));
  },
  async loadSession(host) {
    if (storeHooks.loadSessionFailures > 0) {
      storeHooks.loadSessionFailures -= 1;
      throw Object.assign(new Error("Keychain locked"), { code: "SECRET_STORE" });
    }
    return sessions.get(host) || null;
  },
  async removeSession(host) {
    storeCalls.push(["removeSession", host]);
    if (storeHooks.removeSessionFailures > 0) {
      storeHooks.removeSessionFailures -= 1;
      throw Object.assign(new Error("Keychain refused"), { code: "SECRET_STORE" });
    }
    sessions.delete(host);
  },
});

const SITE = "https://teams.teambackoffice.com";
const HOST = "teams.teambackoffice.com";
const GOOD = { key: "abc123key", secret: "def456secret" };
const registered = { tools: [], commands: [] };
const opened = [];
const providerCalls = [];
const providerHooks = { setCredentialFailures: 0, setCredentialDelayMs: 0 };
const toasts = [];
const eventHandlers = new Map();
const shellHooks = { openFailures: 0 };
let settings = {};

// TBO Support, as far as the plugin sees it
const hub = {
  finishAnswers: [],
  refreshStatus: 200,
  refreshReason: "",
  refreshDelayMs: 0,
  onRefresh: null,
  startDelayMs: 0,
  signOutStatus: 200,
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
    if (hub.startDelayMs) await new Promise((r) => realSetTimeout(r, hub.startDelayMs));
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
    if (hub.onRefresh) await hub.onRefresh();
    if (hub.refreshDelayMs) await new Promise((r) => realSetTimeout(r, hub.refreshDelayMs));
    if (hub.refreshStatus !== 200) {
      return { status: hub.refreshStatus, headers: {}, bodyText: JSON.stringify({ message: { status: "signed_out", reason: hub.refreshReason } }) };
    }
    return ok({ access_token: newToken(), access_expires_in: 43200, expires_at: "2026-12-06 10:00:00", user: { email: "rahul@teambackoffice.com", full_name: "Rahul" }, ai: AI });
  }
  if (path === "tbo_desktop.api.sign_out") {
    if (hub.signOutStatus !== 200) return { status: hub.signOutStatus, headers: {}, bodyText: "{}" };
    return ok({ ok: true });
  }
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
    setCredential: async (id, key) => {
      if (providerHooks.setCredentialDelayMs) await new Promise((r) => realSetTimeout(r, providerHooks.setCredentialDelayMs));
      if (providerHooks.setCredentialFailures > 0) {
        providerHooks.setCredentialFailures -= 1;
        throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
      }
      providerCalls.push(["setCredential", id, key]);
    },
    clearCredential: async (id) => providerCalls.push(["clearCredential", id]),
  },
  shell: {
    openExternal: async (url) => {
      if (shellHooks.openFailures > 0) {
        shellHooks.openFailures -= 1;
        throw new Error("no browser");
      }
      opened.push(url);
    },
  },
  ui: { openPanel: async () => {}, showToast: async (m) => toasts.push(m) },
  net: { fetch: hubFetch },
  events: {
    on: (event, handler) => eventHandlers.set(event, handler),
    off: (event) => eventHandlers.delete(event),
  },
};
const settingsChanged = async () => {
  eventHandlers.get("plugin:settingsChanged")();
  // the handler starts the sync in the background: wait until it settles
  await new Promise((r) => realSetTimeout(r, 100));
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
  // the row is emptied before it gets a new address, so no step leaves a mixed pair
  assert.deepEqual(providerCalls, [
    ["clearCredential", "tbo-ai"],
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
  assert.equal(providerCalls.length, 3); // the same AI key: not stored again
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
  settings = { siteUrl: "https://demo-tbo.tbocloud.in" };
  const demo = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(demo.site, "https://demo-tbo.tbocloud.in");
  assert.equal(demo.local, false); // the demo hub signs in with Microsoft (or its own login), no key form
  settings = { siteUrl: "http://tbo.localhost:8002" };
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).local, true);
  settings = { siteUrl: "https://evil.example.com" };
  const state = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(state.signedIn, false);
  assert.match(state.error, /may only reach teams\.teambackoffice\.com/);
  settings = {};
});

// --- overlapping steps (CodeRabbit review of PR #23) ---------------------------

const pause = (ms) => new Promise((r) => realSetTimeout(r, ms));

async function signInMicrosoft() {
  hub.finishAnswers = ["approved"];
  const res = await plugin.onPanelInvoke("tbo-support.microsoft");
  assert.equal(res.ok, true, res.error);
  await waitFor(async () => {
    const s = await plugin.onPanelInvoke("tbo-support.state");
    return s.signedIn && !(s.ai && s.ai.configuring);
  });
}

test("each site keeps its own sign-in, by scheme, host and port", async () => {
  assert.equal(plugin.keyOf("https://teams.teambackoffice.com"), "teams.teambackoffice.com");
  assert.equal(plugin.keyOf("http://tbo.localhost:8002"), "http_tbo.localhost_8002");
  assert.equal(plugin.keyOf("https://example.test:8443"), "https_example.test_8443");
  settings = { siteUrl: "http://tbo.localhost:8002" };
  assert.equal((await plugin.onPanelInvoke("tbo-support.sign-in", { ...GOOD })).ok, true);
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).signedIn, true);
  settings = { siteUrl: "http://tbo.localhost:8003" }; // another bench on the same host
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).signedIn, false);
  settings = { siteUrl: "http://tbo.localhost:8002" };
  await signedOut();
  settings = {};
});

test("a renewal that finishes after sign-out keeps nothing", async () => {
  await signInMicrosoft();
  sessions.get(HOST).accessExpiresAt = Date.now() + 10 * 60 * 1000; // due for renewal
  hub.refreshDelayMs = 300;
  const call = tool().execute({ action: "who_am_i" }, { log() {} });
  await pause(50);
  assert.equal((await plugin.onPanelInvoke("tbo-support.sign-out")).ok, true);
  const afterSignOut = providerCalls.length;
  try {
    await assert.rejects(call, { code: "STALE" });
  } finally {
    hub.refreshDelayMs = 0;
  }
  assert.equal(sessions.has(HOST), false);
  assert.deepEqual(providerCalls.slice(afterSignOut), []); // no AI key put back
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).signedIn, false);
});

test("a passing TBO Support failure keeps using the saved token", async () => {
  await signInMicrosoft();
  sessions.get(HOST).accessExpiresAt = Date.now() + 10 * 60 * 1000; // due, but still valid
  hub.refreshStatus = 502;
  const me = await tool().execute({ action: "who_am_i" }, { log() {} });
  hub.refreshStatus = 200;
  assert.equal(me.user, "rahul@teambackoffice.com");
  assert.equal(sessions.has(HOST), true);
});

test("a TBO AI set-up the app refused is tried again without waiting for the token", async () => {
  await signedOut();
  providerHooks.setCredentialFailures = 1;
  await signInMicrosoft();
  const first = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(first.ai.ready, false);
  assert.match(first.ai.error, /host unavailable/);
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000; // the retry is due; the 12-hour token is not
  try {
    const later = await plugin.onPanelInvoke("tbo-support.state");
    assert.equal(later.ai.ready, true);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(providerCalls.at(-1), ["setCredential", "tbo-ai", "sk-person-1"]);
});

test("changing the site clears TBO AI; changing back sets it up again", async () => {
  providerCalls.length = 0;
  settings = { siteUrl: "https://demo-tbo.tbocloud.in" };
  await settingsChanged();
  assert.ok(providerCalls.length > 0);
  assert.ok(providerCalls.every((c) => c[0] === "clearCredential"), JSON.stringify(providerCalls));
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).signedIn, false);
  settings = {};
  await settingsChanged();
  assert.deepEqual(providerCalls.slice(-3), [
    ["clearCredential", "tbo-ai"],
    ["setBaseUrl", "tbo-ai", "https://ai.example.test/v1"],
    ["setCredential", "tbo-ai", "sk-person-1"],
  ]);
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).ai.ready, true);
});

test("a renewal for the old site that finishes after the site changed puts no key back", async () => {
  sessions.get(HOST).accessExpiresAt = Date.now() + 10 * 60 * 1000; // due for renewal
  hub.refreshDelayMs = 300;
  const call = tool().execute({ action: "who_am_i" }, { log() {} });
  await pause(50);
  settings = { siteUrl: "https://demo-tbo.tbocloud.in" };
  const atChange = providerCalls.length;
  try {
    await settingsChanged();
    await assert.rejects(call, { code: "STALE" });
  } finally {
    hub.refreshDelayMs = 0;
  }
  assert.ok(!providerCalls.slice(atChange).some((c) => c[0] !== "clearCredential"), JSON.stringify(providerCalls.slice(atChange)));
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).signedIn, false); // the demo hub: no sign-in
  settings = {};
  await settingsChanged();
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).ai.ready, true);
});

test("at start a key from an earlier run is cleared; a failed renewal is tried again soon", async () => {
  providerCalls.length = 0;
  hub.refreshStatus = 502;
  try {
    await plugin.startup();
  } finally {
    hub.refreshStatus = 200;
  }
  assert.deepEqual(providerCalls, [["clearCredential", "tbo-ai"]]); // nothing kept from before
  assert.equal(sessions.has(HOST), true); // a passing failure does not sign out
  // the next panel read fetches the key again, without waiting for the 12-hour token
  const state = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(state.ai.ready, true);
  assert.deepEqual(providerCalls.at(-1), ["setCredential", "tbo-ai", "sk-person-1"]);
});

test("a check that cannot read the kept sign-in leaves the TBO AI key alone", async () => {
  const before = providerCalls.length;
  storeHooks.loadSessionFailures = 1;
  await plugin.check();
  assert.equal(storeHooks.loadSessionFailures, 0); // the failure did happen
  assert.deepEqual(providerCalls.slice(before), []);
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).ai.ready, true);
});

test("an API-key sign-in during a slow Microsoft start ends that attempt before a browser opens", async () => {
  await signedOut();
  hub.startDelayMs = 300;
  const openedBefore = opened.length;
  const microsoft = plugin.onPanelInvoke("tbo-support.microsoft");
  await pause(50);
  const key = await plugin.onPanelInvoke("tbo-support.sign-in", { ...GOOD });
  const started = await microsoft;
  hub.startDelayMs = 0;
  assert.equal(key.ok, true);
  assert.equal(started.ok, false);
  assert.equal(started.code, "STALE");
  assert.equal(opened.length, openedBefore); // no browser for the overtaken attempt
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).method, "key");
  await signedOut();
});

test("sign-out says so when TBO Support could not be reached", async () => {
  await signInMicrosoft();
  hub.signOutStatus = 503;
  const res = await plugin.onPanelInvoke("tbo-support.sign-out");
  hub.signOutStatus = 200;
  assert.equal(res.ok, true);
  assert.equal(res.signedIn, false);
  assert.match(res.error, /could not be reached/);
  assert.equal(sessions.has(HOST), false);
  assert.deepEqual(providerCalls.at(-1), ["clearCredential", "tbo-ai"]);
  await signInMicrosoft(); // signed in again for the tests below
});

test("sign-out still cleans up when the saved sign-in cannot be read, and says TBO Support was not told", async () => {
  const signOutsBefore = hub.calls.filter((c) => c.path === "tbo_desktop.api.sign_out").length;
  storeHooks.loadSessionFailures = 1;
  const res = await plugin.onPanelInvoke("tbo-support.sign-out");
  assert.equal(res.ok, true);
  assert.equal(res.signedIn, false);
  assert.match(res.error, /could not be read/);
  assert.equal(sessions.has(HOST), false);
  assert.deepEqual(providerCalls.at(-1), ["clearCredential", "tbo-ai"]);
  assert.equal(hub.calls.filter((c) => c.path === "tbo_desktop.api.sign_out").length, signOutsBefore);
  await signInMicrosoft(); // signed in again for the tests below
});

test("the TBO AI gateway is never accepted as the TBO Support address", async () => {
  settings = { siteUrl: "https://copilot-gateway.tbocloud.in" };
  const state = await plugin.onPanelInvoke("tbo-support.state");
  assert.equal(state.signedIn, false);
  assert.match(state.error, /may only reach/);
  settings = {};
});

test("an API-key sign-in is refused while signed in with Microsoft", async () => {
  const res = await plugin.onPanelInvoke("tbo-support.sign-in", { ...GOOD });
  assert.equal(res.ok, false);
  assert.equal(res.code, "SIGNED_IN");
  assert.equal(saved.has(HOST), false);
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).method, "microsoft");
});

test("Check connection asks TBO Support who is signed in, and reports a refusal", async () => {
  const check = registered.commands.find((c) => c.id === "tbo-support.check");
  const before = hub.calls.length;
  await check.run();
  assert.ok(hub.calls.slice(before).some((c) => c.path === "frappe.auth.get_logged_user"));
  assert.match(toasts.at(-1), /^Signed in to /);
  hub.tokens.clear(); // revoked on the site
  hub.refreshStatus = 401;
  hub.refreshReason = "The sign-in was ended in TBO Support.";
  await check.run();
  hub.refreshStatus = 200;
  assert.match(toasts.at(-1), /ended in TBO Support/);
  assert.equal(sessions.has(HOST), false);
});

test("sign-out says so when this computer cannot delete the sign-in, and the AI key still goes", async () => {
  await signInMicrosoft();
  storeHooks.removeSessionFailures = 2;
  const res = await plugin.onPanelInvoke("tbo-support.sign-out");
  assert.equal(res.ok, false);
  assert.equal(res.code, "SECRET_STORE");
  assert.deepEqual(providerCalls.at(-1), ["clearCredential", "tbo-ai"]);
  const again = await plugin.onPanelInvoke("tbo-support.sign-out");
  assert.equal(again.ok, true);
  assert.equal(sessions.has(HOST), false);
});

test("the browser not opening ends the attempt, so Sign in works again", async () => {
  shellHooks.openFailures = 1;
  const failed = await plugin.onPanelInvoke("tbo-support.microsoft");
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "BROWSER");
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).pending, null);
  hub.finishAnswers = ["pending", "pending"];
  const retried = await plugin.onPanelInvoke("tbo-support.microsoft");
  assert.equal(retried.ok, true);
  await plugin.onPanelInvoke("tbo-support.cancel");
});

test("cancelling while the sign-in is being kept keeps nothing", async () => {
  providerCalls.length = 0;
  hub.finishAnswers = ["approved"];
  storeHooks.saveSessionDelayMs = 200;
  storeHooks.onSaveSession = () => {
    plugin.onPanelInvoke("tbo-support.cancel"); // marks the attempt cancelled at once
  };
  await plugin.onPanelInvoke("tbo-support.microsoft");
  await waitFor(() => storeCalls.at(-1) && storeCalls.at(-1)[0] === "removeSession");
  storeHooks.saveSessionDelayMs = 0;
  storeHooks.onSaveSession = null;
  assert.equal(sessions.has(HOST), false);
  assert.ok(!providerCalls.some((c) => c[0] === "setCredential"));
  assert.equal((await plugin.onPanelInvoke("tbo-support.state")).signedIn, false);
});

test("the panel never sees a sign-in whose TBO AI is still being set up as finished", async () => {
  providerHooks.setCredentialDelayMs = 400;
  hub.finishAnswers = ["approved"];
  await plugin.onPanelInvoke("tbo-support.microsoft");
  const seen = [];
  await waitFor(async () => {
    const s = await plugin.onPanelInvoke("tbo-support.state");
    seen.push(s);
    return s.signedIn && s.ai && s.ai.ready;
  });
  providerHooks.setCredentialDelayMs = 0;
  // signed in is shown either with TBO AI ready, or (in the panel) while it is
  // being set up, which keeps the panel polling; never as "not set up"
  const halfDone = seen.filter((s) => s.signedIn && !s.ai.ready && !s.ai.configuring);
  assert.deepEqual(halfDone, []);
  await signedOut();
});

test("unknown panel channels are refused", async () => {
  const res = await plugin.onPanelInvoke("tbo-support.delete-everything");
  assert.equal(res.ok, false);
  assert.equal(res.code, "UNSUPPORTED");
  await plugin.onUnload();
  assert.equal(eventHandlers.has("plugin:settingsChanged"), false);
});
