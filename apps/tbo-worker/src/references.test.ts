import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkReferences, citedDoctypes, citedFiles, siteAppNames } from "./references.js";

let root = "";
let apps: Record<string, string> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "refs-"));
  const app = join(root, "acme");
  mkdirSync(join(app, "acme", "doctype", "acme_order"), { recursive: true });
  writeFileSync(join(app, "acme", "hooks.py"), "a = 1\nb = 2\nc = 3\n");
  writeFileSync(join(app, "acme", "doctype", "acme_order", "acme_order.json"), "{}");
  writeFileSync(join(app, "acme", "empty.py"), "");
  // outside the checkout: a file and an app folder with a doctype, each reached by a link inside it
  writeFileSync(join(root, "outside.py"), "x = 1\n");
  mkdirSync(join(root, "elsewhere", "doctype", "ghost_type"), { recursive: true });
  symlinkSync(join(root, "outside.py"), join(app, "acme", "linked_out.py"));
  symlinkSync(join(app, "acme", "hooks.py"), join(app, "acme", "linked_in.py"));
  symlinkSync(join(root, "elsewhere"), join(app, "acme", "elsewhere"));
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

  it("reads a .json path whole, with its line", () => {
    expect(citedFiles({ summary: "see acme/doctype/acme_order/acme_order.json:12 and acme/x.js:3" })).toEqual([
      { path: "acme/doctype/acme_order/acme_order.json", line: 12 },
      { path: "acme/x.js", line: 3 },
    ]);
  });

  it("takes doctypes only from evidence that names one", () => {
    expect(citedDoctypes({ summary: "Sales Invoice is fine", evidence: [{ type: "DocType", ref: "Acme Order" }, { type: "log", ref: "x" }] })).toEqual(["Acme Order"]);
  });
});

describe("checking them against the code", () => {
  it("passes what exists, under the app's name or the bench's path", () => {
    const result = checkReferences(
      { summary: "acme/hooks.py:3 and apps/acme/acme/hooks.py", evidence: [{ type: "doctype", ref: "Acme Order" }] },
      apps,
      ["acme"],
    );
    expect(result).toEqual({ checked: 3, missing: [] });
  });

  it("reports a missing file, a line past the end and an unknown doctype", () => {
    const result = checkReferences(
      { summary: "acme/gone.py is the cause, at acme/hooks.py:99", evidence: [{ type: "doctype", ref: "Acme Ghost" }] },
      apps,
      ["acme"],
    );
    expect(result.checked).toBe(3);
    expect(result.missing).toEqual([
      { kind: "file", value: "acme/gone.py" },
      { kind: "line", value: "acme/hooks.py:99" },
      { kind: "doctype", value: "Acme Ghost" },
    ]);
  });

  it("counts lines as an editor does: a last line break adds none, an empty file has none", () => {
    const result = checkReferences({ summary: "acme/hooks.py:3, acme/hooks.py:4 and acme/empty.py:1" }, apps);
    expect(result.missing).toEqual([
      { kind: "line", value: "acme/hooks.py:4" },
      { kind: "line", value: "acme/empty.py:1" },
    ]);
  });

  it("follows a link only while it stays inside the checkout", () => {
    const result = checkReferences(
      { summary: "acme/linked_in.py:2 and acme/linked_out.py:1", evidence: [{ type: "doctype", ref: "Ghost Type" }] },
      apps,
      ["acme"],
    );
    expect(result.missing).toEqual([
      { kind: "file", value: "acme/linked_out.py" },
      { kind: "doctype", value: "Ghost Type" },
    ]);
  });

  it("checks doctypes only when every app of the site is checked out", () => {
    const cites = { evidence: [{ type: "doctype", ref: "Sales Invoice" }] };
    expect(checkReferences(cites, apps)).toEqual({ checked: 0, missing: [] });
    expect(checkReferences(cites, apps, ["frappe", "erpnext", "acme"])).toEqual({ checked: 0, missing: [] });
    expect(checkReferences(cites, apps, ["acme"])).toEqual({ checked: 1, missing: [{ kind: "doctype", value: "Sales Invoice" }] });
  });

  it("takes the site's apps from the run context's site card, once each", () => {
    expect(siteAppNames({ site: { apps: [{ app: "frappe" }, { app: "erpnext" }, { app: "frappe" }, { app: " " }] } })).toEqual(["frappe", "erpnext"]);
    expect(siteAppNames({ site: { apps: [] } })).toBeUndefined();
    expect(siteAppNames({ site: null })).toBeUndefined();
    expect(siteAppNames({})).toBeUndefined();
  });

  it("never leaves the checkout, and checks nothing without one", () => {
    expect(checkReferences({ summary: "see ../../etc/passwd.txt and acme/../../x.py" }, apps).missing.every((m) => m.kind === "file")).toBe(true);
    expect(checkReferences({ summary: "acme/hooks.py" }, {})).toEqual({ checked: 0, missing: [] });
  });
});
