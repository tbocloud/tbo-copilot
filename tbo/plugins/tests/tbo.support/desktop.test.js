"use strict";

// The Microsoft sign-in through TBO Support (tbo_desktop), against a fake site.

const test = require("node:test");
const assert = require("node:assert/strict");
const desktop = require("../../tbo.support/lib/desktop");

const SITE = "https://teams.teambackoffice.com";
const OS = { hostname: () => "Rahul-MacBook", platform: () => "darwin", release: () => "25.0.0" };
const reply = (status, message) => ({ status, headers: {}, bodyText: JSON.stringify({ message }) });

function fakeSite(answers) {
  const calls = [];
  const request = async (input) => {
    calls.push({ ...input, body: JSON.parse(input.body) });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { request, calls };
}

const STARTED = {
  code: "K7P-4QX",
  device_code: "device-secret",
  verify_url: `${SITE}/copilot-desktop/sign-in?code=K7P-4QX`,
  expires_in: 600,
  interval: 3,
};
const APPROVED = {
  status: "approved",
  sign_in: "TDS-2026-00001",
  computer_token: "computer-secret",
  expires_at: "2026-12-06 10:00:00",
  access_token: "bearer-1",
  access_expires_in: 43200,
  user: { email: "rahul@teambackoffice.com", full_name: "Rahul" },
  ai: { base_url: "https://ai.example.test/v1", key: "sk-1", models: ["tbo-default"], monthly_limit: 50 },
};

test("start posts the computer's name and system, and refuses a page on another site", async () => {
  const { request, calls } = fakeSite([reply(200, STARTED)]);
  const started = await desktop.start({ request, siteUrl: SITE, os: OS, appVersion: "0.16.1" });
  assert.equal(started.code, "K7P-4QX");
  assert.equal(calls[0].url, `${SITE}/api/method/tbo_desktop.api.start_sign_in`);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { computer: "Rahul-MacBook", system: "macOS 25.0.0", app_version: "0.16.1" });

  const other = fakeSite([reply(200, { ...STARTED, verify_url: "https://evil.example.com/x" })]);
  await assert.rejects(desktop.start({ request: other.request, siteUrl: SITE, os: OS }), { code: "HELPDESK_ERROR" });
});

test("start says when the site has Microsoft sign-in switched off or does not offer it", async () => {
  const off = fakeSite([{ status: 403, headers: {}, bodyText: JSON.stringify({ _server_messages: JSON.stringify([JSON.stringify({ message: "TBO Copilot desktop sign-in is switched off on this site." })]) }) }]);
  await assert.rejects(desktop.start({ request: off.request, siteUrl: SITE, os: OS }), { code: "NOT_AVAILABLE", message: /switched off/ });
  const missing = fakeSite([{ status: 404, headers: {}, bodyText: "{}" }]);
  await assert.rejects(desktop.start({ request: missing.request, siteUrl: SITE, os: OS }), { code: "NOT_AVAILABLE" });
});

test("poll waits while pending and returns the session once allowed", async () => {
  const { request, calls } = fakeSite([reply(200, { status: "pending" }), reply(200, { status: "pending" }), reply(200, APPROVED)]);
  const slept = [];
  const session = await desktop.poll({ request, siteUrl: SITE, started: STARTED, sleep: async (ms) => slept.push(ms), now: () => 1000 });
  assert.deepEqual(slept, [3000, 3000, 3000]);
  assert.ok(calls.every((c) => c.body.device_code === "device-secret"));
  assert.equal(session.computerToken, "computer-secret");
  assert.equal(session.accessToken, "bearer-1");
  assert.equal(session.accessExpiresAt, 1000 + 43200 * 1000);
  assert.equal(session.user, "rahul@teambackoffice.com");
  assert.equal(session.ai.key, "sk-1");
});

test("poll stops on deny, expiry and cancel", async () => {
  const deny = fakeSite([reply(200, { status: "denied" })]);
  await assert.rejects(desktop.poll({ request: deny.request, siteUrl: SITE, started: STARTED, sleep: async () => {} }), { code: "DENIED" });
  const expired = fakeSite([reply(200, { status: "expired" })]);
  await assert.rejects(desktop.poll({ request: expired.request, siteUrl: SITE, started: STARTED, sleep: async () => {} }), { code: "EXPIRED" });
  let t = 0;
  const slow = fakeSite(Array.from({ length: 400 }, () => reply(200, { status: "pending" })));
  await assert.rejects(desktop.poll({ request: slow.request, siteUrl: SITE, started: STARTED, sleep: async () => {}, now: () => (t += 5000) }), { code: "EXPIRED" });
  let cancelled = false;
  const cancel = fakeSite([reply(200, { status: "pending" })]);
  await assert.rejects(
    desktop.poll({ request: cancel.request, siteUrl: SITE, started: STARTED, sleep: async () => { cancelled = true; }, isCancelled: () => cancelled }),
    { code: "CANCELLED" },
  );
});

test("refresh keeps the computer token; a 401 means the sign-in is over, with TBO Support's reason", async () => {
  const ok = fakeSite([reply(200, { ...APPROVED, status: undefined, computer_token: undefined, access_token: "bearer-2" })]);
  const fresh = await desktop.refresh({ request: ok.request, siteUrl: SITE, computerToken: "computer-secret", appVersion: "0.16.2", now: () => 0 });
  assert.equal(fresh.computerToken, "computer-secret");
  assert.equal(fresh.accessToken, "bearer-2");
  assert.deepEqual(ok.calls[0].body, { computer_token: "computer-secret", app_version: "0.16.2" });

  const over = fakeSite([reply(401, { status: "signed_out", reason: "You do not have the role TBO Copilot Desktop." })]);
  await assert.rejects(desktop.refresh({ request: over.request, siteUrl: SITE, computerToken: "x" }), { code: "SIGNED_OUT", message: /role/ });
  const offline = fakeSite([new Error("ENOTFOUND")]);
  await assert.rejects(desktop.refresh({ request: offline.request, siteUrl: SITE, computerToken: "x" }), { code: "NETWORK" });
});

test("sign-out tells TBO Support, and never fails when it cannot be reached", async () => {
  const { request, calls } = fakeSite([reply(200, { ok: true })]);
  await desktop.signOut({ request, siteUrl: SITE, computerToken: "computer-secret" });
  assert.equal(calls[0].url, `${SITE}/api/method/tbo_desktop.api.sign_out`);
  const offline = fakeSite([new Error("ENOTFOUND")]);
  await desktop.signOut({ request: offline.request, siteUrl: SITE, computerToken: "x" });
});
