"use strict";

// TBO Support plugin: the tbo_support tool (reading TBO Support and TBO's Press),
// the tbo_support_change tool (a Press backup or action, asked of the person first), the
// tbo_aws tool (TBO's AWS with the person's own AWS login, Phase 18; lib/aws.js),
// the TBO AI provider and the sign-in panel. People sign in with their Microsoft
// account through TBO Support (TBO Copilot Phase 17); TBO Support then gives this
// computer a TBO Support token and the person's TBO AI key, so nobody types a
// key. A local test site can still use an API key. See
// docs/tbo/tbo-support-plugin.md and docs/tbo/aws.md.
//
// Three rules keep the sign-in consistent when things overlap:
// - every sign-out (and an API-key sign-in) moves `epoch` on, and a renewal or a
//   Microsoft sign-in that started before it drops its answer;
// - writes to the stored sign-in and to the TBO AI row run one at a time
//   (`exclusive`), so a sign-out can never be overtaken by a save;
// - the TBO AI row holds the key of one site's sign-in (`aiApplied.site`): it is
//   cleared when the site changes or that sign-in ends.

const os = require("node:os");
const { createClient, normalizeSite, isLoopback } = require("./lib/helpdesk");
const { TOOL, CHANGE_TOOL, runAction, allTasks } = require("./lib/actions");
const { createStore } = require("./lib/credentials");
const desktop = require("./lib/desktop");
const { AWS_TOOL, createAws } = require("./lib/aws");
const projects = require("./lib/projects");

const DEFAULT_SITE = "https://teams.teambackoffice.com";
const AI_PROVIDER = "tbo-ai";
const RENEW_BEFORE_MS = 60 * 60 * 1000; // renew the TBO Support token when under an hour is left
const CHECK_EVERY_MS = 15 * 60 * 1000;
const AI_RETRY_MS = 5 * 60 * 1000; // a TBO AI set-up the app refused is tried again this soon
const STARTUP_DELAY_MS = 2000;
// Answers that say TBO Support could not be reached or had a passing problem;
// the saved token stays usable until it runs out.
const TRANSIENT = new Set(["NETWORK", "RATE_LIMITED", "HELPDESK_ERROR"]);
const SETTINGS_EVENT = "plugin:settingsChanged";
// a tbo-copilot:// link the app was opened with (Phase 22): only ever asks the person first
const OPEN_URL_EVENT = "app:openUrl";
const COMMANDS = {
  signIn: "tbo-support.sign-in",
  signOut: "tbo-support.sign-out",
  check: "tbo-support.check",
  report: "tbo-support.report-problem",
  projects: "tbo-support.projects",
};

let store = null;
let projectStore = null; // each TBO Support project's folders and each task's chat, on this computer
let openRequest = null; // a task link waiting for the person's Open in the panel: { task, site }
let neededProject = null; // the project an opened task needs folders for: { site, project, name } (Phase 23)
let aws = null;
// "TBO Support: Report a problem" opens the panel on its report form (read once by the panel)
let reportAsked = false;
// "TBO Support: Projects and tasks" opens the panel on its Projects view (read once by the panel)
let projectsAsked = false;
// the last report sent from the panel: its link opens only from here, never from the panel's input
let lastReport = null;
let timer = null;
let startupTimer = null;
let pending = null; // a Microsoft sign-in waiting for Allow in the browser
let aiApplied = null; // what the TBO AI provider row holds now: { site, baseUrl, key }
let aiState = { ready: false };
let aiRetryAt = 0; // when to fetch the TBO AI key again after the app refused it (0: not needed)
let epoch = 0;
let knownSettings = null; // { site, aws } as last seen: a settings change acts on what moved
// why TBO Support ended this computer's sign-in: { site, reason }, shown until the next sign-in (Phase 23)
let endedSignIn = null;
let chain = Promise.resolve();
let version = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The answer of a step that a sign-out, another sign-in or a site change overtook.
function stale() {
  return fail("STALE", "Your TBO Support sign-in changed while this was running. Try again.");
}

// Runs `fn` after every earlier exclusive call has finished.
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// Hosts in net.domains only because TBO AI's endpoint lives there (the app
// checks the address TBO Support hands over against net.domains). They are
// never a TBO Support address: no sign-in token goes to them.
const AI_ONLY_HOSTS = new Set(["copilot-gateway.tbocloud.in"]);

function siteHosts() {
  const manifest = pi.plugin.getManifest();
  return ((manifest.net && manifest.net.domains) || []).filter((host) => !AI_ONLY_HOSTS.has(host));
}

