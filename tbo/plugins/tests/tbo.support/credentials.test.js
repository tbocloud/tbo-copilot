"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createStore, packSession, unpackSession, SERVICE, PS_PROTECT, PS_UNPROTECT } = require("../../tbo.support/lib/credentials");

const HOST = "teams.teambackoffice.com";
const CREDS = { key: "abc123key", secret: "def456secret" };

function fakeRunner(answers) {
  const calls = [];
  const runner = async (command, args, input) => {
    calls.push({ command, args, input });
    return answers.shift() || { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

test("macOS save sends the secret on stdin through security -i, never as an argument", async () => {
  const { runner, calls } = fakeRunner([{ code: 0, stdout: "", stderr: "" }]);
  await createStore({ platform: "darwin", runner }).save(HOST, CREDS);
  assert.equal(calls[0].command, "/usr/bin/security");
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.ok(!calls[0].args.join(" ").includes(CREDS.secret));
  assert.equal(calls[0].input, `add-generic-password -U -s ${SERVICE} -a ${HOST} -w abc123key:def456secret\n`);
});

test("macOS load reads the password and splits key and secret", async () => {
  const { runner, calls } = fakeRunner([{ code: 0, stdout: "abc123key:def456secret\n", stderr: "" }]);
  const out = await createStore({ platform: "darwin", runner }).load(HOST);
  assert.deepEqual(out, CREDS);
  assert.deepEqual(calls[0].args, ["find-generic-password", "-s", SERVICE, "-a", HOST, "-w"]);
});

test("macOS load returns null when nothing is saved", async () => {
  const { runner } = fakeRunner([{ code: 44, stdout: "", stderr: "not found" }]);
  assert.equal(await createStore({ platform: "darwin", runner }).load(HOST), null);
});

test("macOS save reports a Keychain error", async () => {
  const { runner } = fakeRunner([{ code: 0, stdout: "", stderr: "security: SecKeychainItemCreateFromContent: error" }]);
  await assert.rejects(createStore({ platform: "darwin", runner }).save(HOST, CREDS), { code: "SECRET_STORE" });
});

test("keys with anything but letters and digits are refused, so nothing odd reaches the command", async () => {
  const { runner, calls } = fakeRunner([]);
  const store = createStore({ platform: "darwin", runner });
  await assert.rejects(store.save(HOST, { key: "abc123 -a x", secret: "def456secret" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(store.save("bad host;", CREDS), { code: "INVALID_ARGUMENT" });
  assert.equal(calls.length, 0);
});

test("Windows save and load go through DPAPI with the secret on stdin, kept in the data folder", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tbo-support-"));
  const { runner, calls } = fakeRunner([
    { code: 0, stdout: "01000000d08c9ddf-blob\r\n", stderr: "" },
    { code: 0, stdout: "abc123key:def456secret", stderr: "" },
  ]);
  const store = createStore({ platform: "win32", runner, dataDir });
  await store.save(HOST, CREDS);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].args.at(-1), PS_PROTECT);
  assert.equal(calls[0].input, "abc123key:def456secret");
  const file = path.join(dataDir, `${HOST}.credentials.dpapi`);
  assert.equal(await fs.readFile(file, "utf8"), "01000000d08c9ddf-blob");

  assert.deepEqual(await store.load(HOST), CREDS);
  assert.equal(calls[1].args.at(-1), PS_UNPROTECT);
  assert.equal(calls[1].input, "01000000d08c9ddf-blob");

  await store.remove(HOST);
  await assert.rejects(fs.stat(file));
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("other platforms load nothing and refuse to save", async () => {
  const store = createStore({ platform: "linux" });
  assert.equal(await store.load(HOST), null);
  await assert.rejects(store.save(HOST, CREDS), { code: "UNSUPPORTED" });
});

const SESSION = {
  computerToken: "computer-secret_1",
  accessToken: "bearer-1",
  accessExpiresAt: 1790000000000,
  signInExpiresAt: "2026-12-06 10:00:00",
  user: "rahul@teambackoffice.com",
  fullName: "Rahul K",
  ai: { key: "sk-must-not-be-kept" },
};

test("a session is packed as one base64url word and never keeps the AI key", () => {
  const blob = packSession(SESSION);
  assert.match(blob, /^[A-Za-z0-9_-]+$/);
  const back = unpackSession(blob);
  assert.equal(back.computerToken, "computer-secret_1");
  assert.equal(back.fullName, "Rahul K");
  assert.equal(back.ai, undefined);
  assert.ok(!Buffer.from(blob, "base64url").toString().includes("sk-must-not-be-kept"));
  assert.equal(unpackSession("not base64 ; rm -rf"), null);
  assert.throws(() => packSession({ user: "x" }), { code: "INVALID_ARGUMENT" });
});

test("macOS keeps the session under its own account, on stdin", async () => {
  const blob = packSession(SESSION);
  const { runner, calls } = fakeRunner([{ code: 0, stdout: "", stderr: "" }, { code: 0, stdout: `${blob}\n`, stderr: "" }]);
  const store = createStore({ platform: "darwin", runner });
  await store.saveSession(HOST, SESSION);
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.equal(calls[0].input, `add-generic-password -U -s ${SERVICE} -a session.${HOST} -w ${blob}\n`);
  assert.equal((await store.loadSession(HOST)).accessToken, "bearer-1");
  assert.deepEqual(calls[1].args, ["find-generic-password", "-s", SERVICE, "-a", `session.${HOST}`, "-w"]);
});

test("Windows keeps the session with DPAPI in its own file", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tbo-support-"));
  const blob = packSession(SESSION);
  const { runner, calls } = fakeRunner([
    { code: 0, stdout: "01000000-session-blob\r\n", stderr: "" },
    { code: 0, stdout: blob, stderr: "" },
  ]);
  const store = createStore({ platform: "win32", runner, dataDir });
  await store.saveSession(HOST, SESSION);
  assert.equal(calls[0].input, blob);
  const file = path.join(dataDir, `${HOST}.session.dpapi`);
  assert.equal(await fs.readFile(file, "utf8"), "01000000-session-blob");
  assert.equal((await store.loadSession(HOST)).computerToken, "computer-secret_1");
  await store.removeSession(HOST);
  await assert.rejects(fs.stat(file));
  await fs.rm(dataDir, { recursive: true, force: true });
});
