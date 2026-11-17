"use strict";

// A small HTTP client for TBO Support (the Frappe app "helpdesk"). The
// transport is passed in: pi.net.fetch in the desktop app, Node's fetch on a
// server. Only the API paths below can be called. Reads use GET, except those
// whose arguments may be words people typed (READ_BY_POST), which go as a POST
// body so the words stay out of URLs and network logs. The few writes
// (WRITE_METHODS) never change a ticket: they ask TBO Support for an approval,
// say how an approved action went, take a Press backup, ask for a Press
// action that then waits for an approver (TBO Copilot Phase 18), start the
// person's timer on their own task (Phase 20), file their report of a problem
// with TBO Copilot as a task for its team (Phase 21), or pause, hold, resume or
// complete their own task (Phase 22).

const READ_METHODS = new Set([
  "frappe.auth.get_logged_user",
  "helpdesk.api.search.search",
  "helpdesk.helpdesk.doctype.hd_ticket.api.get_one",
  "helpdesk.api.support_hub.get_triage",
  "helpdesk.api.fix_brief.get_fix_brief",
  "helpdesk.api.session_replay.get_session_replay",
  "helpdesk.api.duplicates.get_possible_duplicates",
  "helpdesk.api.ai_suggestion.get_suggestion",
  "helpdesk.api.customization.get_estimate",
  "helpdesk.api.article.search",
  "helpdesk.api.knowledge_base.get_article",
  // Press and approvals (Phase 18)
  "helpdesk.api.copilot_press.sites",
  "helpdesk.api.copilot_press.site_status",
  "helpdesk.api.copilot_press.jobs",
  "helpdesk.api.copilot_press.job",
  "helpdesk.api.copilot_press.failed_jobs",
  "helpdesk.api.copilot_press.deploy_history",
  "helpdesk.api.copilot_actions.get_action_approval",
  "helpdesk.api.copilot_actions.approved_action",
  // the person's tasks, for work on a task in the desktop app (Phase 20)
  "helpdesk.api.mobile.get_tasks",
  "helpdesk.api.mobile.get_task",
  // the person's projects, each with its folders on this computer (Phase 22)
  "helpdesk.api.mobile.get_projects",
  // where a task's change stands on its way to the customer's sites (Phase 22)
  "helpdesk.api.copilot_go_live.task_release",
  // what TBO Support's Complete dialog offers before a task is completed: the days its timer ran,
  // the hours still free on each (Phase 23)
  "helpdesk.tasky.api.get_completion_days",
]);

// a search's words, a customer's name: sent in the body (TBO Copilot Phase 21, docs/tbo/security.md F5).
// Frappe answers a whitelisted read the same way for GET and POST.
const READ_BY_POST = new Set([
  "helpdesk.api.search.search",
  "helpdesk.api.article.search",
  "helpdesk.api.copilot_press.sites",
  // an AWS command and its profile (Phase 23): never in a URL
  "helpdesk.api.copilot_actions.approved_action",
]);

const WRITE_METHODS = new Set([
  "helpdesk.api.copilot_actions.request_action_approval",
  "helpdesk.api.copilot_actions.mark_action_executed",
  "helpdesk.api.copilot_press.backup",
  "helpdesk.api.copilot_press.request_action",
  // starts the person's own timer on a task they work on (Open becomes Working)
  "helpdesk.api.mobile.start_task",
  // the person's own task from the desktop app (Phase 22): pause its timer, hold it with a
  // reason, resume it, or complete it with the hours, which TBO Support logs to their timesheet
  "helpdesk.api.mobile.pause_task",
  "helpdesk.api.mobile.hold_task",
  "helpdesk.api.mobile.resume_task",
  "helpdesk.api.mobile.complete_task",
  // completing with the hours of several days, each on its own date: TBO Support's Complete dialog's call (Phase 23)
  "helpdesk.tasky.api.complete_task",
  // asks the release's approver for the task's change to go live tonight or now; they decide
  "helpdesk.api.copilot_go_live.ask_go_live",
  // the person's report for the TBO Copilot team: a task in their project, never a ticket (Phase 21)
  "helpdesk.api.copilot_feedback.report_problem",
]);

const READ_DOCTYPES = new Set(["HD Ticket"]);

const TIMEOUT_MS = 30000;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// A local bench on this computer, for testing. Only these may use plain HTTP.
// Names ending in .localhost always mean this computer (RFC 6761), so a
// bench site such as tbo.localhost can keep its own name.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

function isLoopback(hostname) {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

// Same rule as manifest.net.domains: "*.example.com" covers example.com and
// every name under it.
function hostAllowed(hostname, allowedHosts) {
  return allowedHosts.some((entry) => {
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      return hostname === base || hostname.endsWith(`.${base}`);
    }
    return hostname === entry;
  });
}

// Normalises the site setting and checks it against the plugin's allowed hosts.
function normalizeSite(siteUrl, allowedHosts) {
  let url;
  try {
    url = new URL(String(siteUrl || "").trim());
  } catch {
    throw fail("INVALID_SITE", `The TBO Support address "${siteUrl}" is not a valid URL.`);
  }
  const localHttp = url.protocol === "http:" && isLoopback(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw fail("INVALID_SITE", "The TBO Support address must start with https:// (plain http:// only for localhost or a *.localhost site).");
  }
  if (allowedHosts && !hostAllowed(url.hostname, allowedHosts)) {
    throw fail(
      "INVALID_SITE",
      `The plugin may only reach ${allowedHosts.join(", ")}, not ${url.hostname}. Change the address in the plugin settings.`,
    );
  }
  return url.origin;
}