async function currentSite() {
  const settings = await pi.plugin.getSettings();
  return normalizeSite(settings.siteUrl || DEFAULT_SITE, siteHosts());
}

function hostOf(site) {
  return new URL(site).hostname;
}

// Where a site's sign-in is kept. A normal https site keeps its host name (as
// before); any other origin adds its scheme and port, so two local benches on
// one host never share a sign-in. A sign-in kept by host name alone for such a
// bench is not read again: the person signs in once more.
function keyOf(site) {
  const url = new URL(site);
  const scheme = url.protocol.replace(":", "");
  if (scheme === "https" && !url.port) return url.hostname;
  return `${scheme}_${url.hostname}_${url.port || (scheme === "https" ? "443" : "80")}`;
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

// Points the TBO AI row at this sign-in's address and key. A new address never
// sees the old key: the row is emptied first, so a failure half way leaves no
// key rather than a mixed pair.
async function applyAi(site, ai) {
  if (!ai || !ai.key || !ai.base_url) {
    if (aiApplied && aiApplied.site !== site) await clearAi();
    return { ready: false, error: ai && ai.error ? ai.error : "" };
  }
  const same = aiApplied && aiApplied.site === site && aiApplied.baseUrl === ai.base_url && aiApplied.key === ai.key;
  if (!same) {
    const moved = !aiApplied || aiApplied.site !== site || aiApplied.baseUrl !== ai.base_url;
    aiApplied = null;
    try {
      if (moved) {
        await pi.providers.clearCredential(AI_PROVIDER);
        await pi.providers.setBaseUrl(AI_PROVIDER, ai.base_url);
      }
      await pi.providers.setCredential(AI_PROVIDER, ai.key);
    } catch (e) {
      await pi.providers.clearCredential(AI_PROVIDER).catch(() => {});
      throw e;
    }
    aiApplied = { site, baseUrl: ai.base_url, key: ai.key };
  }
  return { ready: true, models: ai.models || [], limit: ai.monthly_limit };
}

// applyAi for a sign-in that is already kept: a refusal by the app is shown and
// tried again later, without waiting for the next token renewal.
async function setUpAi(site, ai) {
  try {
    const state = await applyAi(site, ai);
    aiRetryAt = 0;
    return state;
  } catch (e) {
    aiRetryAt = Date.now() + AI_RETRY_MS;
    return { ready: false, error: e.message };
  }
}

// Best effort: true when the app cleared the row's key.
async function clearAi() {
  aiApplied = null;
  aiState = { ready: false };
  aiRetryAt = 0;
  return pi.providers.clearCredential(AI_PROVIDER).then(
    () => true,
    () => false,
  );
}

// The TBO AI row belongs to the current site's sign-in only.
function reconcileAi(site) {
  return exclusive(async () => {
    if (aiApplied && aiApplied.site !== site) await clearAi();
  });
}

// No Microsoft sign-in kept for `site`: no TBO AI key either. Decided in turn
// with the saves, so a sign-in kept a moment ago is never undone. `always`
// also clears a key the app kept from an earlier run (at start, aiApplied is
// not known yet).
function clearAiUnlessSignedIn(site, { always = false } = {}) {
  return exclusive(async () => {
    if (await store.loadSession(keyOf(site))) return;
    if (aiApplied || always) await clearAi();
  });
}

// --- the Microsoft sign-in's session -------------------------------------------

// TBO Support ended the sign-in that `computerToken` belongs to. A newer sign-in
// kept in the meantime is left alone.
async function endLocally(site, computerToken, reason) {
  const ended = await exclusive(async () => {
    const key = keyOf(site);
    const kept = await store.loadSession(key);
    if (kept && kept.computerToken !== computerToken) return false;
    await clearAi();
    await store.removeSession(key).catch(() => {});
    return true;
  });
  if (ended && reason) {
    endedSignIn = { site, reason: `Your TBO sign-in ended: ${reason}` };
    await pi.ui.showToast(endedSignIn.reason, "error").catch(() => {});
  }
}

// The reason the last sign-in on `site` ended, for the panel ({} when there is none).
function endedReason(site) {
  return endedSignIn && endedSignIn.site === site ? { error: endedSignIn.reason } : {};
}

// A TBO Support token with at least an hour left; renewed (and the AI key
// fetched) when `force`, when it runs out sooner, or when the AI set-up is due
// again.
async function renew(site, session, { force = false } = {}) {
  const expiring = session.accessExpiresAt - Date.now() <= RENEW_BEFORE_MS;
  const aiDue = aiRetryAt > 0 && Date.now() >= aiRetryAt;
  if (!force && !expiring && !aiDue) return session;
  const gen = epoch;
  let fresh;
  try {
    fresh = await desktop.refresh({
      request,
      siteUrl: site,
      computerToken: session.computerToken,
      appVersion: await appVersion(),
    });
  } catch (e) {
    if (gen !== epoch) throw stale();
    if (e.code === "SIGNED_OUT") {
      await endLocally(site, session.computerToken, e.message);
      throw e;
    }
    if (aiDue) aiRetryAt = Date.now() + AI_RETRY_MS; // not on every call while TBO Support is down
    // no TBO AI key in the row yet: the panel says TBO Support could not be reached, not "not set up"
    if (!aiApplied && TRANSIENT.has(e.code)) aiState = { ready: false, error: e.message };
    // TBO Support could not answer: the saved token still works until it runs out
    if (!force && TRANSIENT.has(e.code) && session.accessExpiresAt > Date.now()) return session;
    throw e;
  }
  return exclusive(async () => {
    // a sign-out, another sign-in or a site change came first: this answer is stale
    if (gen !== epoch) throw stale();
    await store.saveSession(keyOf(site), fresh);
    aiState = await setUpAi(site, fresh.ai);
    return fresh;
  });
}

async function signedInClient() {
  const site = await currentSite();
  await reconcileAi(site);
  const session = await store.loadSession(keyOf(site));
  if (session) {
    const fresh = await renew(site, session);
    return { site, session: fresh, client: await clientFor(site, { token: fresh.accessToken }) };
  }
  const credentials = await store.load(keyOf(site));
  return { site, session: null, client: await clientFor(site, credentials) };
}

// One tool action with the current sign-in; a token refused early (revoked, or
// the clock is off) is renewed once and the action tried again.
async function runSignedIn(args, tool = TOOL) {
  const { site, session, client } = await signedInClient();
  try {
    return await runAction(client, args, { siteUrl: site }, tool);
  } catch (e) {
    // a 401 is refused before anything runs, so trying once more never repeats a change
    if (e.code !== "AUTH" || !session) throw e;
    const fresh = await renew(site, session, { force: true });
    return runAction(await clientFor(site, { token: fresh.accessToken }), args, { siteUrl: site }, tool);
  }
}

async function startMicrosoft() {
  const gen = epoch; // before the first wait: a sign-out or API-key sign-in meanwhile ends this attempt
  const site = await currentSite();
  endedSignIn = null; // a new attempt: the last one's end is history
  if (pending) pending.cancelled = true;
  pending = null;
  const started = await desktop.start({ request, siteUrl: site, os, appVersion: await appVersion() });
  if (gen !== epoch) throw stale(); // never open a browser for an attempt that was overtaken
  const mine = {
    site,
    code: started.code,
    verifyUrl: started.verify_url,
    expiresAt: Date.now() + Number(started.expires_in || 600) * 1000,
    cancelled: false,
    error: "",
    reason: "", // TBO Support's reason why the person cannot allow it yet (the Allow page's)
    problem: "", // the last check that failed for a moment; checking goes on until the code expires
  };
  pending = mine;
  try {
    await pi.shell.openExternal(started.verify_url);
  } catch (e) {
    // nobody waits for an Allow that cannot be pressed: start again from the panel
    mine.cancelled = true;
    if (pending === mine) pending = null;
    throw fail("BROWSER", `Could not open your browser (${e && e.message ? e.message : e}). Try again.`);
  }
  const over = () => mine.cancelled || gen !== epoch;
  desktop
    .poll({
      request,
      siteUrl: site,
      started,
      sleep,
      isCancelled: over,
      onWaiting: ({ reason, problem }) => {
        if (over()) return;
        mine.reason = reason || "";
        mine.problem = problem || "";
      },
    })
    .then((session) =>
      exclusive(async () => {
        if (over()) return;
        const key = keyOf(site);
        aiState = { ready: false, configuring: true };
        await store.saveSession(key, session);
        if (over()) {
          // cancelled while it was being kept: nothing else writes in the
          // meantime, so the session in the store is this attempt's own
          await store.removeSession(key).catch(() => {});
          aiState = { ready: false };
          return;
        }
        await store.remove(key).catch(() => {}); // the Microsoft sign-in replaces an API key
        aiState = await setUpAi(site, session.ai);
        if (pending === mine) pending = null;
        const who = session.fullName || session.user;
        await pi.ui
          .showToast(aiState.ready ? `Signed in as ${who}. TBO AI is ready.` : `Signed in to TBO Support as ${who}.`)
          .catch(() => {});
      }),
    )
    .catch((e) => {
      if (aiState.configuring) aiState = { ready: false };
      if (!over()) mine.error = e.message;
    });
  return pendingView(mine);
}

function pendingView(p) {
  return p
    ? { code: p.code, verifyUrl: p.verifyUrl, expiresAt: p.expiresAt, error: p.error, reason: p.reason || "", problem: p.problem || "" }
    : null;
}

// --- the panel -----------------------------------------------------------------

async function panelState(retried = false) {
  let site;
  try {
    site = await currentSite();
  } catch (e) {
    return { site: null, signedIn: false, error: e.message };
  }
  await reconcileAi(site);
  const local = isLoopback(hostOf(site));
  // a failed attempt keeps its reason until the next sign-in starts, is cancelled or signs out,
  // so the panel still says why after the person comes back to it
  const waiting = pending && pending.site === site ? pendingView(pending) : null;
  const session = await store.loadSession(keyOf(site));
  if (session) {
    try {
      const fresh = await renew(site, session);
      return { site, local, signedIn: true, method: "microsoft", user: fresh.user, fullName: fresh.fullName, ai: aiState };
    } catch (e) {
      if (e.code === "STALE" && !retried) return panelState(true); // read what holds now
      if (e.code !== "SIGNED_OUT") {
        // offline: still signed in, TBO Support could not be reached
        return { site, local, signedIn: true, method: "microsoft", user: session.user, fullName: session.fullName, ai: aiState, error: e.message };
      }
      return { site, local, signedIn: false, pending: waiting, error: e.message };
    }
  }
  await clearAiUnlessSignedIn(site);
  const credentials = await store.load(keyOf(site));
  if (!credentials) return { site, local, signedIn: false, pending: waiting, ...endedReason(site) };
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
  const microsoft = () =>
    fail("SIGNED_IN", "You are signed in with Microsoft on this site. Sign out first to use an API key.");
  if (await store.loadSession(keyOf(site))) throw microsoft();
  // One sign-in at a time: a Microsoft sign-in still waiting stops here.
  epoch += 1;
  if (pending) pending.cancelled = true;
  pending = null;
  // Test the key before saving it, so a typo is never stored.
  const me = await runAction(await clientFor(site, credentials), { action: "who_am_i" }, { siteUrl: site });
  if (!me.user || me.user === "Guest") throw fail("AUTH", "TBO Support did not accept the API key.");
  return exclusive(async () => {
    // a Microsoft sign-in kept just before the line above wins
    if (await store.loadSession(keyOf(site))) throw microsoft();
    await store.save(keyOf(site), credentials);
    return { site, local: isLoopback(hostOf(site)), signedIn: true, method: "key", user: me.user, ai: aiState };
  });
}

// Deletes a stored item, once more if the first try fails.
async function removeStored(remove) {
  try {
    await remove();
  } catch {
    await remove();
  }
}

async function signOut() {
  const site = await currentSite();
  epoch += 1; // a renewal or sign-in still running drops its answer
  if (pending) pending.cancelled = true;
  pending = null;
  return exclusive(async () => {
    const key = keyOf(site);
    // A sign-in this computer cannot read is still cleaned up below; only
    // TBO Support cannot be told, since its token was in that sign-in.
    let readFailed = false;
    const session = await store.loadSession(key).catch(() => {
      readFailed = true;
      return null;
    });
    const reached = session
      ? await desktop.signOut({ request, siteUrl: site, computerToken: session.computerToken })
      : true;
    const aiCleared = await clearAi(); // the TBO AI key goes first, whatever happens below
    try {
      await removeStored(() => store.removeSession(key));
      await removeStored(() => store.remove(key));
    } catch {
      throw fail(
        "SECRET_STORE",
        readFailed
          ? "This computer could not read or delete the saved sign-in, so TBO Support was not told. Choose Sign out again."
          : "Signed out of TBO Support, but this computer could not delete the saved sign-in. Choose Sign out again.",
      );
    }
    const done = { site, local: isLoopback(hostOf(site)), signedIn: false };
    // TBO Support ends the sign-in (and removes the TBO AI key on the gateway)
    // only when it hears of it: say so when it could not be told
    if (readFailed) done.error = NOT_READ_ON_SIGN_OUT;
    else if (!reached) done.error = NOT_REACHED_ON_SIGN_OUT;
    if (!aiCleared) done.error = [done.error, AI_NOT_CLEARED_ON_SIGN_OUT].filter(Boolean).join(" ");
    return done;
  });
}

const NOT_READ_ON_SIGN_OUT =
  "Signed out on this computer, but its saved sign-in could not be read, so TBO Support was not told. A System " +
  "Manager can end this computer's sign-in there now (TBO Desktop Sign-in); otherwise it ends when it runs out.";

// The command needs no saved sign-in, and start clears the row too.
const AI_NOT_CLEARED_ON_SIGN_OUT =
  "This computer could not clear the TBO AI key. Run TBO Support: Sign out again, or restart TBO Copilot.";

const NOT_REACHED_ON_SIGN_OUT =
  "Signed out on this computer, but TBO Support could not be reached. A System Manager can end this " +
  "computer's sign-in there now (TBO Desktop Sign-in); otherwise it ends when it runs out.";

// The person typed the report and pressed Send in the panel: that is their yes, so it goes
// straight to TBO Support (the agent's report_problem goes through the app's prompt instead).
async function reportFromPanel(payload) {
  const text = payload && typeof payload.text === "string" ? payload.text : "";
  const filed = await runSignedIn({ action: "report_problem", text }, CHANGE_TOOL);
  const site = await currentSite();
  // the task's page opens only on the signed-in site
  lastReport = filed.url && sameOrigin(filed.url, site) ? filed : { ...filed, url: null };
  return { task: filed.task, link: !!lastReport.url };
}

function sameOrigin(url, site) {
  try {
    return new URL(url).origin === new URL(site).origin;
  } catch {
    return false;
  }
}

// --- projects and tasks (Phase 22) ----------------------------------------------

// A TBO Support call as the signed-in person; a token refused early is renewed once.
async function withClient(fn) {
  const { site, session, client } = await signedInClient();
  try {
    return await fn(client, site);
  } catch (e) {
    if (e.code !== "AUTH" || !session) throw e;
    const fresh = await renew(site, session, { force: true });
    return fn(await clientFor(site, { token: fresh.accessToken }), site);
  }
}

const plainText = (value, max) =>
  String(value == null ? "" : value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// The panel's Projects view: the person's open projects, their open tasks in each, and the
// folders kept for each here. The panel shows text only (never HTML).
async function projectsView() {
  return withClient(async (client, site) => {
    const [projectList, tasks] = await Promise.all([
      allProjects(client), // every page of the person's open projects (Phase 23)
      allTasks(client), // every page of My Work
    ]);
    const projectRows = projectList.rows;
    const kept = projectStore.projects(site);
    const rows = projectRows.map((p) => ({
      project: p.name,
      name: plainText(p.project_name || p.name, 140),
      customer: plainText(p.customer, 140) || null,
      role: plainText(p.my_role, 60) || null,
      folders: ((kept[p.name] && kept[p.name].folders) || []).map((f) => ({ path: f, here: projects.isFolder(f) })),
      tasks: tasks
        .filter((t) => t.project === p.name)
        .map((t) => ({
          task: t.name,
          subject: plainText(t.subject, 200),
          status: t.status,
          deadline: t.exp_end_date || null,
          overdue: Boolean(t.is_overdue),
          chat: Boolean(projectStore.chat(site, t.name)),
        })),
    }));
    // projects of tasks that the open-projects list does not hold (e.g. as a helper)
    for (const t of tasks) {
      if (t.project && !rows.some((r) => r.project === t.project)) {
        rows.push({
          project: t.project,
          name: plainText(t.project_name || t.project, 140),
          customer: plainText(t.customer, 140) || null,
          role: null,
          folders: ((kept[t.project] && kept[t.project].folders) || []).map((f) => ({ path: f, here: projects.isFolder(f) })),
          tasks: [],
        });
      }
      const row = rows.find((r) => r.project === t.project);
      if (row && !row.tasks.some((x) => x.task === t.name)) {
        row.tasks.push({
          task: t.name,
          subject: plainText(t.subject, 200),
          status: t.status,
          deadline: t.exp_end_date || null,
          overdue: Boolean(t.is_overdue),
          chat: Boolean(projectStore.chat(site, t.name)),
        });
      }
    }
    // the project a task the person opened needs folders for, though it is not in their lists (a
    // task link for a project they only help on): its own card, first, so the folders can be added
    const needed = neededProject && neededProject.site === site ? neededProject : null;
    if (needed && !rows.some((r) => r.project === needed.project)) {
      rows.push({
        project: needed.project,
        name: plainText(needed.name || needed.project, 140),
        customer: null,
        role: null,
        folders: ((kept[needed.project] && kept[needed.project].folders) || []).map((f) => ({ path: f, here: projects.isFolder(f) })),
        tasks: [],
      });
    }
    for (const row of rows) if (needed && row.project === needed.project) row.needed = true;
    // the project a task needs first, then those with the person's own open tasks
    rows.sort((a, b) => Number(Boolean(b.needed)) - Number(Boolean(a.needed)) || b.tasks.length - a.tasks.length || a.name.localeCompare(b.name));
    // tasks without a project cannot open here (a task opens in its project's folders): listed, with why
    const unassigned = tasks
      .filter((t) => !t.project)
      .map((t) => ({ task: t.name, subject: plainText(t.subject, 200), status: t.status, deadline: t.exp_end_date || null, overdue: Boolean(t.is_overdue) }));
    return {
      site,
      projects: rows,
      unassigned,
      // the list was cut (a very long one, or a hub that did not move on): the panel says so
      projects_cut: projectList.cut,
      request: openRequest && openRequest.site === site ? openRequest : null,
    };
  });
}

// The person's open projects, every page, until TBO Support says there are no more. A cursor
// seen before ends the reading (a hub that does not move on); a list cut by the safety cap
// (MAX_PROJECT_PAGES of 50) says so in the panel, never silently.
const MAX_PROJECT_PAGES = 200;

async function allProjects(client) {
  const rows = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
    const got = await client.method("helpdesk.api.mobile.get_projects", { status: "Open", limit: 50, cursor });
    rows.push(...(Array.isArray(got && got.data) ? got.data : []));
    if (!got || !got.has_more || got.next_cursor == null) return { rows, cut: false };
    const next = String(got.next_cursor);
    if (seen.has(next)) return { rows, cut: true };
    seen.add(next);
    cursor = got.next_cursor;
  }
  return { rows, cut: true };
}

// the panel's own site must still be the current one: a settings change meanwhile acts on nothing
async function checkPanelSite(payload) {
  const site = await currentSite();
  if (payload && payload.site && !sameOrigin(payload.site, site)) {
    throw fail("STALE", `The TBO Support site changed to ${site}. Look at the list again, then try once more.`);
  }
  return site;
}

async function addFolder(payload) {
  const project = payload && payload.project;
  const site = await checkPanelSite(payload); // the site of the project, before the picker opens
  const picked = await pi.fs.requestDirectory();
  if (!picked || !picked.path) return { cancelled: true };
  if (!sameOrigin(await currentSite(), site)) {
    throw fail("STALE", "The TBO Support site changed while you chose the folder; nothing was kept. Choose it again.");
  }
  return { folders: projectStore.addFolder(site, project, payload && payload.name, picked.path) };
}

async function openTaskFromPanel(payload) {
  const task = payload && payload.task;
  const generation = epoch; // a settings change from here on stops the open (onSettingsChanged)
  const site = await checkPanelSite(payload); // the site the person saw when they pressed Open
  const result = await withClient((client, current) => {
    if (!sameOrigin(current, site)) throw fail("STALE", "The TBO Support site changed; nothing was opened.");
    return projects.openTask({
      task,
      site,
      client,
      store: projectStore,
      invoke: (input) => pi.desktop.invoke(input),
      stillCurrent: () => generation === epoch,
    });
  });
  // a project the person must add folders for keeps a card in the list until they have
  if (result.needFolders && generation === epoch) neededProject = { site, project: result.project, name: result.projectName };
  else if (result.opened && neededProject && neededProject.project === result.project) neededProject = null;
  // the link's request is done only when this open is still the current one: an open started before a
  // settings change must not clear a newer request for the same task number on the new site
  if (result.opened && generation === epoch && openRequest && openRequest.task === result.task && sameOrigin(openRequest.site, site)) {
    openRequest = null;
  }
  return result;
}

// tbo-copilot://task/TASK-…?site=…: the panel asks "Open task …?"; a link for another site, or
// any other link, opens nothing
async function onOpenUrl(payload) {
  const link = projects.parseTaskLink(payload && payload.url);
  if (!link) return;
  let site;
  try {
    site = await currentSite();
  } catch {
    return;
  }
  if (link.site && !sameOrigin(link.site, site)) {
    await pi.ui
      .showToast(`That task link is for ${plainText(link.site, 200)}, but TBO Copilot uses ${site}. Change the site in the TBO Support settings to open it.`, "error")
      .catch(() => {});
    return;
  }
  openRequest = { task: link.task, site };
  await pi.ui.openPanel({ title: "TBO Support" }).catch(() => {});
}

async function onPanelInvoke(channel, payload) {
  try {
    if (channel === "tbo-support.state") {
      const askReport = reportAsked;
      reportAsked = false;
      // a task link waiting for the person's Open shows the Projects view too
      const askProjects = projectsAsked || Boolean(openRequest);
      projectsAsked = false;
      return { ok: true, ...(await panelState()), askReport, askProjects };
    }
    if (channel === "tbo-support.microsoft") return { ok: true, pending: await startMicrosoft() };
    if (channel === "tbo-support.open-again") {
      if (pending && !pending.error) await pi.shell.openExternal(pending.verifyUrl);
      return { ok: true, pending: pendingView(pending) };
    }
    if (channel === "tbo-support.cancel") {
      if (pending) pending.cancelled = true;
      pending = null;
      return { ok: true };
    }
    if (channel === "tbo-support.sign-in") return { ok: true, ...(await signInWithKey(payload)) };
    if (channel === "tbo-support.sign-out") return { ok: true, ...(await signOut()) };
    if (channel === "tbo-support.report") return { ok: true, ...(await reportFromPanel(payload)) };
    // Phase 22: projects, their folders on this computer, and opening a task in its project
    if (channel === "tbo-support.projects") return { ok: true, ...(await projectsView()) };
    if (channel === "tbo-support.add-folder") return { ok: true, ...(await addFolder(payload)) };
    if (channel === "tbo-support.remove-folder") {
      const site = await checkPanelSite(payload);
      return { ok: true, folders: projectStore.removeFolder(site, payload && payload.project, payload && payload.folder) };
    }
    if (channel === "tbo-support.first-folder") {
      const site = await checkPanelSite(payload);
      return { ok: true, folders: projectStore.makeFirst(site, payload && payload.project, payload && payload.folder) };
    }
    if (channel === "tbo-support.open-task") return { ok: true, ...(await openTaskFromPanel(payload)) };
    if (channel === "tbo-support.dismiss-request") {
      openRequest = null;
      return { ok: true };
    }
    if (channel === "tbo-support.open-report") {
      // the site may have changed since the report was sent: open only a page on the current one, and
      // only the report still kept after reading it (a settings change meanwhile forgets it)
      const report = lastReport;
      if (report && report.url) {
        const site = await currentSite();
        if (report === lastReport && sameOrigin(report.url, site)) await pi.shell.openExternal(report.url);
      }
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, code: e.code || "ERROR", error: e.message };
  }
  return { ok: false, code: "UNSUPPORTED", error: `Unknown channel ${channel}` };
}

// --- lifecycle -----------------------------------------------------------------

// At start, and whenever the site changes: renew this site's sign-in (and with
// it the AI key), or clear a TBO AI key no sign-in here stands behind. At
// start the row may hold a key from an earlier run, whose sign-in is not known
// (`clearFirst`): it is cleared, and the renewal sets the current one. A
// renewal that fails is tried again at the next check, panel read or tool call.
async function syncSite({ openPanel = false, clearFirst = false } = {}) {
  // a sync overtaken by a later site change (or sign-in) opens no panel for a site no longer chosen
  const generation = epoch;
  if (clearFirst) await exclusive(clearAi);
  let site;
  try {
    site = await currentSite();
  } catch {
    await exclusive(clearAi);
    return;
  }
  await reconcileAi(site);
  const session = await store.loadSession(keyOf(site));
  if (session) {
    try {
      await renew(site, session, { force: true });
    } catch {
      if (!aiApplied) aiRetryAt = Date.now();
    }
    return;
  }
  await clearAiUnlessSignedIn(site, { always: true });
  const credentials = await store.load(keyOf(site));
  if (openPanel && generation === epoch && !credentials && !isLoopback(hostOf(site))) {
    await pi.ui.openPanel({ title: "TBO Support" }).catch(() => {});
  }
}

async function check() {
  try {
    const site = await currentSite();
    await reconcileAi(site);
    const session = await store.loadSession(keyOf(site));
    if (session) await renew(site, session);
    else await clearAiUnlessSignedIn(site);
  } catch {
    // tried again at the next check
  }
}

// What a settings change is compared with: the site (as normalised, null when the address is not
// usable) and the AWS tool's settings.
async function settingsNow() {
  const settings = (await pi.plugin.getSettings().catch(() => null)) || {};
  let site = null;
  try {
    site = normalizeSite(settings.siteUrl || DEFAULT_SITE, siteHosts());
  } catch {
    site = null;
  }
  const awsSettings = JSON.stringify(Object.keys(settings).filter((k) => k.startsWith("aws")).sort().map((k) => [k, settings[k]]));
  return { site, aws: awsSettings };
}

// Only a change of the site is a site change (Phase 23): work still running for the old one drops
// its answer (it cannot put that site's key back), a waiting sign-in and a task link end, and the
// new site is synced. Any other setting (the AWS ones) leaves the sign-in and an opening task alone.
// A new site nobody is signed in to here opens the panel at once, as at start (testing fixes 9):
// otherwise its sign-in showed only after the app was started again.
async function onSettingsChanged() {
  const now = await settingsNow();
  const before = knownSettings;
  knownSettings = now;
  if (aws && (!before || before.aws !== now.aws)) aws.stop(); // a new AWS profile or region starts a new AWS server
  if (before && before.site === now.site) return;
  openRequest = null; // a task link asked for under the old site opens nothing now
  neededProject = null;
  lastReport = null; // a report's link belongs to the site it was sent to
  epoch += 1;
  if (pending) pending.cancelled = true;
  pending = null;
  syncSite({ openPanel: true }).catch(() => {});
}

function startup() {
  return syncSite({ openPanel: true, clearFirst: true });
}

async function onLoad() {
  knownSettings = await settingsNow();
  store = createStore({ dataDir: await pi.plugin.getDataPath() });
  projectStore = projects.createProjectStore({ dataDir: await pi.plugin.getDataPath() });

  await pi.agent.registerTool({
    ...TOOL,
    execute: async (args, ctx) => {
      const action = args && args.action;
      const ticket = args && args.ticket ? ` ticket ${args.ticket}` : "";
      if (ctx && ctx.log) ctx.log(`tbo_support ${action}${ticket}`);
      return runSignedIn(args);
    },
  });

  // the writes: declared high risk, so the app asks the person before each one (Phase 21)
  await pi.agent.registerTool({
    ...CHANGE_TOOL,
    execute: async (args, ctx) => {
      if (ctx && ctx.log) ctx.log(`tbo_support_change ${args && args.action}`);
      return runSignedIn(args, CHANGE_TOOL);
    },
  });

  aws = createAws({
    getSettings: () => pi.plugin.getSettings(),
    getDataPath: () => pi.plugin.getDataPath(),
    // a change asks TBO Support for its approval, as the signed-in person
    hub: async () => (await signedInClient()).client,
  });
  await pi.agent.registerTool({
    ...AWS_TOOL,
    execute: async (args, ctx) => {
      if (ctx && ctx.log) ctx.log(`tbo_aws ${args && args.action}`);
      return aws.run(args);
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
        const done = await signOut();
        if (done.error) await pi.ui.showToast(done.error, "error");
        else await pi.ui.showToast("Signed out of TBO Support and TBO AI.");
      } catch (e) {
        await pi.ui.showToast(e.message, "error");
      }
    },
  });

  await pi.commands.register({
    id: COMMANDS.report,
    title: "TBO Support: Report a problem",
    keywords: ["tbo", "copilot", "feedback", "bug", "problem", "report"],
    run: () => {
      reportAsked = true;
      return pi.ui.openPanel({ title: "TBO Support" });
    },
  });

  await pi.commands.register({
    id: COMMANDS.projects,
    title: "TBO Support: Projects and tasks",
    keywords: ["tbo", "project", "task", "folder", "work", "complete"],
    run: () => {
      projectsAsked = true;
      return pi.ui.openPanel({ title: "TBO Support" });
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
        if (state.error) throw new Error(state.error); // kept, but TBO Support could not be reached
        // a kept Microsoft sign-in proves nothing on its own: ask TBO Support who this is
        const me = state.method === "microsoft" ? await runSignedIn({ action: "who_am_i" }) : null;
        const ai = aiState.ready ? " TBO AI is ready." : state.method === "microsoft" ? " TBO AI is not ready yet." : "";
        await pi.ui.showToast(`Signed in to ${state.site} as ${state.fullName || (me && me.user) || state.user}.${ai}`);
      } catch (e) {
        await pi.ui.showToast(e.message, "error");
      }
    },
  });

  if (pi.events && pi.events.on) pi.events.on(SETTINGS_EVENT, onSettingsChanged);
  if (pi.events && pi.events.on) pi.events.on(OPEN_URL_EVENT, onOpenUrl);

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
  if (pi.events && pi.events.off) pi.events.off(SETTINGS_EVENT, onSettingsChanged);
  if (pi.events && pi.events.off) pi.events.off(OPEN_URL_EVENT, onOpenUrl);
  await pi.agent.unregisterTool(TOOL.name).catch(() => {});
  await pi.agent.unregisterTool(CHANGE_TOOL.name).catch(() => {});
  await pi.agent.unregisterTool(AWS_TOOL.name).catch(() => {});
  if (aws) aws.stop();
  aws = null;
  for (const id of Object.values(COMMANDS)) {
    await pi.commands.unregister(id).catch(() => {});
  }
  store = null;
  projectStore = null;
  openRequest = null;
  neededProject = null;
}

// `startup` and `check` are what the plugin's two timers run; exported for the tests.
module.exports = { onLoad, onUnload, onPanelInvoke, onOpenUrl, AI_PROVIDER, keyOf, startup, check };
