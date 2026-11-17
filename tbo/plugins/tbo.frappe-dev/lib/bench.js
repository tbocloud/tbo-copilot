"use strict";

// The developer's own bench, for what a change needs after it is written: migrate (a DocType's JSON,
// a patch, fixtures), build (JavaScript and CSS) and clear_cache. Only these three, each a fixed
// argument list; a site or app named in the call must exist in the bench and can never be read as an
// option. Nothing that opens a console, drops, reinstalls or restores a site is run, and no option
// such as --force is ever passed.

const fs = require("node:fs");
const path = require("node:path");
const { tail, fail } = require("./run");
const { findSite } = require("./tests");

const MINUTES = 60000;
const APP = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;

// What each command takes (a site or an app), its time limit and its argument list.
const COMMANDS = {
  migrate: { takes: "site", timeoutMs: 20 * MINUTES, argv: ({ site }) => ["--site", site, "migrate"] },
  build: { takes: "app", timeoutMs: 20 * MINUTES, argv: ({ app }) => (app ? ["build", "--app", app] : ["build"]) },
  clear_cache: { takes: "site", timeoutMs: 5 * MINUTES, argv: ({ site }) => ["--site", site, "clear-cache"] },
};
const NAMES = Object.keys(COMMANDS);

// A site of this bench: the one named, else the test site. "all" means every site to bench, and a
// folder such as sites/assets is not a site: a site has its site_config.json.
function benchSite(bench, wanted) {
  const site = findSite(bench, wanted);
  if (site === "all" || !fs.existsSync(path.join(bench, "sites", site, "site_config.json"))) {
    throw fail("NO_SITE", `"${site}" is not a site in ${bench}/sites.`);
  }
  return site;
}

function benchApp(bench, app) {
  let isDir = false;
  try {
    isDir = APP.test(app) && fs.statSync(path.join(bench, "apps", app)).isDirectory();
  } catch {
    // not there
  }
  if (!isDir) throw fail("INVALID_ARGUMENT", `"${app}" is not an app in ${bench}/apps.`);
  return app;
}

// The command line for a call, checked before anything runs.
function benchCall(bench, args, testSite) {
  const command = String((args && args.command) || "");
  if (!Object.hasOwn(COMMANDS, command)) {
    throw fail("INVALID_ARGUMENT", `bench runs only ${NAMES.join(", ")}. Never console, drop-site, reinstall, restore or any option such as --force.`);
  }
  const spec = COMMANDS[command];
  const site = args.site === undefined || args.site === null ? "" : String(args.site).trim();
  const app = args.app === undefined || args.app === null ? "" : String(args.app).trim();
  const call = { command, timeoutMs: spec.timeoutMs };
  if (spec.takes === "site") {
    if (app) throw fail("INVALID_ARGUMENT", `${command} runs on a site; it takes no app.`);
    call.site = benchSite(bench, site || testSite);
  } else {
    if (site) throw fail("INVALID_ARGUMENT", `${command} builds the bench's assets; it takes no site.`);
    if (app) call.app = benchApp(bench, app);
  }
  call.argv = spec.argv(call);
  call.line = `bench ${call.argv.join(" ")}`;
  return call;
}

// Runs the call in the bench folder. It passes only when bench exits 0 within its time, with no Python
// traceback in its output.
async function runBench({ runFn, env, log = () => {} }, { bench, call, benchCommand = "bench" }) {
  log(`bench: ${call.line}`);
  const res = await runFn(benchCommand, call.argv, { cwd: bench, env, timeoutMs: call.timeoutMs });
  const output = `${res.stdout}\n${res.stderr}`;
  const traceback = /Traceback \(most recent call last\)/.test(output);
  const passed = res.code === 0 && !res.timedOut && !traceback;
  let detail = "done";
  if (res.timedOut) detail = `took longer than ${call.timeoutMs / MINUTES} minutes`;
  else if (res.code !== 0) detail = `exit code ${res.code}`;
  else if (traceback) detail = "a Python traceback in its output";
  const result = { passed, command: call.line, detail, output: tail(output, passed ? 5 : 40) };
  if (call.site) result.site = call.site;
  if (call.app) result.app = call.app;
  return result;
}

module.exports = { benchCall, runBench, BENCH_COMMANDS: NAMES };