// Pulls a readable message out of a Frappe error response.
function frappeMessage(bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return "";
  }
  if (body && typeof body._server_messages === "string") {
    try {
      const messages = JSON.parse(body._server_messages)
        .map((m) => {
          try {
            return JSON.parse(m).message;
          } catch {
            return m;
          }
        })
        .filter(Boolean);
      if (messages.length) return String(messages.join(" ")).replace(/<[^>]+>/g, "");
    } catch {
      // fall through to the exception text
    }
  }
  if (body && typeof body.exception === "string") {
    return body.exception.replace(/^[\w.]+:\s*/, "");
  }
  if (body && typeof body.message === "string") return body.message;
  return "";
}

const MISSING_METHOD = /Failed to get method/i;
const NOT_YET = "This TBO Support site does not have this yet: it needs a newer TBO Support. Ask TBO.";

function errorFor(status, bodyText) {
  const detail = frappeMessage(bodyText);
  const short = detail ? ` ${detail.slice(0, 300)}` : "";
  if (status === 401) return fail("AUTH", "TBO Support did not accept your sign-in. Run 'TBO Support: Sign in' again.");
  if (status === 403) return fail("FORBIDDEN", `Your TBO Support account may not read this.${short}`);
  if (status === 404) return fail("NOT_FOUND", `Not found in TBO Support.${short}`);
  if (status === 429) return fail("RATE_LIMITED", "TBO Support is rate-limiting requests. Wait a minute and try again.");
  if (/DoesNotExistError/.test(bodyText)) return fail("NOT_FOUND", `Not found in TBO Support.${short}`);
  if (/PermissionError/.test(bodyText)) return fail("FORBIDDEN", `Your TBO Support account may not read this.${short}`);
  // an older TBO Support without this call answers 417 "Failed to get method …" (Phase 23)
  if (MISSING_METHOD.test(bodyText)) return fail("NOT_AVAILABLE", NOT_YET);
  // an ordinary refusal (a ValidationError) says its reason, not an HTTP code
  if (status === 417 && detail) return fail("HELPDESK_ERROR", `TBO Support refused it: ${detail.slice(0, 300)}`);
  return fail("HELPDESK_ERROR", `TBO Support returned an error (HTTP ${status}).${short}`);
}

// credentials: { token } from the Microsoft sign-in (a TBO Support bearer token),
// or { key, secret } (an API key, for a local test site).
function authorization(credentials) {
  if (credentials && credentials.token) return `Bearer ${credentials.token}`;
  if (credentials && credentials.key && credentials.secret) return `token ${credentials.key}:${credentials.secret}`;
  return null;
}

function createClient({ siteUrl, credentials, request, timeoutMs = TIMEOUT_MS }) {
  const auth = authorization(credentials);
  if (!auth) {
    throw fail("NOT_SIGNED_IN", "Not signed in to TBO Support. Run 'TBO Support: Sign in' from the command palette.");
  }
  const headers = { Accept: "application/json", Authorization: auth };

  async function get(path, params) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      query.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    const qs = query.toString();
    const url = `${siteUrl}${path}${qs ? `?${qs}` : ""}`;
    let res;
    try {
      res = await request({ url, method: "GET", headers, timeoutMs });
    } catch (e) {
      throw fail("NETWORK", `Could not reach TBO Support (${e && e.message ? e.message : e}).`);
    }
    return parseBody(res);
  }

  async function post(path, params, wait = timeoutMs) {
    let res;
    try {
      res = await request({
        url: `${siteUrl}${path}`,
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(params || {}),
        timeoutMs: wait,
      });
    } catch (e) {
      throw fail("NETWORK", `Could not reach TBO Support (${e && e.message ? e.message : e}).`);
    }
    return parseBody(res);
  }

  function parseBody(res) {
    if (res.status < 200 || res.status >= 300) throw errorFor(res.status, res.bodyText || "");
    try {
      return JSON.parse(res.bodyText);
    } catch {
      throw fail("HELPDESK_ERROR", "TBO Support sent a reply that is not JSON. Check the site address.");
    }
  }

  return {
    async method(path, params) {
      if (!READ_METHODS.has(path)) throw fail("NOT_ALLOWED", `The plugin may not call ${path}.`);
      const body = READ_BY_POST.has(path) ? await post(`/api/method/${path}`, params) : await get(`/api/method/${path}`, params);
      return body.message;
    },
    // `opts.timeoutMs`: a shorter wait for a write whose answer may come late (a Press backup)
    async post(path, params, opts) {
      if (!WRITE_METHODS.has(path)) throw fail("NOT_ALLOWED", `The plugin may not call ${path}.`);
      const wait = opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, timeoutMs) : timeoutMs;
      const body = await post(`/api/method/${path}`, params, wait);
      return body.message;
    },
    // the filters may hold a customer's name: a POST to frappe.client.get_list, the same
    // permission-checked list as GET /api/resource, with nothing in the URL
    async list(doctype, { fields, filters, orderBy, limit }) {
      if (!READ_DOCTYPES.has(doctype)) throw fail("NOT_ALLOWED", `The plugin may not list ${doctype}.`);
      const body = await post("/api/method/frappe.client.get_list", {
        doctype,
        fields,
        filters,
        order_by: orderBy,
        limit_page_length: limit,
      });
      return body.message || [];
    },
  };
}

module.exports = {
  createClient,
  normalizeSite,
  frappeMessage,
  hostAllowed,
  isLoopback,
  READ_METHODS,
  WRITE_METHODS,
  READ_DOCTYPES,
  LOOPBACK_HOSTS,
  MISSING_METHOD,
};
