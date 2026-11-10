import assert from "node:assert/strict";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ADR 0319: a connection test and live model discovery send a provider row's
// key, so for a plugin-owned row they first ask whether its plugin may still
// reach the endpoint. Cached model lists stay available.

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const { bindingForCustomModel, IPC } = await import("@pi-desktop/shared");

const row = {
  id: "plugin:demo.signin:tbo-ai", name: "TBO AI", vendorKey: "custom", enabled: true,
  authKind: "api_key", hasSecret: true, apiStyle: "chat_completions", ownerPluginId: "demo.signin",
  baseUrl: "https://ai.example.com/v1",
  models: ["tbo-default"].map(bindingForCustomModel),
};

test("a plugin-owned row whose endpoint its plugin may no longer reach is never probed with its key", async (t) => {
  const calls = [];
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(JSON.stringify({ data: [{ id: "tbo-default" }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const catalog = new ModelsDevCatalog({
    catalogPath: fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url)),
  });
  assert.equal(await catalog.ensureLoaded(), true);
  const runtime = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: catalog });
  const handlers = new Map();
  let reachable = false;
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ call: async (method) => {
      calls.push(method);
      if (method === "providers.testConnection") return { ok: true };
      if (method === "providers.list") return { providers: [row] };
      if (method === "providers.get") return { provider: row };
      if (method === "providers.getSecret") return { value: "sk-person" };
      if (method === "providers.listModels") return { models: [{ modelId: "tbo-default", displayName: "tbo-default" }] };
      return {};
    } }),
    modelsDevCatalog: catalog, vendorOAuth: {}, logger: { app() {} },
    enrichProvider: runtime.enrichProvider,
    listRuntimeProviders: async () => [runtime.enrichProvider(row)],
    enrichProviderList: runtime.enrichProviderList,
    bindingForModel: () => undefined,
    ownedProviderEndpointAllowed: (pluginId, providerId, url) => {
      assert.equal(pluginId, "demo.signin");
      assert.equal(providerId, row.id);
      assert.equal(url, row.baseUrl);
      return reachable;
    },
  });
  const testConnection = handlers.get(IPC.invoke.providersTest);
  const listModels = handlers.get(IPC.invoke.providersListModels);

  const tested = await testConnection(row.id);
  assert.equal(tested.ok, false);
  assert.equal(tested.errorCode, "PLUGIN_PERMISSION_DENIED");
  const listed = await listModels({ providerId: row.id, source: "refresh" });
  assert.match(listed.error, /not one its plugin may reach/);
  assert.ok(listed.models.length > 0, "the configured model stays listed");
  assert.equal(fetches, 0, "no request went to the endpoint");
  assert.ok(!calls.includes("providers.getSecret"), "the key was never read");

  // cached lists stay available without asking
  const cached = await listModels({ providerId: row.id, source: "cache" });
  assert.ok(Array.isArray(cached.models));

  // reachable again: both send their request with the key
  reachable = true;
  assert.equal((await testConnection(row.id)).ok, true);
  await listModels({ providerId: row.id, source: "refresh" });
  assert.ok(fetches >= 2);
  assert.ok(calls.includes("providers.getSecret"));
});

test("without the endpoint check, a plugin-owned row is refused rather than probed", async () => {
  const calls = [];
  const handlers = new Map();
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ call: async (method) => {
      calls.push(method);
      if (method === "providers.get") return { provider: row };
      if (method === "providers.getSecret") return { value: "sk-person" };
      return { ok: true };
    } }),
    modelsDevCatalog: { ensureLoaded: async () => true }, vendorOAuth: {}, logger: { app() {} },
    enrichProvider: (p) => p, listRuntimeProviders: async () => [row], enrichProviderList: (l) => l,
    bindingForModel: () => undefined,
  });
  const tested = await handlers.get(IPC.invoke.providersTest)(row.id);
  assert.equal(tested.errorCode, "PLUGIN_PERMISSION_DENIED");
  assert.ok(!calls.includes("providers.getSecret"), "the key was never read");
});
