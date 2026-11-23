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

// Whether something listens at host:port (or at the unix socket `host` when no port is given),
// within `timeoutMs`; an address that cannot be tried is not answering.
function tcpProbe(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = net.connect(port === undefined ? { path: host } : { host, port });
    } catch {
      resolve(false);
      return;
    }
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// host and port of a redis:// or rediss:// address (with or without user:password@ and a database),
// or { unsupported } for any other form, such as a unix socket or an address with no host. Never
// the credentials: a host never holds an @ (CodeRabbit on #34).
function redisAddress(url) {
  const m = /^(rediss?):\/\/(?:[^/]*@)?(\[[^\]@/]+\]|[^:/?#@[\]]+)(?::(\d+))?(?:[/?#].*)?$/i.exec(String(url || "").trim());
  if (!m) {
    // only a plain scheme name is shown (unix, redis+sentinel…); anything else could be part of a
    // password, so it is never echoed (CodeRabbit on #34)
    const scheme = /^([a-z][a-z0-9+.-]{0,15}):\/\//i.exec(String(url || "").trim());
    return { unsupported: scheme ? scheme[1].toLowerCase() : "unrecognised" };
  }
  return { host: m[2].replace(/^\[|\]$/g, ""), port: Number(m[3] || 6379) };
}

const validPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;

const item = (id, ok, detail, extra = {}) => ({ id, ok, detail, blocking: extra.blocking !== false, ...(extra.fix ? { fix: extra.fix } : {}) });
const manual = (steps) => ({ kind: "person", steps });
const auto = (fix, site, steps) => ({ kind: "tbo_dev fix", fix, ...(site ? { site } : {}), steps });

function createReady({ runFn, env, probe = tcpProbe }) {
  // The services as Frappe itself connects to them (frappe.get_site_config, v15 and v16): an
  // environment override first (FRAPPE_DB_TYPE, FRAPPE_DB_SOCKET, FRAPPE_DB_HOST, FRAPPE_DB_PORT,
  // FRAPPE_REDIS_CACHE, FRAPPE_REDIS_QUEUE, from the environment bench commands get), then the
  // site's own setting over the bench's common one, then Frappe's default.
  function effectiveConfig(bench, site) {
    const common = readJson(path.join(bench, "sites", "common_site_config.json"));
    const own = site ? readJson(path.join(bench, "sites", site, "site_config.json")) : {};
    const conf = { ...common, ...own };
    const from = (name, key, fallback) => (env && env[name]) || conf[key] || fallback;
    const dbType = String(from("FRAPPE_DB_TYPE", "db_type", "mariadb"));
    return {
      dbType,
      dbSocket: from("FRAPPE_DB_SOCKET", "db_socket", ""),
      dbHost: String(from("FRAPPE_DB_HOST", "db_host", "127.0.0.1")),
      dbPort: Number(from("FRAPPE_DB_PORT", "db_port", dbType === "postgres" ? 5432 : 3306)),
      redis: [
        ["cache", from("FRAPPE_REDIS_CACHE", "redis_cache", "redis://127.0.0.1:13311")],
        ["queue", from("FRAPPE_REDIS_QUEUE", "redis_queue", "redis://127.0.0.1:11311")],
      ],
    };
  }

  // Whether a service answers; a probe that fails is a service that does not.
  async function answers(...target) {
    try {
      return Boolean(await probe(...target));
    } catch {
      return false;
    }
  }

  // The bench's services: the database server (MariaDB or PostgreSQL; SQLite has none) and Redis.
  async function services(bench, site) {
    const c = effectiveConfig(bench, site);
    const down = [];
    let database = "";
    if (c.dbType === "mariadb" || c.dbType === "postgres") {
      database = c.dbType === "postgres" ? "PostgreSQL" : "MariaDB";
      if (c.dbSocket) {
        if (!(await answers(String(c.dbSocket)))) down.push(`${database} (socket ${c.dbSocket})`);
      } else if (!validPort(c.dbPort)) {
        down.push(`${database} (${c.dbHost}: the port is not a valid port number)`);
      } else if (!(await answers(c.dbHost === "localhost" ? "127.0.0.1" : c.dbHost, c.dbPort))) {
        down.push(`${database} (${c.dbHost}:${c.dbPort})`);
      }
    }
    for (const [key, url] of c.redis) {
      const at = redisAddress(url);
      const name = `Redis ${key}`;
      // an address the check cannot reach is said, never taken as answering (CodeRabbit on #34)
      if (at.unsupported) down.push(`${name} (a ${at.unsupported} address this check cannot reach; check it yourself)`);
      else if (!validPort(at.port)) down.push(`${name} (${at.host}: the port is not a valid port number)`);
      else if (!(await answers(at.host, at.port))) down.push(`${name} (${at.host}:${at.port})`);
    }
    if (!down.length) return item("services", true, `${database ? `${database} and ` : ""}the bench's Redis answer`);
    const databaseDown = database && down.some((d) => d.startsWith(database));
    return item("services", false, `Not answering: ${down.join(", ")}`, {
      fix: manual(
        `Start the bench's services: in a terminal, \`cd ${bench} && bench start\`, and keep it open${databaseDown ? `; start ${database} too (on a Mac: \`brew services start ${database === "MariaDB" ? "mariadb" : "postgresql"}\`)` : ""}. Then check again.`,
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
      // the remembered site that no longer fits, else a listed or default one with tests off
      const off = e.site && !testsOn(bench, e.site) ? e.site : testsOffSite(bench, conf.testSites);
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
