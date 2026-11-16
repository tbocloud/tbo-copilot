import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/updater-module-stubs.mjs")));

// TBO Copilot turns updates on only in a signed release build: the release
// workflow bakes "tboUpdates": "enabled" into the packaged package.json.
delete process.env.TBO_UPDATES;

const {
  resolveDefaultUpdatePreference,
  resolveUpdateMode,
  setTboUpdatesBuildFlag,
  supportsAutomaticUpdates,
  tboUpdatesEnabled,
} = await import("../electron/main/update-policy.ts");
const { AppUpdaterController } = await import("../electron/main/updater.ts");
const updaterSource = await readFile(new URL("../electron/main/updater.ts", import.meta.url), "utf8");

function withGate({ flag, env }, run) {
  const previous = process.env.TBO_UPDATES;
  setTboUpdatesBuildFlag(flag);
  if (env === undefined) delete process.env.TBO_UPDATES;
  else process.env.TBO_UPDATES = env;
  try {
    run();
  } finally {
    setTboUpdatesBuildFlag(undefined);
    if (previous === undefined) delete process.env.TBO_UPDATES;
    else process.env.TBO_UPDATES = previous;
  }
}

test("a packaged build without the release flag never checks for updates", () => {
  withGate({}, () => {
    assert.equal(tboUpdatesEnabled(), false);
    for (const platform of ["darwin", "win32"]) {
      assert.equal(supportsAutomaticUpdates(platform, true, {}), false);
      assert.equal(resolveUpdateMode(platform, true, {}), "disabled");
      assert.equal(resolveDefaultUpdatePreference(platform, true, {}, "installed"), "manual");
    }
    assert.equal(
      resolveUpdateMode("linux", true, { APPIMAGE: "/tmp/app.AppImage" }),
      "disabled",
    );
  });
});

test("a signed release build updates in the app; Windows ZIP and portable only notify", () => {
  withGate({ flag: "enabled" }, () => {
    assert.equal(tboUpdatesEnabled(), true);
    assert.equal(resolveUpdateMode("darwin", true, {}), "in-app");
    assert.equal(resolveUpdateMode("win32", true, {}, "installed"), "in-app");
    assert.equal(resolveUpdateMode("win32", true, {}, "zip"), "manual");
    assert.equal(resolveUpdateMode("win32", true, {}, "portable"), "manual");
  });
});

test("only the exact value enabled turns updates on", () => {
  for (const flag of ["true", true, "Enabled", "on", 1, null]) {
    withGate({ flag }, () => {
      assert.equal(resolveUpdateMode("darwin", true, {}), "disabled", String(flag));
    });
  }
  // The environment switch is for tests and development only.
  withGate({ env: "true" }, () => {
    assert.equal(resolveUpdateMode("darwin", true, {}), "disabled");
  });
  withGate({ env: "enabled" }, () => {
    assert.equal(resolveUpdateMode("darwin", true, {}), "in-app");
  });
});

test("development runs stay disabled whatever the flag says", () => {
  withGate({ flag: "enabled" }, () => {
    assert.equal(resolveUpdateMode("darwin", false, {}), "disabled");
  });
  withGate({}, () => {
    assert.equal(resolveUpdateMode("darwin", false, {}), "disabled");
  });
});

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;
  async checkForUpdates() {
    return null;
  }
}

function createController(isPackaged) {
  return new AppUpdaterController({
    logger: { app: () => {} },
    send: () => {},
    currentVersion: "0.16.1",
    platform: "darwin",
    isPackaged,
    autoUpdater: new FakeUpdater(),
  });
}

async function inAppDirectory(packageJson, run) {
  // The Electron stub answers app.getAppPath() with the working directory.
  const previous = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "tbo-update-flag-"));
  await writeFile(join(directory, "package.json"), JSON.stringify(packageJson));
  process.chdir(directory);
  try {
    return await run();
  } finally {
    process.chdir(previous);
    setTboUpdatesBuildFlag(undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

test("the updater reads the release flag from the packaged package.json", async () => {
  await inAppDirectory({ name: "@pi-desktop/desktop", tboUpdates: "enabled" }, () => {
    assert.equal(createController(true).getState().mode, "in-app");
  });
  await inAppDirectory({ name: "@pi-desktop/desktop" }, () => {
    assert.equal(createController(true).getState().mode, "disabled");
  });
  // The flag is read before the first mode is resolved.
  assert.match(
    updaterSource,
    /setTboUpdatesBuildFlag\(this\.readPackagedTboUpdates\(isPackaged\)\);[\s\S]*?resolveUpdateModePolicy\(/,
  );
});

test("Check for Updates explains an update-less packaged build without calling it a development build", async () => {
  await inAppDirectory({ name: "@pi-desktop/desktop" }, async () => {
    await assert.rejects(createController(true).check({ manual: true }), (error) => {
      assert.match(error.message, /^Updates are off in this build\./);
      assert.doesNotMatch(error.message, /development/);
      return true;
    });
    await assert.rejects(
      createController(false).check({ manual: true }),
      /updates are disabled in development builds/,
    );
  });
});
