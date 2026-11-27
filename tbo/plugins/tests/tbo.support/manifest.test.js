"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../../tbo.support/manifest.json");
const fs = require("node:fs");
const path = require("node:path");
const { TOOL, CHANGE_TOOL } = require("../../tbo.support/lib/actions");
const { AWS_TOOL } = require("../../tbo.support/lib/aws");

const pick = (t) => ({ name: t.name, description: t.description, risk: t.risk, planSafeActions: t.planSafeActions, schema: t.schema });

test("the manifest's three tools match the code's tools exactly", () => {
  assert.deepEqual(manifest.contributes.agentTools.map(pick), [pick(TOOL), pick(CHANGE_TOOL), pick(AWS_TOOL)]);
});

test("TBO AI's models: only the four levels set on TBO Support's AI models page, Medium first", () => {
  const ai = manifest.contributes.providers.find((p) => p.id === "tbo-ai");
  assert.deepEqual(
    ai.models.map((m) => [m.id, m.name]),
    [
      ["tbo-medium", "TBO AI · Medium"],
      ["tbo-simple", "TBO AI · Simple"],
      ["tbo-hard", "TBO AI · Hard"],
      ["tbo-very-hard", "TBO AI · Very hard"],
    ],
  );
  // every level takes pictures, so each level's model and backup must read them (the owner, 27 Nov 2026)
  for (const m of ai.models) assert.equal(m.supportsImages, true, m.id);
});

test("TBO AI no longer offers the plain TBO AI row (tbo-default): only the levels (the owner, 27 Nov 2026)", () => {
  const [provider] = manifest.contributes.providers;
  assert.equal(provider.models.find((m) => m.id === "tbo-default"), undefined);
});

test("every skill exists with a name and a short description", () => {
  assert.equal(manifest.contributes.skills.length, 5); // four AWS skills and the task skill (Phase 22)
  for (const file of manifest.contributes.skills) {
    const text = fs.readFileSync(path.join(__dirname, "../../tbo.support", file), "utf8");
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
    assert.ok(front, `${file} has no front matter`);
    assert.ok(front[2].length <= 240, `${file}'s description is ${front[2].length} characters`);
  }
});

test("AWS changes are off by default and no setting holds a key", () => {
  const settings = Object.fromEntries(manifest.contributes.settings.map((s) => [s.key, s]));
  assert.equal(settings.awsAllowChanges.default, false);
  assert.equal(settings.awsAllowChanges.type, "boolean");
  assert.equal(settings.awsRegion.default, "ap-south-1");
  for (const s of manifest.contributes.settings) {
    assert.equal(s.secret, undefined, s.key);
    assert.doesNotMatch(s.key, /key|secret|token|password/i, s.key);
  }
});

test("the plugin asks only for the permissions it uses", () => {
  assert.deepEqual([...manifest.permissions].sort(), [
    "agent.prompt.inject", // the AWS skills and the task skill
    "agent.tool.register",
    "desktop.control", // a task's chat and its project's folder group (Phase 22)
    "fs.read", // the folder picker for a project's folders (Phase 22)
    "net.fetch",
    "provider.register",
    "shell.openExternal",
    "ui.panel",
  ]);
});

test("the plugin may reach only the default site, the demo hub, the TBO AI gateway and a local test bench", () => {
  const setting = manifest.contributes.settings.find((s) => s.key === "siteUrl");
  assert.deepEqual(manifest.net.domains, [
    new URL(setting.default).hostname,
    "demo-tbo.tbocloud.in",
    "copilot-gateway.tbocloud.in", // TBO AI's endpoint only, never a TBO Support address
    "localhost",
    "*.localhost",
    "127.0.0.1",
  ]);
  assert.equal(setting.secret, undefined);
});

test("the plugin id starts with tbo. so the TBO build accepts it", () => {
  assert.match(manifest.id, /^tbo\./);
});

test("TBO AI is declared without an address: the sign-in sets it", () => {
  const [provider] = manifest.contributes.providers;
  assert.equal(manifest.contributes.providers.length, 1);
  assert.equal(provider.id, "tbo-ai");
  assert.equal(provider.baseUrl, undefined);
  assert.equal(provider.authKind, "api_key");
  // the first model is the app's default for a new chat (host-core takes the declared order)
  assert.equal(provider.models[0].id, "tbo-medium");
});

test("TBO AI no longer offers tbo-deepseek: Bedrock is off (the owner, 26 Nov 2026)", () => {
  const [provider] = manifest.contributes.providers;
  assert.equal(provider.models.find((m) => m.id === "tbo-deepseek"), undefined);
});
