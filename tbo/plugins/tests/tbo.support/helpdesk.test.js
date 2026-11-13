"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, normalizeSite, frappeMessage } = require("../../tbo.support/lib/helpdesk");

const SITE = "https://teams.teambackoffice.com";
const CREDS = { key: "abc123key", secret: "def456secret" };

function fakeRequest(responses) {
  const calls = [];
  const request = async (input) => {
    calls.push(input);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { request, calls };
}

test("normalizeSite accepts an allowed https host and returns its origin", () => {
  assert.equal(normalizeSite("https://teams.teambackoffice.com/app/", ["teams.teambackoffice.com"]), SITE);
});

test("normalizeSite accepts plain http only for a local bench", () => {
  const hosts = ["teams.teambackoffice.com", "localhost", "127.0.0.1"];
  assert.equal(normalizeSite("http://localhost:8000/helpdesk", hosts), "http://localhost:8000");
  assert.equal(normalizeSite("http://127.0.0.1:8000", hosts), "http://127.0.0.1:8000");
  assert.throws(() => normalizeSite("http://localhost:8000", ["teams.teambackoffice.com"]), { code: "INVALID_SITE" });
});

test("a bench site named *.localhost keeps its name and may use plain http", () => {
  const hosts = ["teams.teambackoffice.com", "localhost", "*.localhost", "127.0.0.1"];
  assert.equal(normalizeSite("http://tbo.localhost:8002/app", hosts), "http://tbo.localhost:8002");
  assert.throws(() => normalizeSite("http://tbo.new:8002", [...hosts, "tbo.new"]), { code: "INVALID_SITE" });
  assert.throws(() => normalizeSite("http://evil-localhost.com", hosts), { code: "INVALID_SITE" });
  assert.throws(() => normalizeSite("https://tbo.localhost.evil.com", hosts), { code: "INVALID_SITE" });
});

test("normalizeSite refuses http, bad URLs and hosts outside net.domains", () => {
  assert.throws(() => normalizeSite("http://teams.teambackoffice.com", ["teams.teambackoffice.com", "localhost"]), { code: "INVALID_SITE" });
  assert.throws(() => normalizeSite("not a url", []), { code: "INVALID_SITE" });
  assert.throws(() => normalizeSite("https://evil.example.com", ["teams.teambackoffice.com"]), { code: "INVALID_SITE" });
});

test("createClient refuses to start without credentials", () => {
  assert.throws(() => createClient({ siteUrl: SITE, credentials: null, request: async () => {} }), { code: "NOT_SIGNED_IN" });
});

test("method builds a GET with the token header and returns message", async () => {
  const { request, calls } = fakeRequest([{ status: 200, headers: {}, bodyText: '{"message":{"markdown":"# brief"}}' }]);
  const client = createClient({ siteUrl: SITE, credentials: CREDS, request });
  const out = await client.method("helpdesk.api.fix_brief.get_fix_brief", { ticket: "1234" });
  assert.deepEqual(out, { markdown: "# brief" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${SITE}/api/method/helpdesk.api.fix_brief.get_fix_brief?ticket=1234`);
  assert.equal(calls[0].headers.Authorization, "token abc123key:def456secret");
});

test("method refuses any path that is not on the read-only allow-list, without a request", async () => {
  const { request, calls } = fakeRequest([]);
  const client = createClient({ siteUrl: SITE, credentials: CREDS, request });
  await assert.rejects(client.method("helpdesk.api.ai_suggestion.regenerate_suggestion", { ticket: "1" }), { code: "NOT_ALLOWED" });
  await assert.rejects(client.method("frappe.client.set_value", {}), { code: "NOT_ALLOWED" });
  assert.equal(calls.length, 0);
});

test("list reads HD Ticket by POST, with the filters in the body, and refuses other doctypes", async () => {
  const { request, calls } = fakeRequest([{ status: 200, headers: {}, bodyText: '{"message":[{"name":1}]}' }]);
  const client = createClient({ siteUrl: SITE, credentials: CREDS, request });
  const filters = [["customer", "=", "Alpha Trading"]];
  const rows = await client.list("HD Ticket", { fields: ["name"], filters, orderBy: "modified desc", limit: 5 });
  assert.deepEqual(rows, [{ name: 1 }]);
  assert.equal(calls[0].method, "POST");
  // a customer's name never reaches the URL, so never the app's network log (docs/tbo/security.md F5)
  assert.equal(calls[0].url, `${SITE}/api/method/frappe.client.get_list`);
  assert.deepEqual(JSON.parse(calls[0].body), {
    doctype: "HD Ticket",
    fields: ["name"],
    filters,
    order_by: "modified desc",
    limit_page_length: 5,
  });
  await assert.rejects(client.list("User", { fields: [], filters: [], limit: 1 }), { code: "NOT_ALLOWED" });
  assert.equal(calls.length, 1);
});

test("reads whose arguments people typed go by POST; reads by number stay GET", async () => {
  const { READ_METHODS } = require("../../tbo.support/lib/helpdesk");
  for (const path of ["helpdesk.api.search.search", "helpdesk.api.article.search", "helpdesk.api.copilot_press.sites"]) {
    assert.ok(READ_METHODS.has(path), path);
    const { request, calls } = fakeRequest([{ status: 200, headers: {}, bodyText: '{"message":[]}' }]);
    const client = createClient({ siteUrl: SITE, credentials: CREDS, request });
    await client.method(path, { query: "invoice for Alpha Trading" });
    assert.equal(calls[0].method, "POST", path);
    assert.equal(calls[0].url, `${SITE}/api/method/${path}`);
    assert.doesNotMatch(calls[0].url, /Alpha|invoice/);
    assert.deepEqual(JSON.parse(calls[0].body), { query: "invoice for Alpha Trading" });
  }
  const { request, calls } = fakeRequest([{ status: 200, headers: {}, bodyText: '{"message":{}}' }]);
  await createClient({ siteUrl: SITE, credentials: CREDS, request }).method("helpdesk.helpdesk.doctype.hd_ticket.api.get_one", { name: "42" });
  assert.equal(calls[0].method, "GET");
});

test("HTTP errors map to clear codes", async () => {
  const cases = [
    [{ status: 401, bodyText: "{}" }, "AUTH"],
    [{ status: 403, bodyText: '{"exc_type":"PermissionError"}' }, "FORBIDDEN"],
    [{ status: 404, bodyText: "{}" }, "NOT_FOUND"],
    [{ status: 429, bodyText: "" }, "RATE_LIMITED"],
    [{ status: 417, bodyText: '{"exception":"frappe.exceptions.DoesNotExistError: HD Ticket 99 not found"}' }, "NOT_FOUND"],
    [{ status: 500, bodyText: "oops" }, "HELPDESK_ERROR"],
  ];
  for (const [response, code] of cases) {
    const { request } = fakeRequest([{ headers: {}, ...response }]);
    const client = createClient({ siteUrl: SITE, credentials: CREDS, request });
    await assert.rejects(client.method("frappe.auth.get_logged_user"), { code });
  }
});

test("network failures and non-JSON replies are reported, not swallowed", async () => {
  let { request } = fakeRequest([new Error("ECONNREFUSED")]);
  let client = createClient({ siteUrl: SITE, credentials: CREDS, request });
  await assert.rejects(client.method("frappe.auth.get_logged_user"), { code: "NETWORK" });
  ({ request } = fakeRequest([{ status: 200, headers: {}, bodyText: "<html>login</html>" }]));
  client = createClient({ siteUrl: SITE, credentials: CREDS, request });
  await assert.rejects(client.method("frappe.auth.get_logged_user"), { code: "HELPDESK_ERROR" });
});

test("frappeMessage reads _server_messages and exception text", () => {
  const server = JSON.stringify({ _server_messages: JSON.stringify([JSON.stringify({ message: "Ticket <b>9</b> is closed" })]) });
  assert.equal(frappeMessage(server), "Ticket 9 is closed");
  assert.equal(frappeMessage('{"exception":"frappe.exceptions.ValidationError: Bad value"}'), "Bad value");
  assert.equal(frappeMessage("not json"), "");
});

test("a Microsoft sign-in's token is sent as a bearer token", async () => {
  const { request, calls } = fakeRequest([{ status: 200, headers: {}, bodyText: '{"message":"rahul@teambackoffice.com"}' }]);
  const client = createClient({ siteUrl: SITE, credentials: { token: "bearer-1" }, request });
  assert.equal(await client.method("frappe.auth.get_logged_user"), "rahul@teambackoffice.com");
  assert.equal(calls[0].headers.Authorization, "Bearer bearer-1");
  assert.throws(() => createClient({ siteUrl: SITE, credentials: {}, request }), { code: "NOT_SIGNED_IN" });
});

test("post sends JSON with the sign-in, and only to the four listed paths", async () => {
  const { request, calls } = fakeRequest([{ status: 200, headers: {}, bodyText: '{"message":{"name":"TBO-ACT-2026-00001","status":"Pending"}}' }]);
  const client = createClient({ siteUrl: SITE, credentials: { token: "tok" }, request });
  const out = await client.post("helpdesk.api.copilot_actions.request_action_approval", { kind: "AWS", payload: { command: "aws ec2 start-instances" } });
  assert.equal(out.status, "Pending");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${SITE}/api/method/helpdesk.api.copilot_actions.request_action_approval`);
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].body), { kind: "AWS", payload: { command: "aws ec2 start-instances" } });
  for (const blocked of ["frappe.client.delete", "frappe.client.set_value", "helpdesk.api.copilot_actions.decide_action", "helpdesk.api.copilot_press.site_status"]) {
    await assert.rejects(client.post(blocked, {}), { code: "NOT_ALLOWED" }, blocked);
  }
  assert.equal(calls.length, 1);
});

test("the write list never lets the app approve its own request", () => {
  const { WRITE_METHODS, READ_METHODS } = require("../../tbo.support/lib/helpdesk");
  assert.deepEqual([...WRITE_METHODS].sort(), [
    "helpdesk.api.copilot_actions.mark_action_executed",
    "helpdesk.api.copilot_actions.request_action_approval",
    "helpdesk.api.copilot_press.backup",
    "helpdesk.api.copilot_press.request_action",
  ]);
  for (const p of WRITE_METHODS) assert.ok(!READ_METHODS.has(p), p);
});
