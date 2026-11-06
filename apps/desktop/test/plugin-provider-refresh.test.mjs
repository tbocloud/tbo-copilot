import { readAppSourceSync, readMainSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ADR 0319: a plugin that sets its provider's key or endpoint after sign-in
// makes the renderer refresh its provider list, so the model picker offers the
// provider without a restart. A refused write throws before the event is sent.

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const protocol = readFileSync(
  join(desktopRoot, "../../packages/shared/src/protocol.ts"),
  "utf8",
);
const api = readFileSync(join(desktopRoot, "src/lib/api.ts"), "utf8");
const app = readAppSourceSync();
const main = readMainSourceSync();

test("plugin provider writes use a renderer refresh event", () => {
  assert.match(protocol, /providersChanged:\s*"pi-desktop\/providers\/event\/changed"/);
  assert.match(api, /onProvidersChanged:/);
  assert.match(api, /IPC\.event\.providersChanged/);
  assert.match(app, /const offProvidersChanged = api\.onProvidersChanged/);
  assert.match(app, /refreshProviders\(\)/);
  assert.match(app, /offProvidersChanged\(\);/);
  // sent only after the host accepted the write
  assert.match(
    main,
    /const result = await getHost\(\)!\.call\(method, \{ \.\.\.input, pluginId \}\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*sendToRenderer\(IPC\.event\.providersChanged/,
  );
});
