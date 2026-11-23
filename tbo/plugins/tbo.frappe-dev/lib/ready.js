"use strict";

// The readiness check (TBO Copilot Phase 27, Q3): everything a task's work needs, checked at once,
// before the work starts. On 21 Nov 2026 a task ran five hours because the test site, the bench's
// services, the GitHub CLI, uv and a site in maintenance were found one at a time. Each item says
// what is wrong and how to put it right; the plugin can do the two safe fixes on the developer's own
// dev site (`fix`), each after the app asks; the rest are steps for the person.
//
// Items: the GitHub CLI and its login, uv, the bench and its command, the bench's services
// (MariaDB, Redis), the project's test site, maintenance mode, and the site's setup. All but the
// last two must pass before work starts; those two are warnings.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { tail } = require("./run");
const { testsOn } = require("./sites");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Whether something listens at host:port, within `timeoutMs`.
function tcpProbe(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// host and port of a redis://host:port address, or null.
function redisAddress(url) {
  const m = /^redis:\/\/([^:/]+):(\d+)/.exec(String(url || ""));
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

const item = (id, ok, detail, extra = {}) => ({ id, ok, detail, blocking: extra.blocking !== false, ...(extra.fix ? { fix: extra.fix } : {}) });
const manual = (steps) => ({ kind: "person", steps });
const auto = (fix, site, steps) => ({ kind: "tbo_dev fix", fix, ...(site ? { site } : {}), steps });

function createReady({ runFn, env, probe = tcpProbe }) {
  // The bench's services: MariaDB at db_host/db_port (a site may name its own host), Redis at the
  // addresses in common_site_config.json.
  async function services(bench, site) {
    const common = readJson(path.join(bench, "sites", "common_site_config.json"));
    const own = site ? readJson(path.join(bench, "sites", site, "site_config.json")) : {};
    const dbHost = own.db_host || common.db_host || "127.0.0.1";
    const dbPort = Number(own.db_port || common.db_port || 3306);
    const host = dbHost === "localhost" ? "127.0.0.1" : dbHost;
    const down = [];
    if (!(await probe(host, dbPort))) down.push(`MariaDB (${dbHost}:${dbPort})`);
    for (const key of ["redis_cache", "redis_queue"]) {
      const at = redisAddress(common[key]);
      if (at && !(await probe(at.host, at.port))) down.push(`Redis ${key.replace("redis_", "")} (${at.host}:${at.port})`);
    }
    if (!down.length) return item("services", true, "MariaDB and the bench's Redis answer");
    return item("services", false, `Not answering: ${down.join(", ")}`, {
      fix: manual(
        `Start the bench's services: in a terminal, \`cd ${bench} && bench start\`, and keep it open${down.some((d) => d.startsWith("MariaDB")) ? "; start MariaDB too (on a Mac: `brew services start mariadb`)" : ""}. Then check again.`,
      ),
    });
  }

  // The bench command runs in the bench folder.
  async function benchCommand(bench, command) {
    try {
      const res = await runFn(command, ["--version"], { cwd: bench, env, timeoutMs: 30000 });
      if (res.code === 0) return item("bench_command", true, `${command} ${String(res.stdout || "").trim().split("\n").pop()}`);
      return item("bench_command", false, `\`${command} --version\` failed: ${tail(`${res.stdout}\n${res.stderr}`, 3)}`, {
        fix: manual('Set "bench command" in the plugin settings to the bench program (in a terminal: `which bench`).'),
      });
    } catch {
      return item("bench_command", false, `The bench program "${command}" was not found.`, {
        fix: manual('Set "bench command" in the plugin settings to the bench program (in a terminal: `which bench`).'),
      });
    }
  }

  // Maintenance mode, for the site or the whole bench: the site shows 503 in a browser.
  function maintenance(bench, site) {
    const common = readJson(path.join(bench, "sites", "common_site_config.json"));
    const own = site ? readJson(path.join(bench, "sites", site, "site_config.json")) : {};
    const where = [];
    if (Number(own.maintenance_mode) === 1) where.push(`the site ${site}`);
    if (Number(common.maintenance_mode) === 1) where.push("every site of the bench (common_site_config.json)");
    if (!where.length) return item("maintenance", true, "Not in maintenance", { blocking: false });
    return item("maintenance", false, `In maintenance mode: ${where.join(" and ")}; the site answers 503 in a browser`, {
      blocking: false,
      fix: auto("maintenance_off", site, "tbo_dev fix maintenance_off turns it off (the app asks first)."),
    });
  }

  // The site's setup wizard: an app's tests that create documents (an invoice, an item) need its
  // company and country.
  async function setup(bench, site, command) {
    let done = false;
    try {
      const res = await runFn(command, ["--site", site, "execute", "frappe.is_setup_complete"], { cwd: bench, env, timeoutMs: 60000 });
      done = res.code === 0 && /\btrue\b/i.test(String(res.stdout || ""));
    } catch {
      done = false;
    }
    if (done) return item("site_setup", true, `${site}'s setup is complete`, { blocking: false });
    return item("site_setup", false, `${site}'s setup wizard was never finished (no company or country): tests that create documents may fail`, {
      blocking: false,
      fix: manual(`Open ${site} in a browser, log in as Administrator and finish the setup wizard (company, country, currency). Then check again.`),
    });
  }

  // A site of the bench, named in the settings or the bench's default, that has tests off.
  function testsOffSite(bench, listed) {
    const fallback = (() => {
      try {
        return fs.readFileSync(path.join(bench, "sites", "currentsite.txt"), "utf8").trim();
      } catch {
        return "";
      }
    })();
    for (const site of [...listed, fallback].filter(Boolean)) {
      if (fs.existsSync(path.join(bench, "sites", site, "site_config.json")) && !testsOn(bench, site)) return site;
    }
    return "";
  }

  /**
   * Everything checked at once. `gh` and `uv` come from dev.js (the login check and the uv lookup);
   * `chooseSite` is lib/sites.js's choice for this project.
   */
  async function check({ bench, benchProblem = "", conf, gh, uv, chooseSite }) {
    const items = [];
    items.push(
      gh && gh.ok
        ? item("github", true, `GitHub CLI signed in${gh.login ? ` as ${gh.login}` : ""}`)
        : item("github", false, gh && gh.hint ? gh.hint : "The GitHub CLI is missing or not signed in.", {
            fix: manual('Install the GitHub CLI (https://cli.github.com) and run `gh auth login` in a terminal; if it is installed but not found, set "GitHub CLI location".'),
          }),
    );
    items.push(
      uv
        ? item("uv", true, uv)
        : item("uv", false, "uv was not found; the linters run through it.", {
            fix: manual('Install uv (https://docs.astral.sh/uv/) or set "uv location" (in a terminal: `which uv`; prefer the real program, not a pyenv shim).'),
          }),
    );
    if (!bench) {
      items.push(
        item("bench", false, benchProblem || "No Frappe bench holds this repository.", {
          fix: manual('Open the app inside its bench (<bench>/apps/<app>), or add the bench to "Frappe bench folder".'),
        }),
      );
      return summary(items);
    }
    items.push(item("bench", true, bench));
    const command = await benchCommand(bench, conf.benchCommand);
    items.push(command);
    let site = "";
    try {
      const chosen = await chooseSite();
      site = chosen.site;
      items.push(item("test_site", true, `${site} (${chosen.from})`));
    } catch (e) {
      const off = testsOffSite(bench, conf.testSites);
      items.push(
        item("test_site", false, e.message, {
          fix: off ? auto("allow_tests", off, `tbo_dev fix allow_tests turns tests on for ${off} (the app asks first).`) : manual(e.message.split("\n").pop()),
        }),
      );
    }
    items.push(await services(bench, site));
    items.push(maintenance(bench, site));
    if (site && command.ok) items.push(await setup(bench, site, conf.benchCommand));
    return summary(items);
  }

  return { check };
}

function summary(items) {
  const blocking = items.filter((i) => !i.ok && i.blocking);
  const warnings = items.filter((i) => !i.ok && !i.blocking);
  return {
    ready: blocking.length === 0,
    items,
    next: blocking.length
      ? `${blocking.length} thing(s) must be put right before work starts; tell the person all of them at once, with their fixes.`
      : warnings.length
        ? "Ready to work; tell the person about the warnings and their fixes."
        : "Ready to work.",
  };
}

// The list as text, for a refusal.
function describe(result) {
  return result.items
    .filter((i) => !i.ok)
    .map((i) => `- ${i.id}${i.blocking ? "" : " (warning)"}: ${i.detail}${i.fix ? `\n  Fix: ${i.fix.steps}` : ""}`)
    .join("\n");
}

module.exports = { createReady, describe, tcpProbe, redisAddress };
