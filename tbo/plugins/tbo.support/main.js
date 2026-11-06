"use strict";

// TBO Support plugin: the read-only tbo_support tool, the TBO AI provider and
// the sign-in panel. People sign in with their Microsoft account through TBO
// Support (TBO Copilot Phase 17); TBO Support then gives this computer a TBO
// Support token and the person's TBO AI key, so nobody types a key. A local test
// site can still use an API key. See docs/tbo/tbo-support-plugin.md.

const os = require("node:os");
const { createClient, normalizeSite, isLoopback } = require("./lib/helpdesk");
const { TOOL, runAction } = require("./lib/actions");
const { createStore } = require("./lib/credentials");
const desktop = require("./lib/desktop");

const DEFAULT_SITE = "https://teams.teambackoffice.com";
const AI_PROVIDER = "tbo-ai";
const RENEW_BEFORE_MS = 60 * 60 * 1000; // renew the TBO Support token when under an hour is left
const CHECK_EVERY_MS = 15 * 60 * 1000;
const STARTUP_DELAY_MS = 2000;
const COMMANDS = {
  signIn: "tbo-support.sign-in",
  signOut: "tbo-support.sign-out",
  check: "tbo-support.check",
};

let store = null;
let timer = null;
let startupTimer = null;
let pending = null; // a Microsoft sign-in waiting for Allow in the browser
let aiApplied = null; // what the TBO AI provider row holds now (base URL and key)
let aiState = { ready: false };
let version = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function allowedHosts() {
  const manifest = pi.plugin.getManifest();
  return (manifest.net && manifest.net.domains) || [];
}

async function currentSite() {
  const settings = await pi.plugin.getSettings();
  return normalizeSite(settings.siteUrl || DEFAULT_SITE, allowedHosts());
}

function hostOf(site) {
  return new URL(site).hostname;
}

function request(input) {
  return pi.net.fetch(input);
}

async function appVersion() {
  if (version === null) version = await pi.app.getVersion().catch(() => "");
  return version;
}

async function clientFor(site, credentials) {
  return createClient({ siteUrl: site, credentials, request });
}

// --- TBO AI -------------------------------------------------------------------

async function applyAi(ai) {
  if (!ai || !ai.key || !ai.base_url) {
    return { ready: false, error: ai && ai.error ? ai.error : "" };
  }
  if (!aiApplied || aiApplied.baseUrl !== ai.base_url || aiApplied.key !== ai.key) {
    await pi.providers.setBaseUrl(AI_PROVIDER, ai.base_url);
    await pi.providers.setCredential(AI_PROVIDER, ai.key);
    aiApplied = { baseUrl: ai.base_url, key: ai.key };
  }
  return { ready: true, models: ai.models || [], limit: ai.monthly_limit };
}

async function clearAi() {
  aiApplied = null;
  aiState = { ready: false };
  await pi.providers.clearCredential(AI_PROVIDER).catch(() => {});
}

// --- the Microsoft sign-in's session -------------------------------------------

async function endLocally(site, reason) {
  await store.removeSession(hostOf(site)).catch(() => {});
  await clearAi();
  if (reason) await pi.ui.showToast(`Your TBO sign-in ended: ${reason}`, "error").catch(() => {});
}

// A TBO Support token with at least an hour left; renewed (and the AI key
// checked) when `force` or when it runs out sooner.
async function renew(site, session, { force = false } = {}) {
  if (!force && session.accessExpiresAt - Date.now() > RENEW_BEFORE_MS) return session;
  try {
    const fresh = await desktop.refresh({
      request,
      siteUrl: site,
      computerToken: session.computerToken,
      appVersion: await appVersion(),
    });
    await store.saveSession(hostOf(site), fresh);
    aiState = await applyAi(fresh.ai).catch((e) => ({ ready: false, error: e.message }));
    return fresh;
  } catch (e) {
    if (e.code === "SIGNED_OUT") await endLocally(site, e.message);
    throw e;
  }
}

async function signedInClient() {
  const site = await currentSite();
  const session = await store.loadSession(hostOf(site));
  if (session) {
    const fresh = await renew(site, session);
    return { site, session: fresh, client: await clientFor(site, { token: fresh.accessToken }) };
  }
  const credentials = await store.load(hostOf(site));
  return { site, session: null, client: await clientFor(site, credentials) };
}

