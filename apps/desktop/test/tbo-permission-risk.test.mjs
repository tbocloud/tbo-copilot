// TBO Copilot Phase 21 (security review, docs/tbo/security.md): the install dialog never shows a
// permission as safer than the permissions matrix rates it, and provider.register, which the
// bundled tbo.support plugin uses, is high risk in the dialog and in the devkit's check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

const ORDER = { low: 0, medium: 1, high: 2 };

function matrix() {
  const doc = read("docs/spec/07-plugins/13-plugin-permissions-matrix.md");
  return [...doc.matchAll(/^\| `([a-zA-Z.]+)` \| (high|medium|low) \|/gm)].map((m) => [m[1], m[2]]);
}

function dialogRisk() {
  const model = read("apps/desktop/src/features/plugins/model.ts");
  const start = model.indexOf("export const PERMISSION_RISK");
  const body = model.slice(start, model.indexOf("};", start));
  const risk = {};
  for (const m of body.matchAll(/^\s+"?([a-zA-Z.]+)"?: "(high|medium|low)",/gm)) risk[m[1]] = m[2];
  // permissionRisk(): a permission the table does not list is shown as high
  return (permission) => risk[permission] ?? "high";
}

function devkitHighRisk() {
  const check = read("packages/plugin-devkit/src/check.ts");
  const start = check.indexOf("export const HIGH_RISK_PERMISSIONS");
  return [...check.slice(start, check.indexOf("] as const", start)).matchAll(/"([a-zA-Z.]+)"/g)].map((m) => m[1]);
}

test("the matrix still has its permission rows", () => {
  assert.ok(matrix().length >= 30, "the permissions matrix table was not found");
});

test("the install dialog never shows a permission as safer than the matrix rates it", () => {
  const shown = dialogRisk();
  const lower = matrix().filter(([permission, tier]) => ORDER[shown(permission)] < ORDER[tier]);
  assert.deepEqual(lower, []);
});

test("provider.register is high risk in the dialog, by name, and in the devkit", () => {
  assert.match(read("apps/desktop/src/features/plugins/model.ts"), /^\s+"provider\.register": "high",$/m);
  assert.ok(devkitHighRisk().includes("provider.register"));
});
