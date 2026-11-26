import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkReferences, citedDoctypes, citedFiles } from "./references.js";

let root = "";
let apps: Record<string, string> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "refs-"));
  const app = join(root, "acme");
  mkdirSync(join(app, "acme", "doctype", "acme_order"), { recursive: true });
  writeFileSync(join(app, "acme", "hooks.py"), "a = 1\nb = 2\nc = 3\n");
  writeFileSync(join(app, "acme", "doctype", "acme_order", "acme_order.json"), "{}");
  apps = { acme: app };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("what a report cites", () => {
  it("finds file paths with their lines, once each, and no web addresses", () => {
    const cited = citedFiles({
      summary: "The hook in acme/hooks.py:2 is wrong; see `acme/hooks.py:2` and https://example.com/a/b.py",
      evidence: [{ type: "code", ref: "acme/api/orders.py", note: "also apps/acme/acme/hooks.py" }],
    });
    expect(cited).toEqual([{ path: "acme/hooks.py", line: 2 }, { path: "acme/api/orders.py" }, { path: "apps/acme/acme/hooks.py" }]);
  });

  it("takes doctypes only from evidence that names one", () => {
    expect(citedDoctypes({ summary: "Sales Invoice is fine", evidence: [{ type: "DocType", ref: "Acme Order" }, { type: "log", ref: "x" }] })).toEqual(["Acme Order"]);
  });
});

describe("checking them against the code", () => {
  it("passes what exists, under the app's name or the bench's path", () => {
    const result = checkReferences({ summary: "acme/hooks.py:3 and apps/acme/acme/hooks.py", evidence: [{ type: "doctype", ref: "Acme Order" }] }, apps);
    expect(result).toEqual({ checked: 3, missing: [] });
  });

  it("reports a missing file, a line past the end and an unknown doctype", () => {
    const result = checkReferences(
      { summary: "acme/gone.py is the cause, at acme/hooks.py:99", evidence: [{ type: "doctype", ref: "Acme Ghost" }] },
      apps,
    );
    expect(result.checked).toBe(3);
    expect(result.missing).toEqual([
      { kind: "file", value: "acme/gone.py" },
      { kind: "line", value: "acme/hooks.py:99" },
      { kind: "doctype", value: "Acme Ghost" },
    ]);
  });

  it("never leaves the checkout, and checks nothing without one", () => {
    expect(checkReferences({ summary: "see ../../etc/passwd.txt and acme/../../x.py" }, apps).missing.every((m) => m.kind === "file")).toBe(true);
    expect(checkReferences({ summary: "acme/hooks.py" }, {})).toEqual({ checked: 0, missing: [] });
  });
});
