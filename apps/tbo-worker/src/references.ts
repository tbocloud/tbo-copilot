// Which of the things an investigation cites really exist (Phase 31, TBO Support's AI models).
// The worker program checks this itself, after the model has written its report: the files it
// names against the checked-out code, a cited line against the file's length, and a doctype
// against the apps' doctype folders. It costs no AI tokens, and its result is sent beside the
// report: {checked, missing: [{kind, value}]}. Only what can be checked is counted.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export type MissingReference = { kind: "file" | "line" | "doctype"; value: string };
export type ReferenceCheck = { checked: number; missing: MissingReference[] };

// json before js, and no letter after the extension: "x.json:12" is x.json at line 12, never x.js
const FILE = /(?:^|[\s"'`(\[<])((?:[\w.-]+\/)+[\w.-]+\.(?:py|json|js|ts|vue|html|css|scss|txt|md|yml|yaml|toml|sql|jinja|csv))(?!\w)(?::(\d+))?/g;
const MAX_REFERENCES = 60;
const MAX_MISSING = 30;
const MAX_FILE_BYTES = 2_000_000;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out);
  return out;
}

/** The file paths (with a line, when one is given) the report names anywhere in its words. */
export function citedFiles(report: Record<string, unknown>): { path: string; line?: number }[] {
  const found = new Map<string, { path: string; line?: number }>();
  const texts = strings([report.summary, report.evidence, report.proposal, report.customer_message]);
  for (const text of texts) {
    for (const match of text.matchAll(FILE)) {
      const path = match[1];
      if (path.includes("://") || path.startsWith("//")) continue;
      const line = match[2] ? Number(match[2]) : undefined;
      const key = `${path}:${line ?? ""}`;
      if (!found.has(key)) found.set(key, { path, ...(line ? { line } : {}) });
      if (found.size >= MAX_REFERENCES) return [...found.values()];
    }
  }
  return [...found.values()];
}

/**
 * The site's apps from the run context: the site card's list, which TBO Support refreshes from the
 * site itself before a run. Unknown (no card, or an empty list): undefined, and doctypes go unchecked.
 */
export function siteAppNames(context: { site?: { apps?: Array<{ app?: string | null }> } | null }): string[] | undefined {
  const names = (context.site?.apps ?? []).map((row) => (row.app ?? "").trim()).filter(Boolean);
  return names.length ? [...new Set(names)] : undefined;
}

/** The doctypes the evidence names as such: [{type: "doctype", ref: "Sales Invoice"}]. */
export function citedDoctypes(report: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const item of Array.isArray(report.evidence) ? report.evidence : []) {
    if (!item || typeof item !== "object") continue;
    const { type, ref } = item as { type?: unknown; ref?: unknown };
    if (typeof type === "string" && type.toLowerCase() === "doctype" && typeof ref === "string" && ref.trim()) {
      names.add(ref.trim());
    }
  }
  return [...names].slice(0, MAX_REFERENCES);
}

/** Where a cited path may be inside an app's checkout: as written, or without "apps/<app>/". */
function candidates(path: string, app: string): string[] {
  const clean = normalize(path).replace(/^(\.\/)+/, "");
  if (clean.startsWith("..") || clean.startsWith(sep)) return [];
  const out = [clean];
  const parts = clean.split(sep);
  if (parts[0] === "apps" && parts[1] === app) out.push(parts.slice(2).join(sep));
  if (parts[0] === app) out.push(parts.slice(1).join(sep));
  return out.filter(Boolean);
}

/** Whether `target` is `root` or below it. */
function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/** A checkout's own path with its links followed (the checkout itself may sit behind a link). */
function canonical(dir: string): string | undefined {
  try {
    return realpathSync(dir);
  } catch {
    return undefined;
  }
}

/** `path` with its links followed, when that stays inside the checkout `root` (itself resolved). */
function within(root: string, path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return inside(root, real) ? real : undefined;
  } catch {
    return undefined;
  }
}

function findFile(path: string, apps: Record<string, string>): string | undefined {
  for (const [app, dir] of Object.entries(apps)) {
    const root = canonical(dir);
    if (!root) continue;
    for (const candidate of candidates(path, app)) {
      const full = join(dir, candidate);
      if (!inside(dir, full) || !existsSync(full)) continue;
      // a link is followed only while it stays inside the checkout
      const real = within(root, full);
      if (real && statSync(real).isFile()) return real;
    }
  }
  return undefined;
}

/** A file's lines: a last line break ends the last line rather than starting another; empty = 0. */
function lineCount(file: string): number | undefined {
  if (statSync(file).size > MAX_FILE_BYTES) return undefined;
  const text = readFileSync(file, "utf8");
  if (!text) return 0;
  const parts = text.split("\n").length;
  return text.endsWith("\n") ? parts - 1 : parts;
}

/** The doctype folders of an app: every ".../doctype/<name>" up to a few levels down, inside the checkout. */
function doctypeFolders(root: string, dir = root, depth = 0, out = new Set<string>(), seen = new Set<string>()): Set<string> {
  if (depth > 4 || seen.has(dir)) return out;
  seen.add(dir);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const real = within(root, join(dir, entry));
    if (!real) continue;
    let isDir = false;
    try {
      isDir = statSync(real).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (entry === "doctype") {
      for (const name of readdirSync(real)) out.add(name);
    } else {
      doctypeFolders(root, real, depth + 1, out, seen);
    }
  }
  return out;
}

const slug = (name: string) => name.trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Checks what the report cites against the apps' checked-out code. `apps` maps an app to its
 * checkout. Without any checkout nothing can be checked, and the result says so (checked: 0).
 * Doctypes are checked only when `installedApps` names the site's apps and every one of them is
 * checked out: a doctype may come from any installed app, so with one missing nothing can be ruled out.
 */
export function checkReferences(
  report: Record<string, unknown>,
  apps: Record<string, string>,
  installedApps?: string[],
): ReferenceCheck {
  const missing: MissingReference[] = [];
  let checked = 0;
  if (!Object.keys(apps).length) return { checked, missing };
  for (const cited of citedFiles(report)) {
    checked += 1;
    const file = findFile(cited.path, apps);
    if (!file) {
      missing.push({ kind: "file", value: cited.path });
    } else if (cited.line) {
      const lines = lineCount(file);
      if (lines !== undefined && cited.line > lines) missing.push({ kind: "line", value: `${cited.path}:${cited.line}` });
    }
  }
  const doctypes = citedDoctypes(report);
  const everyAppCheckedOut = !!installedApps?.length && installedApps.every((app) => app in apps);
  if (doctypes.length && everyAppCheckedOut) {
    const known = new Set<string>();
    for (const dir of Object.values(apps)) {
      const root = canonical(dir);
      if (root) for (const name of doctypeFolders(root)) known.add(name);
    }
    if (known.size) {
      for (const name of doctypes) {
        checked += 1;
        if (!known.has(slug(name))) missing.push({ kind: "doctype", value: name });
      }
    }
  }
  return { checked, missing: missing.slice(0, MAX_MISSING) };
}
