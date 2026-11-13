import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("the shipped config bundles tbo.theme and tbo.support from tbo/plugins in this repository", () => {
  const config = readConfig();
  assert.equal(config.source, "tbo/plugins");
  assert.deepEqual(config.plugins, ["tbo.theme", "tbo.support"]);
  const root = mkdtempSync(join(tmpdir(), "tbo-fetch-"));
  try {
    const source = fileURLToPath(new URL(`../../../${config.source}`, import.meta.url));
    const copied = bundlePlugins({ source, dest: root, plugins: config.plugins });
    assert.match(copied[0], /^tbo\.theme@\d+\.\d+\.\d+/);
    assert.match(copied[1], /^tbo\.support@\d+\.\d+\.\d+/);
    assert.ok(existsSync(join(root, "tbo.theme", "manifest.json")));
    assert.ok(existsSync(join(root, "tbo.support", "manifest.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("the config only accepts tbo.* plugin ids and a folder inside the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "tbo-fetch-"));
  try {
    const write = (config) => {
      const path = join(root, "config.json");
      writeFileSync(path, JSON.stringify(config));
      return path;
    };
    const base = { source: "tbo/plugins" };
    assert.throws(() => readConfig(write({ ...base, plugins: ["pi.browser"] })), /must be an id starting with "tbo\."/);
    assert.throws(() => readConfig(write({ ...base, plugins: ["tbo.theme/../x"] })), /must be an id starting with "tbo\."/);
    assert.throws(() => readConfig(write({ ...base, plugins: [] })), /at least one plugin/);
    assert.throws(() => readConfig(write({ source: "../plugins", plugins: ["tbo.theme"] })), /inside the repository/);
    assert.throws(() => readConfig(write({ source: "/tmp/plugins", plugins: ["tbo.theme"] })), /inside the repository/);
    assert.throws(() => readConfig(write({ source: "tbo/../../x", plugins: ["tbo.theme"] })), /inside the repository/);
    assert.throws(() => readConfig(write({ plugins: ["tbo.theme"] })), /inside the repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// TBO Copilot Phase 21 (docs/tbo/security.md): the copy that ships cannot reach this computer.
test("the shipped copy's net.domains loses local hosts; the source folder keeps them", async () => {
  const { isLocalHost } = await import("../../../scripts/tbo/fetch-plugins.mjs");
  for (const host of ["localhost", "LOCALHOST", "tbo.localhost", "*.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "0.0.0.0"]) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of ["teams.teambackoffice.com", "localhost.example.com", "*.tbocloud.in", "10.0.0.1", "128.0.0.1"]) {
    assert.equal(isLocalHost(host), false, host);
  }
  const root = mkdtempSync(join(tmpdir(), "tbo-fetch-"));
  try {
    const source = join(root, "source");
    const dest = join(root, "dest");
    const domains = ["teams.teambackoffice.com", "localhost", "*.localhost", "127.0.0.1"];
    plugin(source, "tbo.support", { id: "tbo.support", version: "1.0.0", permissions: ["net.fetch"], net: { domains } });
    plugin(source, "tbo.theme", { id: "tbo.theme", version: "1.0.0" });

    const copied = bundlePlugins({ source, dest, plugins: ["tbo.support", "tbo.theme"] });

    assert.deepEqual(copied, ["tbo.support@1.0.0 (without localhost, *.localhost, 127.0.0.1)", "tbo.theme@1.0.0"]);
    const shipped = JSON.parse(readFileSync(join(dest, "tbo.support", "manifest.json"), "utf8"));
    assert.deepEqual(shipped.net.domains, ["teams.teambackoffice.com"]);
    assert.deepEqual(shipped.permissions, ["net.fetch"]);
    assert.deepEqual(JSON.parse(readFileSync(join(source, "tbo.support", "manifest.json"), "utf8")).net.domains, domains);
    // a manifest without local hosts is copied byte for byte
    assert.equal(readFileSync(join(dest, "tbo.theme", "manifest.json"), "utf8"), readFileSync(join(source, "tbo.theme", "manifest.json"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no plugin this build ships can reach this computer", () => {
  const config = readConfig();
  const root = mkdtempSync(join(tmpdir(), "tbo-fetch-"));
  try {
    const source = fileURLToPath(new URL(`../../../${config.source}`, import.meta.url));
    bundlePlugins({ source, dest: root, plugins: config.plugins });
    for (const id of config.plugins) {
      const manifest = JSON.parse(readFileSync(join(root, id, "manifest.json"), "utf8"));
      const local = (manifest.net?.domains ?? []).filter((d) => /localhost|^127\.|^\[?::1\]?$|^0\.0\.0\.0$/i.test(d));
      assert.deepEqual(local, [], id);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
