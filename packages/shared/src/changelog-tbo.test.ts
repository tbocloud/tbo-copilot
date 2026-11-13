import { describe, expect, it } from "vitest";
import { CHANGELOG, type ChangelogEntry, formatChangelogNotes } from "./changelog.js";
import { loadChangelogCatalog } from "./changelog-loader.js";
import { getTboChangelogEntry, tboEntries, withTboEntries } from "./changelog-tbo.js";

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(a: string, b: string): number {
  const left = STABLE.exec(a)?.slice(1).map(Number) ?? [];
  const right = STABLE.exec(b)?.slice(1).map(Number) ?? [];
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const sample: readonly ChangelogEntry[] = [
  { version: "0.17.0", highlights: ["TBO only"] },
  { version: "0.16.1", highlights: ["TBO notes for a shared version"] },
];

describe("TBO Copilot changelog", () => {
  it("lists stable TBO versions newest first, each with highlights", () => {
    const versions = tboEntries.map((entry) => entry.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const entry of tboEntries) {
      expect(entry.version).toMatch(STABLE);
      expect(entry.highlights.length).toBeGreaterThan(0);
      for (const line of entry.highlights) expect(line.trim()).not.toBe("");
      if (entry.date) expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (let index = 1; index < versions.length; index += 1) {
      expect(compareVersions(versions[index - 1] ?? "", versions[index] ?? "")).toBeGreaterThan(0);
    }
  });

  it("finds a TBO version and puts TBO entries ahead of upstream's", () => {
    expect(getTboChangelogEntry("v0.17.0", sample)?.highlights).toEqual(["TBO only"]);
    expect(getTboChangelogEntry("0.15.0", sample)).toBeUndefined();
    expect(getTboChangelogEntry("", sample)).toBeUndefined();

    const merged = withTboEntries(CHANGELOG.en, sample);
    expect(merged.slice(0, 2)).toEqual(sample);
    expect(merged.filter((entry) => entry.version === "0.16.1")).toEqual([sample[1]]);
    expect(merged.length).toBe(CHANGELOG.en.length + 1);
    expect(withTboEntries(CHANGELOG.en, [])).toBe(CHANGELOG.en);
  });

  it("shows TBO notes in every locale and leads the release notes catalog", async () => {
    for (const entry of tboEntries) {
      const expected = entry.highlights.map((line) => `• ${line}`).join("\n");
      expect(formatChangelogNotes(entry.version, "en")).toBe(expected);
      expect(formatChangelogNotes(entry.version, "de")).toBe(expected);
    }
    const catalog = await loadChangelogCatalog("de");
    expect(catalog.slice(0, tboEntries.length)).toEqual(tboEntries);
  });
});
