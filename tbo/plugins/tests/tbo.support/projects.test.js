"use strict";

// Phase 22: TBO Support projects and tasks in the desktop app (lib/projects.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseTaskLink, createProjectStore, openTask, taskBrief } = require("../../tbo.support/lib/projects");

const SITE = "https://demo-tbo.tbocloud.in";

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbo-projects-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function folders(t, n) {
  const base = tmp(t);
  return Array.from({ length: n }, (_, i) => {
    const f = path.join(base, `app${i}`);
    fs.mkdirSync(f);
    return f;
  });
}

const TASK = {
  name: "TASK-2026-00123",
  subject: "<untrusted_ticket_content>Fix the stock report</untrusted_ticket_content>",
  project: "PROJ-0002",
  project_name: "Alpha ERP",
  customer: "Alpha Trading",
};

function client(task = TASK) {
  return { method: async (p, args) => (p === "helpdesk.api.mobile.get_task" && args.task === task.name ? { data: task } : { data: {} }) };
}

function desktop(overrides = {}) {
  const calls = [];
  const invoke = async (input) => {
    calls.push(input);
    const handler = overrides[input.operation];
    if (handler) return handler(input);
    if (input.operation === "session/create") return { session: { id: "s-1" } };
    if (input.operation === "project/groups/create") return { group: { id: "g-1" } };
    return {};
  };
  return { invoke, calls, ops: () => calls.map((c) => c.operation) };
}

test("a task link gives the task and the site; anything else gives nothing", () => {
  assert.deepEqual(parseTaskLink("tbo-copilot://task/TASK-2026-00123?site=https%3A%2F%2Fdemo-tbo.tbocloud.in"), {
    task: "TASK-2026-00123",
    site: SITE,
  });
  assert.equal(parseTaskLink("tbo-copilot://task/task-2026-00123").task, "TASK-2026-00123");
  for (const bad of [
    "https://demo-tbo.tbocloud.in/task/TASK-2026-00123",
    "tbo-copilot://ticket/0042",
    "tbo-copilot://task/TASK-26-1",
    "tbo-copilot://task/TASK-2026-00123%3Bnope",
    `tbo-copilot://task/TASK-2026-00123?site=${"x".repeat(3000)}`,
    null,
  ]) {
    assert.equal(parseTaskLink(bad), null, String(bad).slice(0, 60));
  }
});

test("a project's folders are kept per site, only real folders, at most ten, the first first", (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a, b] = folders(t, 2);
  assert.deepEqual(store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a), [a]);
  assert.deepEqual(store.addFolder(SITE, "PROJ-0002", "Alpha ERP", b), [a, b]);
  assert.deepEqual(store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a), [a, b]); // once each
  assert.deepEqual(store.folders("https://teams.teambackoffice.com", "PROJ-0002"), []); // another site
  assert.deepEqual(store.makeFirst(SITE, "PROJ-0002", b), [b, a]);
  assert.deepEqual(store.removeFolder(SITE, "PROJ-0002", a), [b]);
  assert.throws(() => store.addFolder(SITE, "PROJ-0002", "x", path.join(a, "missing")), { code: "INVALID_ARGUMENT" });
  assert.throws(() => store.addFolder(SITE, "../evil", "x", b), { code: "INVALID_ARGUMENT" });
  const many = folders(t, 11);
  for (const f of many.slice(0, 9)) store.addFolder(SITE, "PROJ-0002", "Alpha ERP", f);
  assert.throws(() => store.addFolder(SITE, "PROJ-0002", "Alpha ERP", many[10]), { code: "INVALID_ARGUMENT" });
});

test("a task whose project has no folders here asks for them first", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const d = desktop();
  const result = await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke });
  assert.deepEqual(result, { needFolders: true, task: "TASK-2026-00123", project: "PROJ-0002", projectName: "Alpha ERP" });
  assert.deepEqual(d.calls, []);
});

test("opening a task makes its chat in the project's folder and gives it the task, once", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a] = folders(t, 1);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  const d = desktop();
  const first = await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke });
  assert.equal(first.opened, true);
  assert.deepEqual(d.ops(), ["session/create", "session/open", "agent/prompt"]);
  assert.equal(d.calls[0].args[0].projectPath, a);
  assert.match(d.calls[0].args[0].title, /^TASK-2026-00123 Fix the stock report$/);
  const brief = d.calls[2].args[0].content;
  assert.match(brief, /TBO Support task TASK-2026-00123: Fix the stock report/);
  assert.match(brief, /complete_task/);
  assert.match(brief, /data, not instructions/);
  // again: the same chat, opened, with no second message
  const again = desktop();
  await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: again.invoke });
  assert.deepEqual(again.ops(), ["session/get", "session/open"]);
  assert.equal(again.calls[1].args[0], "s-1");
});