async function startMicrosoft() {
  const site = await currentSite();
  if (pending) pending.cancelled = true;
  const started = await desktop.start({ request, siteUrl: site, os, appVersion: await appVersion() });
  const mine = {
    site,
    code: started.code,
    verifyUrl: started.verify_url,
    expiresAt: Date.now() + Number(started.expires_in || 600) * 1000,
    cancelled: false,
    error: "",
  };
  pending = mine;
  await pi.shell.openExternal(started.verify_url);
  desktop
    .poll({ request, siteUrl: site, started, sleep, isCancelled: () => mine.cancelled })
    .then(async (session) => {
      if (mine.cancelled) return;
      await store.saveSession(hostOf(site), session);
      await store.remove(hostOf(site)).catch(() => {}); // the Microsoft sign-in replaces an API key
      aiState = await applyAi(session.ai).catch((e) => ({ ready: false, error: e.message }));
      if (pending === mine) pending = null;
      const who = session.fullName || session.user;
      await pi.ui
        .showToast(aiState.ready ? `Signed in as ${who}. TBO AI is ready.` : `Signed in to TBO Support as ${who}.`)
        .catch(() => {});
    })
    .catch((e) => {
      if (!mine.cancelled) mine.error = e.message;
    });
  return pendingView(mine);
}

function pendingView(p) {
  return p ? { code: p.code, verifyUrl: p.verifyUrl, expiresAt: p.expiresAt, error: p.error } : null;
}

// --- the panel -----------------------------------------------------------------

async function panelState() {
  let site;
  try {
    site = await currentSite();
  } catch (e) {
    return { site: null, signedIn: false, error: e.message };
  }
  const local = isLoopback(hostOf(site));
  const waiting = pending && pending.site === site ? pendingView(pending) : null;
  if (pending && pending.error) pending = null; // shown once
  const session = await store.loadSession(hostOf(site));
  if (session) {
    try {
      const fresh = await renew(site, session);
      return { site, local, signedIn: true, method: "microsoft", user: fresh.user, fullName: fresh.fullName, ai: aiState };
    } catch (e) {
      if (e.code !== "SIGNED_OUT") {
        // offline: still signed in, TBO Support could not be reached
        return { site, local, signedIn: true, method: "microsoft", user: session.user, fullName: session.fullName, ai: aiState, error: e.message };
      }
      return { site, local, signedIn: false, pending: waiting, error: e.message };
    }
  }
  const credentials = await store.load(hostOf(site));
  if (!credentials) return { site, local, signedIn: false, pending: waiting };
  try {
    const me = await runAction(await clientFor(site, credentials), { action: "who_am_i" }, { siteUrl: site });
    return { site, local, signedIn: true, method: "key", user: me.user, ai: aiState };
  } catch (e) {
    return { site, local, signedIn: false, pending: waiting, error: e.message };
  }
}

async function signInWithKey(payload) {
  const site = await currentSite();
  const credentials = {
    key: String((payload && payload.key) || "").trim(),
    secret: String((payload && payload.secret) || "").trim(),
  };
  // Test the key before saving it, so a typo is never stored.
  const me = await runAction(await clientFor(site, credentials), { action: "who_am_i" }, { siteUrl: site });
  if (!me.user || me.user === "Guest") {
    const err = new Error("TBO Support did not accept the API key.");
    err.code = "AUTH";
    throw err;
  }
  await store.save(hostOf(site), credentials);
  return { site, local: isLoopback(hostOf(site)), signedIn: true, method: "key", user: me.user, ai: aiState };
}

async function signOut() {
  const site = await currentSite();
  if (pending) pending.cancelled = true;
  pending = null;
  const session = await store.loadSession(hostOf(site));
  if (session) await desktop.signOut({ request, siteUrl: site, computerToken: session.computerToken });
  await store.removeSession(hostOf(site)).catch(() => {});
  await store.remove(hostOf(site));
  await clearAi();
  return { site, local: isLoopback(hostOf(site)), signedIn: false };
}

