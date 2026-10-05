import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { bundlePlugins, readConfig } = await import("../../../scripts/tbo/fetch-plugins.mjs");

function plugin(root, folder, manifest, files = {}) {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

test("the shipped config bundles tbo.theme from the private plugins repository", () => {
  const config = readConfig();
  assert.equal(config.repository, "tbocloud/tbo-copilot-plugins");
  assert.ok(config.ref.length > 0);
  assert.deepEqual(config.plugins, ["tbo.theme"]);
});

test("listed plugins are copied whole, replacing an older copy", () => {
  const root = mkdtempSync(join(tmpdir(), "tbo-fetch-"));
  try {
    const source = join(root, "source");
    const dest = join(root, "dest");
    plugin(source, "tbo.theme", { id: "tbo.theme", version: "1.0.0" }, { "themes/tbo-dark.css": ":root{}" });
    plugin(source, "tbo.other", { id: "tbo.other", version: "1.0.0" });
    mkdirSync(join(dest, "tbo.theme"), { recursive: true });
    writeFileSync(join(dest, "tbo.theme", "stale.txt"), "old");

    const copied = bundlePlugins({ source, dest, plugins: ["tbo.theme"] });

    assert.deepEqual(copied, ["tbo.theme@1.0.0"]);
    assert.equal(readFileSync(join(dest, "tbo.theme", "themes", "tbo-dark.css"), "utf8"), ":root{}");
    assert.equal(existsSync(join(dest, "tbo.theme", "stale.txt")), false);
    assert.equal(existsSync(join(dest, "tbo.other")), false, "only listed plugins are bundled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a folder whose manifest id differs, or that has no manifest, is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "tbo-fetch-"));
  try {
    const source = join(root, "source");
    plugin(source, "tbo.theme", { id: "pi.browser", version: "1.0.0" });
    assert.throws(() => bundlePlugins({ source, dest: join(root, "dest"), plugins: ["tbo.theme"] }), /declares id "pi\.browser"/);
    assert.throws(() => bundlePlugins({ source, dest: join(root, "dest"), plugins: ["tbo.missing"] }), /no manifest\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the config only accepts tbo.* plugin ids, so upstream's bundled plugins cannot be replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "tbo-fetch-"));
  try {
    const write = (config) => {
      const path = join(root, "config.json");
      writeFileSync(path, JSON.stringify(config));
      return path;
    };
    const base = { repository: "tbocloud/tbo-copilot-plugins", ref: "main" };
    assert.throws(() => readConfig(write({ ...base, plugins: ["pi.browser"] })), /must be an id starting with "tbo\."/);
    assert.throws(() => readConfig(write({ ...base, plugins: ["tbo.theme/../x"] })), /must be an id starting with "tbo\."/);
    assert.throws(() => readConfig(write({ ...base, plugins: [] })), /at least one plugin/);
    assert.throws(() => readConfig(write({ ...base, repository: "not a repo", plugins: ["tbo.theme"] })), /owner\/name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
