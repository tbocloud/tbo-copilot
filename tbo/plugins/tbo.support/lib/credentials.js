"use strict";

// Keeps the person's TBO Support API key in the operating system's credential
// store. PI-Desktop does not offer plugins a secret store yet (plugin settings
// may not hold secrets, D018), so this file is the plugin's one use of
// child_process. Commands are fixed; the secret only ever travels on stdin.

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const SERVICE = "tbo-copilot.tbo-support";
const DPAPI_FILE = "credentials.dpapi";
const KEY_PART = /^[A-Za-z0-9]{6,64}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input || "");
  });
}

function checkCredentials({ key, secret }) {
  if (!KEY_PART.test(String(key || "")) || !KEY_PART.test(String(secret || ""))) {
    throw fail("INVALID_ARGUMENT", "The API key and secret should be letters and digits only. Copy them again from TBO Support.");
  }
}

function checkHost(host) {
  if (!HOST.test(String(host || ""))) throw fail("INVALID_ARGUMENT", `Not a valid site host: ${host}`);
}

function split(value) {
  const [key, secret] = String(value || "").trim().split(":");
  return key && secret ? { key, secret } : null;
}

// macOS: the login Keychain through `security -i`, which reads its commands
// from stdin, so the secret is never part of a command line.
function macStore(runner) {
  return {
    async save(host, creds) {
      checkHost(host);
      checkCredentials(creds);
      const line = `add-generic-password -U -s ${SERVICE} -a ${host} -w ${creds.key}:${creds.secret}\n`;
      const r = await runner("/usr/bin/security", ["-i"], line);
      if (r.code !== 0 || /error/i.test(r.stderr)) {
        throw fail("SECRET_STORE", "Could not save the key in the macOS Keychain.");
      }
    },
    async load(host) {
      checkHost(host);
      const r = await runner("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", host, "-w"], "");
      if (r.code !== 0) return null;
      return split(r.stdout);
    },
    async remove(host) {
      checkHost(host);
      await runner("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", host], "");
    },
  };
}

// Windows: DPAPI through PowerShell, encrypted for the signed-in Windows user,
// kept in the plugin's private data folder.
const PS_PROTECT =
  "$s=[Console]::In.ReadToEnd().Trim();" +
  "ConvertTo-SecureString -String $s -AsPlainText -Force | ConvertFrom-SecureString";
const PS_UNPROTECT =
  "$b=[Console]::In.ReadToEnd().Trim();" +
  "$p=ConvertTo-SecureString -String $b;" +
  "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p))";
const PS = ["-NoProfile", "-NonInteractive", "-Command"];

function windowsStore(runner, dataDir, files) {
  const fileFor = (host) => path.join(dataDir, `${host}.${DPAPI_FILE}`);
  return {
    async save(host, creds) {
      checkHost(host);
      checkCredentials(creds);
      const r = await runner("powershell.exe", [...PS, PS_PROTECT], `${creds.key}:${creds.secret}`);
      const blob = r.stdout.trim();
      if (r.code !== 0 || !blob) throw fail("SECRET_STORE", "Could not encrypt the key with Windows DPAPI.");
      await files.mkdir(dataDir, { recursive: true });
      await files.writeFile(fileFor(host), blob, { mode: 0o600 });
    },
    async load(host) {
      checkHost(host);
      let blob;
      try {
        blob = (await files.readFile(fileFor(host), "utf8")).trim();
      } catch {
        return null;
      }
      const r = await runner("powershell.exe", [...PS, PS_UNPROTECT], blob);
      if (r.code !== 0) return null;
      return split(r.stdout);
    },
    async remove(host) {
      checkHost(host);
      await files.rm(fileFor(host), { force: true });
    },
  };
}

function createStore({ platform = process.platform, runner = run, dataDir, files = fs } = {}) {
  if (platform === "darwin") return macStore(runner);
  if (platform === "win32") {
    if (!dataDir) throw fail("SECRET_STORE", "No data folder for the Windows key file.");
    return windowsStore(runner, dataDir, files);
  }
  const unsupported = async () => {
    throw fail("UNSUPPORTED", "Saving the TBO Support key is supported on macOS and Windows only.");
  };
  return { save: unsupported, load: async () => null, remove: unsupported };
}

module.exports = { createStore, SERVICE, PS_PROTECT, PS_UNPROTECT };