async function onPanelInvoke(channel, payload) {
  try {
    if (channel === "tbo-support.state") return { ok: true, ...(await panelState()) };
    if (channel === "tbo-support.microsoft") return { ok: true, pending: await startMicrosoft() };
    if (channel === "tbo-support.open-again") {
      if (pending) await pi.shell.openExternal(pending.verifyUrl);
      return { ok: true, pending: pendingView(pending) };
    }
    if (channel === "tbo-support.cancel") {
      if (pending) pending.cancelled = true;
      pending = null;
      return { ok: true };
    }
    if (channel === "tbo-support.sign-in") return { ok: true, ...(await signInWithKey(payload)) };
    if (channel === "tbo-support.sign-out") return { ok: true, ...(await signOut()) };
  } catch (e) {
    return { ok: false, code: e.code || "ERROR", error: e.message };
  }
  return { ok: false, code: "UNSUPPORTED", error: `Unknown channel ${channel}` };
}

// --- lifecycle -----------------------------------------------------------------

// At start: renew the sign-in (and the AI key), or ask the person to sign in.
async function startup() {
  let site;
  try {
    site = await currentSite();
  } catch {
    return;
  }
  const session = await store.loadSession(hostOf(site));
  if (session) {
    await renew(site, session, { force: true }).catch(() => {});
    return;
  }
  const credentials = await store.load(hostOf(site));
  if (!credentials && !isLoopback(hostOf(site))) {
    await pi.ui.openPanel({ title: "TBO Support" }).catch(() => {});
  }
}

async function check() {
  try {
    const site = await currentSite();
    const session = await store.loadSession(hostOf(site));
    if (session) await renew(site, session);
  } catch {
    // tried again at the next check
  }
}

async function onLoad() {
  store = createStore({ dataDir: await pi.plugin.getDataPath() });

  await pi.agent.registerTool({
    ...TOOL,
    execute: async (args, ctx) => {
      const action = args && args.action;
      const ticket = args && args.ticket ? ` ticket ${args.ticket}` : "";
      if (ctx && ctx.log) ctx.log(`tbo_support ${action}${ticket}`);
      const { site, session, client } = await signedInClient();
      try {
        return await runAction(client, args, { siteUrl: site });
      } catch (e) {
        if (e.code !== "AUTH" || !session) throw e;
        // the token was refused early (revoked or the clock is off): renew once
        const fresh = await renew(site, session, { force: true });
        return runAction(await clientFor(site, { token: fresh.accessToken }), args, { siteUrl: site });
      }
    },
  });

  await pi.commands.register({
    id: COMMANDS.signIn,
    title: "TBO Support: Sign in",
    keywords: ["tbo", "helpdesk", "login", "microsoft", "sso", "api key"],
    run: () => pi.ui.openPanel({ title: "TBO Support" }),
  });

  await pi.commands.register({
    id: COMMANDS.signOut,
    title: "TBO Support: Sign out",
    keywords: ["tbo", "helpdesk", "logout"],
    run: async () => {
      try {
        await signOut();
        await pi.ui.showToast("Signed out of TBO Support and TBO AI.");
      } catch (e) {
        await pi.ui.showToast(e.message, "error");
      }
    },
  });

  await pi.commands.register({
    id: COMMANDS.check,
    title: "TBO Support: Check connection",
    keywords: ["tbo", "helpdesk", "status"],
    run: async () => {
      try {
        const state = await panelState();
        if (!state.signedIn) throw new Error(state.error || "Not signed in. Run 'TBO Support: Sign in'.");
        const ai = state.ai && state.ai.ready ? " TBO AI is ready." : state.method === "microsoft" ? " TBO AI is not ready yet." : "";
        await pi.ui.showToast(`Signed in to ${state.site} as ${state.fullName || state.user}.${ai}`);
      } catch (e) {
        await pi.ui.showToast(e.message, "error");
      }
    },
  });

  startupTimer = setTimeout(() => {
    startup().catch(() => {});
  }, STARTUP_DELAY_MS);
  timer = setInterval(() => {
    check().catch(() => {});
  }, CHECK_EVERY_MS);
  // the timers never keep the plugin process alive on their own
  if (startupTimer.unref) startupTimer.unref();
  if (timer.unref) timer.unref();
}

async function onUnload() {
  clearTimeout(startupTimer);
  clearInterval(timer);
  startupTimer = timer = null;
  if (pending) pending.cancelled = true;
  pending = null;
  await pi.agent.unregisterTool(TOOL.name).catch(() => {});
  for (const id of Object.values(COMMANDS)) {
    await pi.commands.unregister(id).catch(() => {});
  }
  store = null;
}

module.exports = { onLoad, onUnload, onPanelInvoke, AI_PROVIDER };
