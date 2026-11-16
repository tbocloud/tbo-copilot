import { app, type App } from "electron";
import type { PluginRuntime } from "../plugin-runtime";

/**
 * `tbo-copilot://` links (TBO Phase 22). TBO Support's "Open in TBO Copilot"
 * opens one; the app comes to the front and hands the link, unparsed, to the
 * bundled `tbo.support` plugin, which checks the task and the site and asks
 * the person before it opens anything. Core only bounds the string.
 */
export const DEEP_LINK_SCHEME = "tbo-copilot";
const DEEP_LINK_PREFIX = `${DEEP_LINK_SCHEME}://`;
export const DEEP_LINK_MAX_LENGTH = 2048;
/** The one plugin a link is handed to; no other plugin ever sees it. */
export const DEEP_LINK_PLUGIN_ID = "tbo.support";
/** Plugin event: `pi.events.on("app:openUrl", ({ url }) => ...)`. */
export const DEEP_LINK_EVENT = "app:openUrl";
/** Links held while the app boots or the plugin starts; the oldest go first. */
export const MAX_PENDING_DEEP_LINKS = 5;
/** A held link nobody took in this time is dropped, so a later plugin start never replays it. */
export const DEEP_LINK_PENDING_TTL_MS = 2 * 60_000;

/** The link itself when it is a bounded `tbo-copilot://` string, otherwise null. */
export function acceptDeepLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > DEEP_LINK_MAX_LENGTH || !value.startsWith(DEEP_LINK_PREFIX)) return null;
  return value;
}

/** Links in a command line (Windows and Linux pass the link as an argument). */
export function deepLinksFromArgv(argv: readonly unknown[]): string[] {
  return argv.flatMap((entry) => {
    const url = acceptDeepLink(entry);
    return url ? [url] : [];
  });
}

let receiver: ((url: string) => void) | null = null;
const early: string[] = [];

function receive(url: string): void {
  if (receiver) {
    receiver(url);
    return;
  }
  early.push(url);
  if (early.length > MAX_PENDING_DEEP_LINKS) early.shift();
}

/**
 * Listen for links for the life of the app. Called from `entry.ts` before
 * `ready`, because macOS delivers the link that launched the app as an early
 * `open-url`; links seen before the runtime attaches are held for it. One
 * listener covers a second launch's command line before and after boot; the
 * existing `second-instance` handlers still restore the window as before.
 */
export function listenForDeepLinks(
  electronApp: Pick<App, "on">,
  argv: readonly string[] = process.argv,
): void {
  electronApp.on("open-url", (event, url) => {
    event.preventDefault();
    const accepted = acceptDeepLink(url);
    if (accepted) receive(accepted);
  });
  electronApp.on("second-instance", (_event, commandLine) => {
    for (const url of deepLinksFromArgv(commandLine)) receive(url);
  });
  for (const url of deepLinksFromArgv(argv)) receive(url);
}

export type DeepLinkRouterOptions = {
  /** Hand one link to the plugin; false while it is not running. */
  deliver: (url: string) => boolean;
  restoreMainWindow: () => void;
  isApplicationBooted: () => boolean;
  isQuitting: () => boolean;
  now?: () => number;
};

export type DeepLinkRouter = {
  receive: (url: string) => void;
  /** Retry held links; called when boot finishes and when the plugin has loaded. */
  flush: () => void;
};

/** Hold links until the app has booted and the plugin runs, then deliver them in order. */
export function createDeepLinkRouter(options: DeepLinkRouterOptions): DeepLinkRouter {
  const now = options.now ?? Date.now;
  let pending: { url: string; at: number }[] = [];

  const deliver = (url: string): boolean => {
    try {
      return options.deliver(url);
    } catch {
      return false;
    }
  };

  const flush = (): void => {
    if (!options.isApplicationBooted() || options.isQuitting()) return;
    const oldest = now() - DEEP_LINK_PENDING_TTL_MS;
    pending = pending.filter((entry) => entry.at >= oldest);
    while (pending.length > 0 && deliver(pending[0].url)) pending.shift();
  };

  return {
    receive: (url) => {
      const accepted = acceptDeepLink(url);
      if (!accepted || options.isQuitting()) return;
      pending.push({ url: accepted, at: now() });
      if (pending.length > MAX_PENDING_DEEP_LINKS) pending.shift();
      // Before boot the startup sequence opens the window itself.
      if (options.isApplicationBooted()) options.restoreMainWindow();
      flush();
    },
    flush,
  };
}

/**
 * Whether this run makes itself the OS handler for the scheme. A development
 * or test run (its own data folder) would take the scheme away from the
 * installed app, and the portable EXE runs from a temporary folder that is
 * gone after it quits. The installers declare the scheme (`protocols` in the
 * electron-builder config); this keeps the running install the default.
 */
export function shouldRegisterProtocolClient(
  run: { isDevelopmentBuild: boolean; singleInstanceRequired: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !run.isDevelopmentBuild && run.singleInstanceRequired && !env.PORTABLE_EXECUTABLE_FILE;
}

export type DeepLinkDependencies = {
  plugins: Pick<PluginRuntime, "sendEventTo" | "setServices">;
  restoreMainWindow: () => void;
  isApplicationBooted: () => boolean;
  isQuitting: () => boolean;
  /** See {@link shouldRegisterProtocolClient}. */
  registerProtocolClient: boolean;
};

/** Route links to `tbo.support` for the rest of the run. */
export function registerDeepLinks(deps: DeepLinkDependencies): DeepLinkRouter {
  if (deps.registerProtocolClient && !app.isDefaultProtocolClient(DEEP_LINK_SCHEME)) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
  const router = createDeepLinkRouter({
    deliver: (url) => deps.plugins.sendEventTo(DEEP_LINK_PLUGIN_ID, DEEP_LINK_EVENT, [{ url }]),
    restoreMainWindow: deps.restoreMainWindow,
    isApplicationBooted: deps.isApplicationBooted,
    isQuitting: deps.isQuitting,
  });
  deps.plugins.setServices({
    onPluginLoaded: (pluginId) => {
      if (pluginId === DEEP_LINK_PLUGIN_ID) router.flush();
    },
  });
  receiver = router.receive;
  for (const url of early.splice(0)) router.receive(url);
  return router;
}
