"use strict";

// Runs one program with an argument list, never through a shell, in a folder, within a time
// limit. Output is kept up to a cap (the tail survives), so a chatty linter cannot fill memory.

const { spawn } = require("node:child_process");

const MAX_OUTPUT = 200000;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function keep(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
}

// Resolves { code, stdout, stderr, timedOut }; rejects only when the program cannot start
// (MISSING: not installed or not on PATH).
function run(command, args, { cwd, env = process.env, timeoutMs = 60000, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      reject(fail("MISSING", `${command} could not start: ${e.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout = keep(stdout, d.toString());
    });
    child.stderr.on("data", (d) => {
      stderr = keep(stderr, d.toString());
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(fail("MISSING", e.code === "ENOENT" ? `${command} is not installed or not on PATH.` : `${command} could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// The last lines of a program's output, for a short report.
function tail(text, lines = 25) {
  const all = String(text || "").trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

module.exports = { run, tail, fail };
