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
export const tboEntries: readonly ChangelogEntry[] = [];

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
