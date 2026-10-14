#!/usr/bin/env node
// Copies the TBO plugins this build ships into apps/desktop/resources/plugins,
// where the host registers bundled plugins on every launch.
//
// The plugins live in this repository, in tbo/plugins/
// (scripts/tbo/bundled-plugins.json names the folder and the plugins to ship).
// The copied folders are build inputs, ignored by git, like the rest of the
// release inputs.
//
//   node scripts/tbo/fetch-plugins.mjs                 copy from tbo/plugins/ (the release workflow)
//   node scripts/tbo/fetch-plugins.mjs --source <dir>  copy from another folder
//   --dest <dir>                                       copy somewhere else (tests)
//
// Only ids that start with "tbo." are accepted, so a TBO plugin can never
// replace one of upstream's bundled plugins.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = join(ROOT, "scripts", "tbo", "bundled-plugins.json");
const PLUGIN_ID = /^tbo\.[a-z0-9][a-z0-9._-]*$/;

export function readConfig(path = CONFIG) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof config.source !== "string" ||
    !config.source ||
    isAbsolute(config.source) ||
    normalize(config.source).split(sep).includes("..")
  ) {
    throw new Error(`${path}: "source" must be a folder inside the repository, e.g. "tbo/plugins"`);
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
  const source = given ? resolve(given) : join(ROOT, config.source);
  const copied = bundlePlugins({ source, dest, plugins: config.plugins });
  console.log(
    `TBO plugins: bundled ${copied.join(", ")} from ${given ? source : config.source} (commit ${headCommit(ROOT)}).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
