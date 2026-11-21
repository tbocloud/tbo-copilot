import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// TBO testing fixes 9: a TBO Support button in the sidebar's footer opens the
// TBO Support plugin's panel (sign in, sign out, projects), while that plugin
// is on. The panel and the sign-in itself stay the plugin's.
const sidebarSource = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
const pluginManifest = JSON.parse(
  readFileSync(new URL("../../../tbo/plugins/tbo.support/manifest.json", import.meta.url), "utf8"),
);

const plugin = (over = {}) => ({
  id: "tbo.support",
  name: "TBO Support",
  version: "0.5.0",
  enabled: true,
  source: "builtin",
  bundled: true,
  status: "ready",
  permissions: [],
  ...over,
});

test("the TBO Support button", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests = [];
  let answer = { ok: true, data: { ok: true } };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost" },
      addEventListener() {},
      removeEventListener() {},
      piDesktop: {
        on: () => () => undefined,
        invoke: async (channel, ...args) => {
          requests.push([channel, ...args]);
          return answer;
        },
      },
    },
  });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  });

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { I18nextProvider } = await import("react-i18next");
  const i18next = (await import("i18next")).default;
  const i18n = i18next.createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: {} } }, initImmediate: false });
  const button = await server.ssrLoadModule("/src/components/TboSupportButton.tsx");
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const { IPC } = await server.ssrLoadModule("@pi-desktop/shared");
  await t.test("it shows while the TBO Support plugin is on, and only then", () => {
    assert.equal(button.tboSupportAvailable([plugin()]), true);
    assert.equal(button.tboSupportAvailable([plugin({ id: "tbo.theme" }), plugin()]), true);
    for (const plugins of [undefined, [], [plugin({ enabled: false })], [plugin({ status: "error" })], [plugin({ status: "load_error" })], [plugin({ status: "disabled" })], [plugin({ id: "tbo.theme" })]]) {
      assert.equal(button.tboSupportAvailable(plugins), false, JSON.stringify((plugins ?? []).map((p) => [p.id, p.enabled, p.status])));
    }
    // before the plugin list has loaded (the store's first state) nothing is drawn
    assert.deepEqual(useAppStore.getInitialState().plugins, []);
    const before = renderToStaticMarkup(
      React.createElement(I18nextProvider, { i18n }, React.createElement(button.TboSupportButton, {})),
    );
    assert.equal(before, "");
  });

  await t.test("it is one footer action, labelled, like the ones beside it", () => {
    const html = renderToStaticMarkup(
      React.createElement(button.TboSupportFooterAction, { label: "TBO Support: sign in, sign out, projects", onOpen() {} }),
    );
    assert.equal((html.match(/<button\b/g) ?? []).length, 1);
    assert.match(html, /class="[^"]*footer-action[^"]*"/);
    assert.match(html, /data-nav="tbo-support"/);
    assert.match(html, /aria-label="TBO Support: sign in, sign out, projects"/);
    assert.match(html, /<svg\b/);
  });

  await t.test("it runs the plugin's own sign-in command, which opens the panel", async () => {
    requests.length = 0;
    const errors = [];
    await button.openTboSupportPanel((reason) => errors.push(reason));
    assert.deepEqual(requests, [[IPC.invoke.commandPaletteExecute, "tbo-support.sign-in"]]);
    assert.deepEqual(errors, []);
  });

  await t.test("a refusal is said, not swallowed", async () => {
    answer = { ok: false, error: { code: "NOT_FOUND", message: "command not available in this project" } };
    const errors = [];
    await button.openTboSupportPanel((reason) => errors.push(reason));
    assert.deepEqual(errors, ["command not available in this project"]);
    answer = { ok: true, data: { ok: true } };
  });

  await t.test("the command and the plugin are the TBO Support plugin's own", () => {
    assert.equal(pluginManifest.id, button.TBO_SUPPORT_PLUGIN_ID);
    const command = pluginManifest.contributes.commands.find((c) => c.id === button.TBO_SUPPORT_PANEL_COMMAND);
    assert.ok(command, "the manifest declares the command the button runs");
    assert.equal(command.title, "TBO Support: Sign in");
  });
});

test("the sidebar's footer carries the TBO Support button beside its other actions", () => {
  const footer = sidebarSource.slice(sidebarSource.indexOf('<div className="footer-actions">'));
  const end = footer.indexOf("</div>");
  const actions = footer.slice(0, end);
  assert.match(actions, /<NotificationCenter\b/);
  assert.match(actions, /<TboSupportButton onBeforeOpen=\{\(\) => closeMenus\(false\)\} \/>/);
  assert.match(sidebarSource, /import \{ TboSupportButton \} from "\.\/TboSupportButton";/);
});
