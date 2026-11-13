"use strict";

// Runs one program with an argument list, never through a shell, in a folder, within a time
// limit. Output is kept up to a cap (the tail survives), so a chatty linter cannot fill memory.
// At the time limit the whole process tree is stopped (a process group on macOS and Linux,
// taskkill /T on Windows) and the call ends even if a stray process still holds the output open.

const { spawn } = require("node:child_process");

const MAX_OUTPUT = 200000;
const KILL_GRACE_MS = 3000;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function keep(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
}

// Stops the program and everything it started.
function killTree(child, signal, { platform = process.platform, spawnFn = spawn } = {}) {
  if (!child.pid) return;
  try {
    if (platform === "win32") {
      spawnFn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } else {
      process.kill(-child.pid, signal); // the group the child leads (spawned detached)
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

// Resolves { code, stdout, stderr, timedOut }; rejects only when the program cannot start
// (MISSING: not installed or not on PATH).
function run(command, args, { cwd, env = process.env, timeoutMs = 60000, spawnFn = spawn, platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // its own process group on macOS and Linux, so a time-out can stop the whole tree
      child = spawnFn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: platform !== "win32" });
    } catch (e) {
      reject(fail("MISSING", `${command} could not start: ${e.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let grace = null;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM", { platform, spawnFn });
      grace = setTimeout(() => {
        killTree(child, "SIGKILL", { platform, spawnFn });
        // a descendant may still hold the pipes open: the call ends here all the same
        settle(() => resolve({ code: null, stdout, stderr, timedOut: true }));
      }, KILL_GRACE_MS);
      if (grace.unref) grace.unref();
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout = keep(stdout, d.toString());
    });
    child.stderr.on("data", (d) => {
      stderr = keep(stderr, d.toString());
    });
    child.on("error", (e) => {
      settle(() =>
        reject(fail("MISSING", e.code === "ENOENT" ? `${command} is not installed or not on PATH.` : `${command} could not start: ${e.message}`)),
      );
    });
    child.on("close", (code) => {
      settle(() => resolve({ code, stdout, stderr, timedOut }));
    });
  });
}

// The last lines of a program's output, for a short report.
function tail(text, lines = 25) {
  const all = String(text || "").trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

module.exports = { run, tail, fail, killTree };
