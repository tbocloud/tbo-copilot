#!/usr/bin/env node
// Copies the TBO plugins this build ships into apps/desktop/resources/plugins,
// where the host registers bundled plugins on every launch.
//
// The plugins live in a private repository (scripts/tbo/bundled-plugins.json
// names it, the ref and the plugin folders). The copied folders are build
// inputs, ignored by git, like the rest of the release inputs.
//
//   node scripts/tbo/fetch-plugins.mjs                 clone the repository with your git credentials
//   node scripts/tbo/fetch-plugins.mjs --source <dir>  use an existing checkout (the release workflow)
//   --dest <dir>                                       copy somewhere else (tests)
//
// Only ids that start with "tbo." are accepted, so a TBO plugin can never
// replace one of upstream's bundled plugins.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = join(ROOT, "scripts", "tbo", "bundled-plugins.json");
const PLUGIN_ID = /^tbo\.[a-z0-9][a-z0-9._-]*$/;

export function readConfig(path = CONFIG) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (typeof config.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(config.repository)) {
    throw new Error(`${path}: "repository" must be "owner/name"`);
  }
  if (typeof config.ref !== "string" || !config.ref) {
    throw new Error(`${path}: "ref" must be a branch, tag or commit`);
  }
  if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
    throw new Error(`${path}: "plugins" must list at least one plugin folder`);
  }
  for (const id of config.plugins) {
    if (typeof id !== "string" || !PLUGIN_ID.test(id)) {
      throw new Error(`${path}: plugin "${id}" must be an id starting with "tbo."`);
    }
  }
  return config;
}

/** Copies each listed plugin folder from `source` to `dest/<id>`. */
export function bundlePlugins({ source, dest, plugins }) {
  const copied = [];
  for (const id of plugins) {
    const from = join(source, id);
    const manifestPath = join(from, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`plugin "${id}" has no manifest.json in ${source}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.id !== id) {
      throw new Error(`plugin folder "${id}" declares id "${manifest.id}"; they must match`);
    }
    const to = join(dest, id);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    copied.push(`${id}@${manifest.version}`);
  }
  return copied;
}

function cloneAt(repository, ref) {
  const dir = mkdtempSync(join(tmpdir(), "tbo-plugins-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
  git("init", "-q");
  git("remote", "add", "origin", `https://github.com/${repository}.git`);
  git("fetch", "-q", "--depth", "1", "origin", ref);
  git("checkout", "-q", "FETCH_HEAD");
  return dir;
}

function headCommit(dir) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const config = readConfig();
  const dest = resolve(option("--dest") ?? join(ROOT, "apps", "desktop", "resources", "plugins"));
  const given = option("--source");
  const source = given ? resolve(given) : cloneAt(config.repository, config.ref);
  try {
    const copied = bundlePlugins({ source, dest, plugins: config.plugins });
    console.log(
      `TBO plugins: bundled ${copied.join(", ")} from ${config.repository} (${config.ref}, ${headCommit(source)}).`,
    );
  } finally {
    if (!given) rmSync(source, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
