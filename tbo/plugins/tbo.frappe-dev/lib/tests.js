"use strict";

// Module tests on the developer's own bench: the test modules the branch touched (or the ones
// named), one `bench --site <site> run-tests --module <m>` each. Never the whole suite: CI runs that.

const fs = require("node:fs");
const path = require("node:path");
const { tail, fail } = require("./run");

const MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const SITE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const MAX_MODULES = 20;

function isBench(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, "sites")) && fs.existsSync(path.join(dir, "apps", "frappe"));
}

// The bench: the setting, or the folder that holds the repository as apps/<app>. A configured bench
// must hold this very checkout in its apps/ folder: the tests run the code the bench loads, and a
// result counts only for the commit it ran on.
function findBench(root, configured) {
  if (configured) {
    if (!isBench(configured)) throw fail("NO_BENCH", `"Frappe bench folder" (${configured}) is not a bench: it needs sites/ and apps/frappe.`);
    const apps = fs.realpathSync(path.join(configured, "apps"));
    if (path.dirname(fs.realpathSync(root)) !== apps) {
      throw fail("NO_BENCH", `The bench ${configured} runs the apps in its apps/ folder, and this repository (${root}) is not one of them: work in ${configured}/apps/<app>, or set the bench that holds it.`);
    }
    return configured;
  }
  const parent = path.dirname(root);
  if (path.basename(parent) === "apps" && isBench(path.dirname(parent))) return path.dirname(parent);
  return null;
}

function findSite(bench, configured) {
  const site = configured || readText(path.join(bench, "sites", "currentsite.txt"));
  if (!site) throw fail("NO_SITE", 'Set "Test site" in the plugin settings (a local site with the app installed and allow_tests on).');
  if (!SITE.test(site) || !fs.existsSync(path.join(bench, "sites", site))) throw fail("NO_SITE", `The test site "${site}" is not in ${bench}/sites.`);
  return site;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

const moduleOf = (file) => file.replace(/\.py$/, "").split("/").join(".");

// The test modules for the changed files: a changed test file; test_<name>.py beside a changed
// file; a DocType's own test for any file in its folder; tests/test_<name>.py in the package.
function testModules(root, changed) {
  const found = new Set();
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  for (const file of changed) {
    // a DocType's own test, for any file in its folder (its .json, .js or .py)
    const doctype = /^(.*\/doctype\/([a-z0-9_]+))\//.exec(`${file}`);
    if (doctype && exists(`${doctype[1]}/test_${doctype[2]}.py`)) found.add(`${doctype[1]}/test_${doctype[2]}.py`);
    if (!file.endsWith(".py")) continue;
    const dir = path.posix.dirname(file);
    const base = path.posix.basename(file, ".py");
    if (base.startsWith("test_")) {
      found.add(file);
      continue;
    }
    const beside = `${dir}/test_${base}.py`;
    if (exists(beside)) found.add(beside);
    const pkg = file.split("/")[0];
    if (exists(`${pkg}/tests/test_${base}.py`)) found.add(`${pkg}/tests/test_${base}.py`);
  }
  return [...found].sort().map(moduleOf);
}

function summary(output) {
  const ran = /Ran (\d+) tests?/.exec(output);
  const failed = /FAILED \(([^)]*)\)/.exec(output);
  return `${ran ? `${ran[1]} test(s)` : "tests"}${failed ? `, ${failed[1]}` : /\nOK\b/.test(output) ? ", OK" : ""}`;
}

// A module passed only when its tests ran to the end: at least one test, "OK", no failure. The exit
// code alone is not enough: without CI set, Frappe 15 exits 0 even when tests fail, and when
// testing is off for the site.
function completedOk(output) {
  const ran = /Ran (\d+) tests?/.exec(output);
  return Boolean(ran) && Number(ran[1]) > 0 && /(^|\n)OK\b/.test(output) && !/FAILED \(/.test(output);
}

// Test modules to run: at least one, at most 20, each a dotted Python module path.
function checkModules(modules) {
  if (!modules.length) throw fail("NO_TESTS", "No test modules: name them, or change code that has tests beside it.");
  if (modules.length > MAX_MODULES) throw fail("INVALID_ARGUMENT", `At most ${MAX_MODULES} modules a run; CI runs the whole suite.`);
  for (const m of modules) if (!MODULE.test(m)) throw fail("INVALID_ARGUMENT", `"${m}" is not a Python module path such as my_app.tests.test_invoices.`);
  return modules;
}

function createTests({ runFn, env, log = () => {} }) {
  // Runs each module in turn; stops at nothing, so every module's outcome is known.
  async function runModules({ bench, site, modules, benchCommand = "bench" }) {
    checkModules(modules);
    const results = [];
    for (const module of modules) {
      log(`tests: ${module}`);
      let res;
      try {
        res = await runFn(benchCommand, ["--site", site, "run-tests", "--module", module], { cwd: bench, env, timeoutMs: 1200000 });
      } catch (e) {
        results.push({ module, status: "failed", detail: e.message });
        break; // bench itself is missing: the other modules would fail the same way
      }
      const output = `${res.stdout}\n${res.stderr}`;
      let detail = summary(output);
      if (res.timedOut) detail = "took longer than 20 minutes";
      else if (/Testing is disabled/i.test(output)) detail = `testing is off on ${site}: run "bench --site ${site} set-config allow_tests true" once`;
      else if (/Ran 0 tests/.test(output)) detail = "no test ran: check the module path";
      const ok = res.code === 0 && !res.timedOut && completedOk(output);
      results.push({ module, status: ok ? "passed" : "failed", detail, output: ok ? "" : tail(output, 40) });
    }
    return { passed: results.every((r) => r.status === "passed"), site, results };
  }

  return { runModules };
}

module.exports = { createTests, checkModules, completedOk, findBench, findSite, testModules, isBench };