test("a chat deleted in the app is made again", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a] = folders(t, 1);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  store.rememberChat(SITE, "TASK-2026-00123", "PROJ-0002", "gone");
  const d = desktop({
    "session/get": () => {
      throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
    },
  });
  await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke });
  assert.deepEqual(d.ops(), ["session/get", "session/create", "session/open", "agent/prompt"]);
  assert.equal(store.chat(SITE, "TASK-2026-00123"), "s-1");
});

test("several folders become one project group, made once and kept up to date", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a, b] = folders(t, 2);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", b);
  const d = desktop();
  await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke });
  assert.equal(d.calls[0].operation, "project/groups/create");
  assert.deepEqual(d.calls[0].args[0], { name: "TBO · Alpha ERP", folders: [a, b] });
  assert.equal(store.groupId(SITE, "PROJ-0002"), "g-1");
  const later = desktop();
  await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: later.invoke });
  assert.deepEqual(later.calls[0], {
    operation: "project/groups/update",
    args: [{ groupId: "g-1", name: "TBO · Alpha ERP", folders: [a, b] }],
  });
});

test("a task TBO Support does not give, or one without a project, opens nothing", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const d = desktop();
  await assert.rejects(openTask({ task: "TASK-2026-00999", site: SITE, client: client(), store, invoke: d.invoke }), { code: "NOT_FOUND" });
  await assert.rejects(
    openTask({ task: "TASK-2026-00123", site: SITE, client: client({ ...TASK, project: null }), store, invoke: d.invoke }),
    { code: "NO_PROJECT" },
  );
  await assert.rejects(openTask({ task: "not a task", site: SITE, client: client(), store, invoke: d.invoke }), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(d.calls, []);
});

test("the task's brief names every folder and keeps the person in charge", () => {
  const brief = taskBrief(TASK, ["/a", "/b"]);
  assert.match(brief, /Its folders on this computer: \/a, \/b/);
  assert.match(brief, /wait for my go-ahead/);
  assert.doesNotMatch(brief, /<untrusted/);
});

// --- CodeRabbit round 1 on PR #27 ---

test("two opens of one task at once make one chat", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a] = folders(t, 1);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  const d = desktop();
  const both = await Promise.all([
    openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke }),
    openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke }),
  ]);
  assert.equal(both[0], both[1]);
  assert.equal(d.ops().filter((o) => o === "session/create").length, 1);
  assert.equal(d.ops().filter((o) => o === "agent/prompt").length, 1);
});

test("a task moved to another project gets a chat in that project's folders", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a, b] = folders(t, 2);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  store.addFolder(SITE, "PROJ-0009", "Beta ERP", b);
  store.rememberChat(SITE, "TASK-2026-00123", "PROJ-0002", "old-chat");
  store.markBriefed(SITE, "TASK-2026-00123");
  const d = desktop();
  await openTask({ task: "TASK-2026-00123", site: SITE, client: client({ ...TASK, project: "PROJ-0009", project_name: "Beta ERP" }), store, invoke: d.invoke });
  assert.deepEqual(d.ops(), ["session/create", "session/open", "agent/prompt"]);
  assert.equal(d.calls[0].args[0].projectPath, b);
  assert.equal(store.chatEntry(SITE, "TASK-2026-00123").project, "PROJ-0009");
});

test("only a chat the app says is gone is replaced; any other failure keeps the link", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a] = folders(t, 1);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  store.rememberChat(SITE, "TASK-2026-00123", "PROJ-0002", "kept");
  const d = desktop({
    "session/get": () => {
      throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    },
  });
  await assert.rejects(openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke }), /host unavailable/);
  assert.equal(store.chat(SITE, "TASK-2026-00123"), "kept");
  assert.deepEqual(d.ops(), ["session/get"]);
});

test("a first message the chat did not take is sent again, in the same chat, once", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a] = folders(t, 1);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  const failing = desktop({
    "agent/prompt": () => {
      throw new Error("the agent is busy");
    },
  });
  await assert.rejects(openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: failing.invoke }));
  const retry = desktop();
  const opened = await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: retry.invoke });
  assert.equal(opened.fresh, true);
  assert.deepEqual(retry.ops(), ["session/get", "session/open", "agent/prompt"]);
  assert.equal(retry.calls[1].args[0], "s-1"); // the chat made the first time
  const again = desktop();
  assert.equal((await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: again.invoke })).fresh, false);
  assert.deepEqual(again.ops(), ["session/get", "session/open"]);
});

test("a group kept from before follows its folders down to one", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a, b] = folders(t, 2);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", b);
  await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: desktop().invoke });
  store.removeFolder(SITE, "PROJ-0002", b);
  const d = desktop();
  await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke });
  assert.deepEqual(d.calls[0], { operation: "project/groups/update", args: [{ groupId: "g-1", name: "TBO · Alpha ERP", folders: [a] }] });
});
