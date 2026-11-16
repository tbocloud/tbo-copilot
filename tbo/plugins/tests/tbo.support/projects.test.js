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
    // as the app answers: a chat it has, with its id (a deleted one is { session: null })
    if (input.operation === "session/get") return { session: { id: input.args[0].id } };
    if (input.operation === "session/open") return { session: { id: input.args[0] } };
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
  // the app answers a deleted chat with { session: null } and no error (session-ipc's session/get);
  // a thrown "not found" is taken the same way
  const answers = {
    "no session": () => ({ session: null }),
    "a not-found error": () => {
      throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
    },
  };
  for (const [how, answer] of Object.entries(answers)) {
    const store = createProjectStore({ dataDir: tmp(t) });
    const [a] = folders(t, 1);
    store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
    store.rememberChat(SITE, "TASK-2026-00123", "PROJ-0002", "gone");
    store.markBriefed(SITE, "TASK-2026-00123");
    const d = desktop({ "session/get": answer });
    const opened = await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke });
    assert.deepEqual(d.ops(), ["session/get", "session/create", "session/open", "agent/prompt"], how);
    assert.equal(d.calls[2].args[0], "s-1", how); // the new chat is the one opened
    assert.equal(opened.sessionId, "s-1", how);
    assert.equal(store.chat(SITE, "TASK-2026-00123"), "s-1", how);
  }
});

test("a chat deleted between the check and the open is made again, once", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a] = folders(t, 1);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  store.rememberChat(SITE, "TASK-2026-00123", "PROJ-0002", "gone");
  store.markBriefed(SITE, "TASK-2026-00123");
  const notFound = () => Object.assign(new Error("Session not found"), { errorCode: "NOT_FOUND" });
  const d = desktop({
    "session/open": (input) => {
      if (input.args[0] === "gone") throw notFound(); // as session-ipc's session/open says it
      return { session: { id: input.args[0] } };
    },
  });
  const opened = await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke });
  assert.deepEqual(d.ops(), ["session/get", "session/open", "session/create", "session/open", "agent/prompt"]);
  assert.equal(opened.sessionId, "s-1");
  assert.equal(store.chat(SITE, "TASK-2026-00123"), "s-1");
  // a new chat the app cannot open either is not made a third time
  const never = desktop({
    "session/open": () => {
      throw notFound();
    },
  });
  store.rememberChat(SITE, "TASK-2026-00123", "PROJ-0002", "gone");
  await assert.rejects(openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: never.invoke }), /Session not found/);
  assert.deepEqual(never.ops(), ["session/get", "session/open", "session/create", "session/open"]);
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

// --- Phase 23, C2: a folder group the app refuses never stops the task from opening ---

// The app's own rules for groups (crates/host-core/src/db/project_groups.rs): a name of at most 80
// characters, a folder in one group only, and the folder first when the group was made stays in it.
function groupingApp(groups = new Map()) {
  let made = 0;
  const owner = (folder) => [...groups.entries()].find(([, g]) => g.folders.includes(folder));
  const checkName = (name) => {
    if (Array.from(name).length > 80) throw new Error("project group name exceeds 80 characters");
  };
  return desktop({
    "project/groups/create": ({ args: [{ name, folders: wanted }] }) => {
      checkName(name);
      for (const f of wanted) if (owner(f)) throw new Error(`folder already belongs to a project group: ${f}`);
      made += 1;
      const id = `g-new-${made}`;
      groups.set(id, { name, folders: wanted.slice() });
      return { group: { id } };
    },
    "project/groups/update": ({ args: [{ groupId, name, folders: wanted }] }) => {
      if (Array.from(name).length > 80) throw new Error("project group name is invalid");
      const group = groups.get(groupId);
      if (!group) throw new Error("project group not found");
      for (const f of wanted) {
        const other = owner(f);
        if (other && other[0] !== groupId) throw new Error(`folder already belongs to a project group: ${f}`);
      }
      if (!wanted.includes(group.folders[0])) throw new Error("the primary folder cannot be removed");
      group.folders = [group.folders[0], ...wanted.filter((f) => f !== group.folders[0])];
      group.name = name;
      return { group: { id: groupId } };
    },
  });
}

