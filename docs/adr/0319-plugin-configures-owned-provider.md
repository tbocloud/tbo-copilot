# ADR 0319: A plugin may configure the provider rows it owns

- Status: Accepted (TBO Copilot)
- Date: 2026-11-06
- Related: ADR 0259, `07-plugins/03-plugin-api.md`, `07-plugins/13-plugin-permissions-matrix.md`, `03-runtime/06-host-rpc-protocol.md`

## Context

ADR 0259 lets a plugin declare providers that the Host materializes as rows the
plugin owns. The credential stays the user's: the plugin never holds it, and the
user types it in Settings.

That does not fit a sign-in plugin. TBO Copilot's bundled `tbo.support` plugin
signs a TBO person in through their organisation's account, and the
organisation's AI gateway then issues that person a key, and sometimes the
gateway address. The person should not see or type that key; asking them to copy
it into Settings hands them a credential to keep safe, defeats revoking it per
computer, and breaks the "sign in and use" flow.

## Decision

1. A plugin with `provider.register` may, for a provider row **it owns**
   (`plugin:<pluginId>:<declaredId>`), call:
   - `pi.providers.setCredential(providerId, apiKey)` — stores the key in the
     Host secret store under the row's usual ref (`secret:provider:<id>:api_key`);
   - `pi.providers.clearCredential(providerId)` — removes it (sign-out);
   - `pi.providers.setBaseUrl(providerId, baseUrl)` — only when the declaration
     omits `baseUrl`. The value is kept in the row's config and restored by the
     declaration refresh on every load; a declared `baseUrl` always wins.
2. The key is **write only**. No reply, no audit entry and no plugin API returns
   it; the public provider row only says that a key exists.
3. Electron main checks `provider.register` and the argument shapes and is the
   only caller that supplies `pluginId`. Host-core (`plugin.providers.*` RPC)
   checks that the row exists and is owned by that plugin, and refuses a user row
   or another plugin's row (`PERMISSION_DENIED`), an undeclared id (`NOT_FOUND`),
   a key that is empty, longer than 4096 characters or has control characters, a
   key for an `authKind: "none"` row, and a URL that is not absolute https (plain
   http only for `localhost`, `127.0.0.1` and `*.localhost`) or embeds
   credentials (`INVALID_PARAMS`). Before dispatching `setBaseUrl`, Electron main
   also applies the plugin's egress check to the URL (`manifest.net.domains`, or
   the `net.anyHost` grant), the same check as `pi.net.fetch`: the endpoint gets
   the conversation and the key, so it may only be a host the plugin declared.
   The same decision is made again on every model launch for a row whose
   declaration omits `baseUrl` (`PluginRuntime.ownedProviderEndpointAllowed`):
   after a plugin update removes the host from `net.domains`, or the user
   revokes `net.anyHost`, the row is refused at launch and left out of what
   subagents can use, pinned or offered. A row whose manifest declares its endpoint keeps ADR 0259's
   behaviour.
5. After an accepted call, Electron main tells the renderer
   (`providersChanged`), which refreshes its provider list: the model picker
   offers the provider as soon as the sign-in completes. A refused call sends
   nothing.
6. Nothing else changes: the user path still refuses plugin-owned rows
   (`PROVIDER_OWNED_BY_PLUGIN`), the user may still supply a key through
   `providers.setSecret`, and uninstalling the plugin deletes the row and both
   credential refs as before.

## Consequences

- A sign-in plugin can give the app a working provider without the person ever
  handling a key, and can revoke it on sign-out.
- A plugin that holds `provider.register` can now point its own row at an
  endpoint chosen at run time. The permission is already high-risk with explicit
  confirmation, the URL rules above apply, the endpoint must be in the plugin's
  `net.domains`, and only rows the plugin declared are reachable.
- Changing or clearing a key changes what the next turn uses. A turn already
  running keeps the key it resolved when it started, exactly as when the user
  edits a key in Settings; revocation that must take effect at once belongs to
  the endpoint (TBO's gateway deletes the person's key when the sign-in ends).
- Every model request of a plugin-owned row refuses redirects
  (`RuntimeProviderConfig.refuseRedirects`, applied in `withProviderHeaders`
  on every request path: the main turn, subagents, one-shot completions and
  compaction). A 307 or 308 would otherwise resend the conversation and the
  key to whatever host the endpoint names; with the policy it fails instead.
  An adapter that accepts no custom fetch cannot carry it, so such a request
  is refused rather than sent. Image generation and speech apply the same
  endpoint check to a plugin-owned provider; image requests already refuse
  redirects, and a plugin-owned speech provider's requests now do too.
- Follow-ups, runtime-wide and not specific to plugins, are left for later: a
  launch that reads a row's endpoint and key as one snapshot, and
  invalidating a running turn's credential when it changes.
- The change is small and additive (no schema change; one config key,
  `pluginBaseUrl`), so it can be offered to PI-Desktop as is.

## Alternatives considered

### The person pastes a key shown once after sign-in

Rejected for TBO's use: the person handles a credential, and the app cannot
replace or clear it on sign-out.

### A local proxy service in the plugin that adds the key

Rejected: a fixed localhost port any local process could use to spend the
person's budget, plus a second network hop for every model call.
