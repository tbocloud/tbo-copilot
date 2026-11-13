import type { UpdateMode, UpdatePreference } from "@pi-desktop/shared";

export type WindowsDistribution = "installed" | "zip" | "portable";

/**
 * TBO Copilot: updates come from this repository's GitHub Releases, and only a
 * signed release build looks for them (docs/tbo/README.md, "Updates").
 *
 * The TBO release workflow builds a signed `tbo-v*` tag with
 * `-c.extraMetadata.tboUpdates=enabled`, which writes `"tboUpdates": "enabled"`
 * into the packaged app's package.json. The updater reads that value at start
 * and records it here. Test, pull-request and local builds never carry it, so
 * their updates stay off.
 *
 * `TBO_UPDATES=enabled` in the environment also turns updates on. It exists
 * for tests and development; no release build relies on it.
 */
export const TBO_UPDATES_ENABLED = "enabled";

let tboUpdatesBuildFlag: unknown;

/** Records the packaged app's `tboUpdates` value (undefined when absent). */
export function setTboUpdatesBuildFlag(value: unknown): void {
  tboUpdatesBuildFlag = value;
}

export function tboUpdatesEnabled(): boolean {
  return (
    tboUpdatesBuildFlag === TBO_UPDATES_ENABLED ||
    process.env.TBO_UPDATES === TBO_UPDATES_ENABLED
  );
}

export function supportsAutomaticUpdates(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isPackaged) return false;
  if (!tboUpdatesEnabled()) return false;
  if (platform === "win32" || platform === "darwin") return true;
  return platform === "linux" && Boolean(env.APPIMAGE);
}

export function resolveDefaultUpdatePreference(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: WindowsDistribution,
): UpdatePreference {
  if (!supportsAutomaticUpdates(platform, isPackaged, env)) return "manual";
  if (
    platform === "win32" &&
    (Boolean(env.PORTABLE_EXECUTABLE_FILE) || distribution === "zip" || distribution === "portable")
  ) {
    return "manual";
  }
  return "automatic";
}

export function resolveStoredUpdatePreference(
  value: unknown,
  fallback: UpdatePreference,
): UpdatePreference {
  return value === "automatic" || value === "manual" ? value : fallback;
}

export function resolveEffectiveUpdatePreference(
  preference: UpdatePreference,
  automaticSupported: boolean,
): UpdatePreference {
  return automaticSupported ? preference : "manual";
}

export function resolveUpdateMode(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: WindowsDistribution,
  preference?: UpdatePreference,
): UpdateMode {
  if (!isPackaged || !tboUpdatesEnabled()) return "disabled";
  if (!supportsAutomaticUpdates(platform, isPackaged, env)) return "manual";
  const selected =
    preference ??
    resolveDefaultUpdatePreference(platform, isPackaged, env, distribution);
  return selected === "automatic" ? "in-app" : "manual";
}
