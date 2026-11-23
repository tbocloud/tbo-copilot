import { userLookupPath } from "./user-login-path.ts";

/**
 * The environment a restricted child process is allowed to inherit.
 *
 * Not the host's `process.env`: that carries provider keys and shell secrets a
 * plugin has no business reading (ADR 0008, `07-plugins/04-plugin-security.md`
 * §11.7). The list below is closed on purpose, and every entry has to earn its
 * place.
 *
 * `HOME` / `USER` / `USERPROFILE` earn theirs because the consumer is not only
 * the plugin: a plugin that spawns a third-party binary hands this environment
 * to code we do not own, and that code resolves `~` through `$HOME` rather than
 * calling `os.homedir()` (issue #717). Without an identity variable it falls
 * back to `TMPDIR`, looks for its state somewhere that never exists, and fails
 * as `runtime exited (1)` — an error the user cannot act on. Forwarding the
 * value crosses no boundary the plugin cannot already cross itself: it can read
 * the same path from `os.homedir()` (the `getpwuid` fallback), so this only
 * stops plugin authors from having to restore it by hand in every plugin.
 *
 * `USERPROFILE` is the Windows counterpart, and is what shipped plugins already
 * probe for.
 */

/**
 * `PATH` is here so a bare command name stays findable. A caller that needs the
 * login-shell PATH instead (ADR 0045) overrides it after the fact.
 */
const INHERITED_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "HOME",
  "USER",
  "USERPROFILE",
] as const;

/**
 * The host variables that may cross into a plugin-owned child process.
 *
 * A variable the host does not have stays absent rather than being written as
 * an empty string: `HOME=""` is worse than no `HOME` at all, because a binary
 * that would otherwise fall back to `getpwuid` resolves `~` against the working
 * directory instead.
 */
export function minimalChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/**
 * The environment of a plugin's own utility process: minimal, plus its identity.
 *
 * PATH is the user's login-shell PATH (ADR 0045), as the Bash tool and stdio MCP
 * servers already get it: a plugin that starts the user's own programs (git, gh,
 * uv, bench, node) must find them where the user's terminal does. From the
 * Finder or the Dock the app has only `/usr/bin:/bin:/usr/sbin:/sbin`, and a
 * developer plugin then reported tools as missing that the terminal ran fine
 * (TBO Copilot Phase 27, Q1). `lookupPath` is for tests.
 */
export function pluginChildEnv(
  pluginId: string,
  lookupPath: (inherited: string) => string = userLookupPath,
): Record<string, string> {
  const env: Record<string, string> = {
    ...minimalChildEnv(),
    PI_PLUGIN_ID: pluginId,
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  const path = lookupPath(env.PATH ?? "");
  if (path) env.PATH = path;
  return env;
}
