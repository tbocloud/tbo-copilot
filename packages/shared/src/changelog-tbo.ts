import type { ChangelogEntry } from "./changelog.js";
import { normalizeChangelogVersion } from "./changelog-runtime.js";

/**
 * TBO Copilot's own release notes, newest first, in English only.
 *
 * Upstream's catalog (changelog-en.ts and its translations) stops at the last
 * PI-Desktop release, so a TBO version would show no "What's new". A version
 * listed here shows these notes in every UI language, ahead of upstream's
 * catalog, in the update notice and in Settings → Release notes.
 *
 * Add an entry for each TBO version before tagging `tbo-v<version>`
 * (docs/tbo/README.md, "Releasing a version"). Keep each highlight to one idea
 * that a TBO engineer would notice; leave out customer names.
 */
export const tboEntries: readonly ChangelogEntry[] = [
  {
    version: "0.16.2",
    date: "2026-11-26",
    highlights: [
      "TBO AI offers four levels, Simple, Medium, Hard and Very hard: pick the one that fits the question. Their models are chosen on TBO Support's AI models page.",
      "TBO AI · DeepSeek is gone. When DeepSeek is wanted, it is one of the levels' models.",
      "File search gives the right results when a file changes during the search, and in folders reached through links.",
    ],
  },
];

/** TBO Copilot's notes for a version, if it has any. */
export function getTboChangelogEntry(
  version: string | null | undefined,
  catalog: readonly ChangelogEntry[] = tboEntries,
): ChangelogEntry | undefined {
  const key = normalizeChangelogVersion(version);
  if (!key) return undefined;
  return catalog.find((entry) => entry.version === key);
}

/** A locale catalog with TBO Copilot's entries first; TBO wins a shared version. */
export function withTboEntries(
  entries: readonly ChangelogEntry[],
  catalog: readonly ChangelogEntry[] = tboEntries,
): readonly ChangelogEntry[] {
  if (catalog.length === 0) return entries;
  const tboVersions = new Set(catalog.map((entry) => entry.version));
  return [
    ...catalog,
    ...entries.filter((entry) => !tboVersions.has(entry.version)),
  ];
}