test("a folder that is already in another project's group: the task opens in the first folder, with a note", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [shared, a, b] = folders(t, 3);
  store.addFolder(SITE, "PROJ-0001", "Other ERP", shared);
  store.addFolder(SITE, "PROJ-0001", "Other ERP", b);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", shared);
  const app = groupingApp(new Map([["g-other", { name: "TBO · Other ERP", folders: [shared, b] }]]));
  for (const attempt of [1, 2]) {
    const opened = await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: app.invoke });
    assert.equal(opened.opened, true, `attempt ${attempt}`);
    assert.match(opened.note, new RegExp(`only ${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(opened.note, /another project/);
  }
  assert.equal(app.calls.find((c) => c.operation === "session/create").args[0].projectPath, a);
  assert.equal(store.groupId(SITE, "PROJ-0002"), null);
});

test("a group whose first folder was removed here: the task still opens, and the note names that folder", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a, b, c] = folders(t, 3);
  for (const f of [a, b, c]) store.addFolder(SITE, "PROJ-0002", "Alpha ERP", f);
  const app = groupingApp();
  await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: app.invoke });
  assert.equal(store.groupId(SITE, "PROJ-0002"), "g-new-1");
  store.removeFolder(SITE, "PROJ-0002", a);
  for (const attempt of [1, 2]) {
    const opened = await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: app.invoke });
    assert.equal(opened.opened, true, `attempt ${attempt}`);
    assert.ok(opened.note.includes(a), opened.note);
    // the app still has the old group: its id is kept, so adding the folder back mends it
    assert.equal(store.groupId(SITE, "PROJ-0002"), "g-new-1");
  }
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  const mended = await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: app.invoke });
  assert.equal(mended.note, undefined);
});

test("a long project name is cut to the app's 80 characters for the group", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a, b] = folders(t, 2);
  const long = `Alpha 😀 ${"Enterprise Resource Planning ".repeat(5)}`.trim();
  store.addFolder(SITE, "PROJ-0002", long, a);
  store.addFolder(SITE, "PROJ-0002", long, b);
  const app = groupingApp();
  const opened = await openTask({ task: "TASK-2026-00123", site: SITE, client: client({ ...TASK, project_name: long }), store, invoke: app.invoke });
  assert.equal(opened.note, undefined);
  const name = app.calls[0].args[0].name;
  assert.equal(Array.from(name).length, 80);
  assert.ok(name.startsWith("TBO · Alpha 😀 Enterprise"), name);
  assert.ok(name.endsWith("…"), name);
  assert.equal(store.groupId(SITE, "PROJ-0002"), "g-new-1");
});

test("a group deleted in the app is made again, and its new id kept only once it exists", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a, b] = folders(t, 2);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", b);
  store.setGroupId(SITE, "PROJ-0002", "g-deleted");
  const app = groupingApp();
  const opened = await openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: app.invoke });
  assert.deepEqual(app.ops().slice(0, 2), ["project/groups/update", "project/groups/create"]);
  assert.equal(opened.note, undefined);
  assert.equal(store.groupId(SITE, "PROJ-0002"), "g-new-1");
});

test("a settings change while the folders are grouped still stops the open", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a, b] = folders(t, 2);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", b);
  let current = true;
  const d = desktop({
    "project/groups/create": () => {
      current = false;
      throw new Error("folder already belongs to a project group: /x");
    },
  });
  await assert.rejects(
    openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke, stillCurrent: () => current }),
    { code: "STALE" },
  );
  assert.deepEqual(d.ops(), ["project/groups/create"]);
});

// --- CodeRabbit round 2 on PR #27 ---

test("a settings change while the task is read stops the open before anything in the app", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a, b] = folders(t, 2);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", b);
  let current = true;
  const slowClient = {
    method: async (p, args) => {
      current = false; // the person changes the site while TBO Support answers
      return client().method(p, args);
    },
  };
  const d = desktop();
  await assert.rejects(
    openTask({ task: "TASK-2026-00123", site: SITE, client: slowClient, store, invoke: d.invoke, stillCurrent: () => current }),
    { code: "STALE" },
  );
  assert.deepEqual(d.calls, []); // no group, no chat, no message
  assert.equal(store.chat(SITE, "TASK-2026-00123"), null);
});

test("a settings change between the app's steps stops the rest", async (t) => {
  const store = createProjectStore({ dataDir: tmp(t) });
  const [a] = folders(t, 1);
  store.addFolder(SITE, "PROJ-0002", "Alpha ERP", a);
  let current = true;
  const d = desktop({
    "session/create": () => {
      current = false;
      return { session: { id: "s-9" } };
    },
  });
  await assert.rejects(
    openTask({ task: "TASK-2026-00123", site: SITE, client: client(), store, invoke: d.invoke, stillCurrent: () => current }),
    { code: "STALE" },
  );
  assert.deepEqual(d.ops(), ["session/create"]); // never opened, never given the task
});

// --- Phase 23, C7: one rule for how a task ends ---

test("the brief, the skill and the tools give one ending: a closing pull request's merge completes the task", () => {
  const fsMod = require("node:fs");
  const pathMod = require("node:path");
  const { CHANGE_TOOL, ACTIONS } = require("../../tbo.support/lib/actions");
  const brief = taskBrief(TASK, ["/a"]);
  const skill = fsMod.readFileSync(pathMod.join(__dirname, "../../tbo.support/skills/work-on-a-task.md"), "utf8");
  const tool = CHANGE_TOOL.description.split("\n").find((l) => l.startsWith("- complete_task"));
  for (const [where, text] of [
    ["brief", brief],
    ["skill", skill],
    ["complete_task's text", tool],
  ]) {
    assert.match(text, /merge (of [^.]*)?completes (it|the task)/i, where);
    assert.match(text, /without a pull request/i, where);
  }
  // nothing tells the chat to complete a task by hand unconditionally
  assert.doesNotMatch(brief, /When the work is done, ask me how many hours I spent and complete the task/);
  assert.ok(typeof ACTIONS.start_task === "function");
});
