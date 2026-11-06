"use strict";

// Signing TBO Copilot in with the person's Microsoft account, through TBO
// Support's tbo_desktop app (TBO Copilot Phase 17). The transport is passed in
// (pi.net.fetch in the app), so this file does not depend on the app.
//
// 1. start(): TBO Support gives a code and the address of its Allow page.
// 2. The person logs in with Microsoft and presses Allow; poll() waits for it.
// 3. TBO Support hands over, once: a computer token (30 days), a TBO Support
//    token (12 hours) and the person's TBO AI key.
// 4. refresh() renews the TBO Support token while the person may use the app;
//    a 401 means the sign-in is over.

const { frappeMessage } = require("./helpdesk");

const TIMEOUT_MS = 30000;
const API = "/api/method/tbo_desktop.api.";

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function parse(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

async function call(request, siteUrl, name, body) {
  let res;
  try {
    res = await request({
      url: `${siteUrl}${API}${name}`,
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      timeoutMs: TIMEOUT_MS,
    });
  } catch (e) {
    throw fail("NETWORK", `Could not reach TBO Support (${e && e.message ? e.message : e}).`);
  }
  const json = parse(res.bodyText || "");
  const message = json && json.message;
  if (res.status === 401 || res.status === 403) {
    const reason = (message && message.reason) || frappeMessage(res.bodyText || "") || "Your TBO sign-in has ended.";
    throw fail("SIGNED_OUT", reason);
  }
  if (res.status === 404) {
    throw fail("NOT_AVAILABLE", "This TBO Support site does not offer Microsoft sign-in yet. Use an API key, or ask TBO.");
  }
  if (res.status === 429) throw fail("RATE_LIMITED", "Too many sign-in attempts. Wait a few minutes and try again.");
  if (res.status < 200 || res.status >= 300 || !message) {
    throw fail("HELPDESK_ERROR", `TBO Support could not handle the sign-in (HTTP ${res.status}).`);
  }
  return message;
}

function computerInfo({ os, appVersion }) {
  const platform = os.platform();
  const system = platform === "darwin" ? `macOS ${os.release()}` : platform === "win32" ? `Windows ${os.release()}` : `${platform} ${os.release()}`;
  return { computer: String(os.hostname() || "A computer").slice(0, 140), system, app_version: String(appVersion || "").slice(0, 60) };
}

async function start({ request, siteUrl, os, appVersion }) {
  let started;
  try {
    started = await call(request, siteUrl, "start_sign_in", computerInfo({ os, appVersion }));
  } catch (e) {
    // a 403 here means the site has Microsoft sign-in switched off, not a sign-in that ended
    if (e.code === "SIGNED_OUT") throw fail("NOT_AVAILABLE", e.message);
    throw e;
  }
  if (!started.code || !started.device_code || !started.verify_url) {
    throw fail("HELPDESK_ERROR", "TBO Support's sign-in answer was incomplete.");
  }
  // Open only an address on the same TBO Support site.
  if (new URL(started.verify_url).origin !== siteUrl) {
    throw fail("HELPDESK_ERROR", "TBO Support sent a sign-in page on another site; refused.");
  }
  return started;
}

// Waits until the person allows or denies, the code expires, or `isCancelled()`.
async function poll({ request, siteUrl, started, sleep, now = Date.now, isCancelled = () => false }) {
  const intervalMs = Math.max(Number(started.interval) || 3, 1) * 1000;
  const until = now() + Math.max(Number(started.expires_in) || 600, 60) * 1000;
  while (now() < until) {
    if (isCancelled()) throw fail("CANCELLED", "Sign-in cancelled.");
    await sleep(intervalMs);
    if (isCancelled()) throw fail("CANCELLED", "Sign-in cancelled.");
    const got = await call(request, siteUrl, "finish_sign_in", { device_code: started.device_code });
    if (got.status === "approved") return session(got, now);
    if (got.status === "denied") throw fail("DENIED", "The sign-in was denied in the browser.");
    if (got.status === "expired") throw fail("EXPIRED", "The sign-in code expired. Start again.");
  }
  throw fail("EXPIRED", "The sign-in code expired. Start again.");
}

// What the plugin keeps (in the Keychain or with DPAPI): never the AI key.
function session(got, now = Date.now) {
  return {
    computerToken: got.computer_token || "",
    accessToken: got.access_token,
    accessExpiresAt: now() + Math.max(Number(got.access_expires_in) || 3600, 60) * 1000,
    signInExpiresAt: got.expires_at || "",
    user: (got.user && got.user.email) || "",
    fullName: (got.user && got.user.full_name) || "",
    ai: got.ai || null,
  };
}

async function refresh({ request, siteUrl, computerToken, appVersion, now = Date.now }) {
  const got = await call(request, siteUrl, "refresh", { computer_token: computerToken, app_version: appVersion || "" });
  return { ...session(got, now), computerToken };
}

async function signOut({ request, siteUrl, computerToken }) {
  try {
    await call(request, siteUrl, "sign_out", { computer_token: computerToken });
  } catch {
    // signing out locally is enough when TBO Support cannot be reached
  }
}

module.exports = { start, poll, refresh, signOut, session, computerInfo, API };
