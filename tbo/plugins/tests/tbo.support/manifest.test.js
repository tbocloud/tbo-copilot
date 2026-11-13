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

test("every skill exists with a name and a short description", () => {
  assert.equal(manifest.contributes.skills.length, 4);
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
    "agent.prompt.inject", // the four AWS skills
    "agent.tool.register",
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
  assert.deepEqual(provider.models.map((m) => m.id), ["tbo-default"]);
});
