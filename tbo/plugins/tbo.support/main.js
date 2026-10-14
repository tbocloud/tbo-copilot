"use strict";

// TBO Support plugin: gives the agent the read-only tbo_support tool and a
// sign-in panel. See docs/tbo-support-plugin.md.

const { createClient, normalizeSite } = require("./lib/helpdesk");
const { TOOL, runAction } = require("./lib/actions");
const { createStore } = require("./lib/credentials");

const DEFAULT_SITE = "https://teams.teambackoffice.com";
const COMMANDS = {
  signIn: "tbo-support.sign-in",
  signOut: "tbo-support.sign-out",
  check: "tbo-support.check",
};

let store = null;

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

async function clientFor(site, credentials) {
  return createClient({ siteUrl: site, credentials, request });
}

async function signedInClient() {
  const site = await currentSite();
  const credentials = await store.load(hostOf(site));
  return { site, client: await clientFor(site, credentials) };
}

async function whoAmI() {
  const { site, client } = await signedInClient();
  return runAction(client, { action: "who_am_i" }, { siteUrl: site });
}

// --- the sign-in panel ------------------------------------------------------

async function panelState() {
  let site;
  try {
    site = await currentSite();
  } catch (e) {
    return { site: null, signedIn: false, error: e.message };
  }
  const credentials = await store.load(hostOf(site));
  if (!credentials) return { site, signedIn: false };
  try {
    const me = await runAction(await clientFor(site, credentials), { action: "who_am_i" }, { siteUrl: site });
    return { site, signedIn: true, user: me.user };
  } catch (e) {
    return { site, signedIn: false, error: e.message };
  }
}

async function signIn(payload) {
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
  return { site, signedIn: true, user: me.user };
}

async function signOut() {
  const site = await currentSite();
  await store.remove(hostOf(site));
  return { site, signedIn: false };
}

async function onPanelInvoke(channel, payload) {
  try {
    if (channel === "tbo-support.state") return { ok: true, ...(await panelState()) };
    if (channel === "tbo-support.sign-in") return { ok: true, ...(await signIn(payload)) };
    if (channel === "tbo-support.sign-out") return { ok: true, ...(await signOut()) };
  } catch (e) {
    return { ok: false, code: e.code || "ERROR", error: e.message };
  }
  return { ok: false, code: "UNSUPPORTED", error: `Unknown channel ${channel}` };
}

// --- lifecycle --------------------------------------------------------------

async function onLoad() {
  store = createStore({ dataDir: await pi.plugin.getDataPath() });

  await pi.agent.registerTool({
    ...TOOL,
    execute: async (args, ctx) => {
      const action = args && args.action;
      const ticket = args && args.ticket ? ` ticket ${args.ticket}` : "";
      if (ctx && ctx.log) ctx.log(`tbo_support ${action}${ticket}`);
      const { site, client } = await signedInClient();
      return runAction(client, args, { siteUrl: site });
    },
  });

  await pi.commands.register({
    id: COMMANDS.signIn,
    title: "TBO Support: Sign in",
    keywords: ["tbo", "helpdesk", "login", "api key"],
    run: () => pi.ui.openPanel({ title: "TBO Support" }),
  });

  await pi.commands.register({
    id: COMMANDS.signOut,
    title: "TBO Support: Sign out",
    keywords: ["tbo", "helpdesk", "logout"],
    run: async () => {
      try {
        await signOut();
        await pi.ui.showToast("Signed out of TBO Support.");
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
        const me = await whoAmI();
        await pi.ui.showToast(`Signed in to ${me.site} as ${me.user}.`);
      } catch (e) {
        await pi.ui.showToast(e.message, "error");
      }
    },
  });
}

async function onUnload() {
  await pi.agent.unregisterTool(TOOL.name).catch(() => {});
  for (const id of Object.values(COMMANDS)) {
    await pi.commands.unregister(id).catch(() => {});
  }
  store = null;
}

module.exports = { onLoad, onUnload, onPanelInvoke };
