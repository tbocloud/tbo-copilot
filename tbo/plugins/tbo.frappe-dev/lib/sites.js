"use strict";

// The test site for each project (testing fixes 8). One set of plugin settings serves every project
// on the computer, so the site is chosen per repository, in this order:
// 1. the site chosen for this repository before (remembered in the plugin's data folder);
// 2. the first site of the "Test site" list that is on the project's bench, has tests on and has
//    the project's app installed;
// 3. the bench's default site (`bench use`), checked the same way.
// A site named in a call (run_tests or status `site`) is checked the same way and remembered for the
// repository. A choice made from the list or the default is remembered with the settings it came
// from, so changing the list chooses again. Checking runs `bench --site <site> list-apps`, which only
// reads; a remembered site is not checked again.

const fs = require("node:fs");
const path = require("node:path");
const { tail, fail } = require("./run");
const { SITE, readText } = require("./tests");

const FILE = "test-sites.json";
const CHOSEN = "chosen for this project";
const LISTED = "from your Test site list";
const DEFAULT = "the bench's default site";
// colour codes bench may print around a site's name
const COLOR = /\u001b\[[0-9;]*m/g;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// A site of the bench: its folder with its site_config.json (sites/assets is not one).
function onBench(bench, site) {
  return SITE.test(site) && fs.existsSync(path.join(bench, "sites", site, "site_config.json"));
}

// Frappe reads allow_tests from the site's config, else the bench's common config.
function testsOn(bench, site) {
  const own = readJson(path.join(bench, "sites", site, "site_config.json")) || {};
  if (Object.hasOwn(own, "allow_tests")) return Boolean(own.allow_tests);
  const common = readJson(path.join(bench, "sites", "common_site_config.json")) || {};
  return Boolean(common.allow_tests);
}

// The name the bench gives this checkout: its folder (or link) in the bench's apps/.
function appOf(bench, root) {
  const apps = path.join(bench, "apps");
  const real = fs.realpathSync(root);
  if (path.dirname(real) === fs.realpathSync(apps)) return path.basename(real);
  for (const name of fs.readdirSync(apps)) {
    try {
      if (fs.realpathSync(path.join(apps, name)) === real) return name;
    } catch {
      // a broken link
    }
  }
  return path.basename(real);
}

function createSites({ runFn, env, getDataPath, log = () => {} }) {
  let kept = {}; // repository -> { bench, site, from, basis }, as last read from the data folder

  async function file() {
    return path.join(await getDataPath(), FILE);
  }

  // Read every time: a small file, and the one place the choice lives.
  async function load() {
    const saved = readJson(await file());
    kept = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    return kept;
  }

  // Written whole, through a new file renamed over the old one, so a crash never leaves half of it.
  async function save() {
    const target = await file();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const next = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(next, `${JSON.stringify(kept, null, 2)}\n`);
      fs.renameSync(next, target);
    } catch (e) {
      log(`tbo_dev: could not keep the test site choice (${e.message})`);
    }
  }

  // The apps installed on a site, or why they could not be listed.
  async function installed(bench, site, benchCommand) {
    let res;
    try {
      res = await runFn(benchCommand, ["--site", site, "list-apps"], { cwd: bench, env, timeoutMs: 90000 });
    } catch (e) {
      return { error: `bench could not run (${e.message})` };
    }
    if (res.timedOut) return { error: "listing its apps took too long" };
    if (res.code !== 0) return { error: `listing its apps failed: ${tail(`${res.stdout}\n${res.stderr}`, 3)}` };
    const apps = new Set(
      String(res.stdout || "")
        .replace(COLOR, "")
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean),
    );
    return { apps };
  }

  // Why a site does not fit the project, or "" when it does.
  async function misfit(bench, site, app, benchCommand) {
    if (!onBench(bench, site)) return `not a site of ${bench}`;
    if (!testsOn(bench, site)) return `tests are off (bench --site ${site} set-config allow_tests true)`;
    const found = await installed(bench, site, benchCommand);
    if (found.error) return found.error;
    if (!found.apps.has(app)) return `${app} is not installed (bench --site ${site} install-app ${app})`;
    return "";
  }

  async function remember(root, entry) {
    (await load())[root] = entry;
    await save();
  }

  // { site, from, remembered, note }: the test site for the repository `root` on `bench`.
  async function choose({ root, bench, listed = [], wanted = "", benchCommand = "bench" }) {
    const key = fs.realpathSync(root);
    const app = appOf(bench, root);
    const asked = String(wanted || "").trim();
    if (asked) {
      const why = await misfit(bench, asked, app, benchCommand);
      if (why) throw fail("NO_SITE", `${asked} cannot be the test site for ${app}: ${why}.`);
      await remember(key, { bench, site: asked, from: CHOSEN, basis: null });
      return { site: asked, from: CHOSEN, remembered: false };
    }

    const fallback = readText(path.join(bench, "sites", "currentsite.txt"));
    const basis = JSON.stringify([listed, fallback]);
    const before = (await load())[key];
    let note;
    if (before && before.bench === bench) {
      const stillThere = onBench(bench, before.site);
      if (stillThere && (before.basis === null || before.basis === basis)) {
        return { site: before.site, from: before.from, remembered: true };
      }
      if (!stillThere) note = `${before.site}, the test site before, is no longer a site of this bench; chose again.`;
    }

    const tried = [];
    const seen = new Set();
    const candidates = [...listed.map((site) => [site, LISTED]), ...(fallback ? [[fallback, DEFAULT]] : [])];
    for (const [site, from] of candidates) {
      if (seen.has(site)) continue;
      seen.add(site);
      // a listed site of another bench is for another project: no bench call for it
      const why = onBench(bench, site) ? await misfit(bench, site, app, benchCommand) : "not on this bench";
      if (!why) {
        await remember(key, { bench, site, from, basis });
        return { site, from, remembered: false, ...(note ? { note } : {}) };
      }
      tried.push(`${site}: ${why}`);
    }
    if (before && before.bench === bench) {
      delete kept[key];
      await save();
    }
    const looked = tried.length ? `:\n- ${tried.join("\n- ")}` : ': "Test site" is empty and the bench has no default site.';
    throw fail(
      "NO_SITE",
      `No test site fits ${app} on ${bench}${looked}\nAdd a local site with ${app} installed and allow_tests on to "Test site" in the plugin settings (several, separated by commas), or name one for this project (site).`,
    );
  }

  return { choose };
}

module.exports = { createSites, appOf, testsOn, CHOSEN, LISTED, DEFAULT };
