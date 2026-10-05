import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  resolveDefaultUpdatePreference,
  resolveUpdateMode,
  supportsAutomaticUpdates,
  tboUpdatesEnabled,
} = await import("../electron/main/update-policy.ts");

function withTboUpdates(value, run) {
  const previous = process.env.TBO_UPDATES;
  if (value === undefined) delete process.env.TBO_UPDATES;
  else process.env.TBO_UPDATES = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.TBO_UPDATES;
    else process.env.TBO_UPDATES = previous;
  }
}

test("TBO Copilot packaged builds never check for updates by default", () => {
  withTboUpdates(undefined, () => {
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

test("only the exact value enabled restores upstream update behaviour", () => {
  withTboUpdates("true", () => {
    assert.equal(resolveUpdateMode("darwin", true, {}), "disabled");
  });
  withTboUpdates("enabled", () => {
    assert.equal(tboUpdatesEnabled(), true);
    assert.equal(resolveUpdateMode("darwin", true, {}), "in-app");
    assert.equal(resolveUpdateMode("win32", true, {}, "portable", "manual"), "manual");
  });
});

test("development builds stay disabled whether or not TBO updates are enabled", () => {
  withTboUpdates("enabled", () => {
    assert.equal(resolveUpdateMode("darwin", false, {}), "disabled");
  });
  withTboUpdates(undefined, () => {
    assert.equal(resolveUpdateMode("darwin", false, {}), "disabled");
  });
});
