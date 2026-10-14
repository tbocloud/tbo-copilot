"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../../tbo.support/manifest.json");
const { TOOL } = require("../../tbo.support/lib/actions");

test("the manifest tool matches the code's tool exactly", () => {
  const [declared] = manifest.contributes.agentTools;
  assert.equal(manifest.contributes.agentTools.length, 1);
  assert.deepEqual(
    { name: declared.name, description: declared.description, risk: declared.risk, planSafeActions: declared.planSafeActions, schema: declared.schema },
    { name: TOOL.name, description: TOOL.description, risk: TOOL.risk, planSafeActions: TOOL.planSafeActions, schema: TOOL.schema },
  );
});

test("the plugin asks only for the permissions it uses", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["agent.tool.register", "net.fetch", "ui.panel"]);
});

test("the plugin may reach only the default site and a local test bench", () => {
  const setting = manifest.contributes.settings.find((s) => s.key === "siteUrl");
  assert.deepEqual(manifest.net.domains, [new URL(setting.default).hostname, "localhost", "*.localhost", "127.0.0.1"]);
  assert.equal(setting.secret, undefined);
});

test("the plugin id starts with tbo. so the TBO build accepts it", () => {
  assert.match(manifest.id, /^tbo\./);
});
