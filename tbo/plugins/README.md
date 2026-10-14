# TBO Copilot plugins

TBO Copilot's own plugins. TBO features are built as plugins rather than changes to the core app.
They use only the PI-Desktop plugin API. Until 14 Oct 2026 they lived in a separate private
repository.

## Plugins

| Plugin | What it adds |
|---|---|
| [`tbo.theme`](tbo.theme/) | TBO colours: the brand orange as the accent, everything else neutral |
| [`tbo.support`](tbo.support/) | Lets the agent read TBO Support: tickets, conversation, triage, fix brief, session replay, duplicates, knowledge base. Read-only. [Design](../../docs/tbo/tbo-support-plugin.md) |

## Working on a plugin

From the repository root, with the `pi-plugin` CLI (`packages/plugin-devkit`) built once
(`pnpm --filter '@pi-desktop/plugin-devkit...' build`):

```bash
node packages/plugin-devkit/dist/cli.js check tbo/plugins/tbo.theme                        # validate
node packages/plugin-devkit/dist/cli.js pack tbo/plugins/tbo.theme --out tbo/plugins/dist  # build the .piplug
node --test "tbo/plugins/tests/**/*.test.js"                                               # unit tests
```

- Tests live in `tests/<plugin-id>/`, outside the plugin folders, so they are not packed into the
  `.piplug`.
- CI (`.github/workflows/tbo-plugins.yml`) runs all three when a plugin changes.
- To try a plugin, load its folder in TBO Copilot: **Plugins → Load development plugin**.
- To ship one inside the installers, list it in `scripts/tbo/bundled-plugins.json`
  (see [docs/tbo/README.md](../../docs/tbo/README.md), "Bundled TBO plugins").

This repository is public: never put keys or customer data in a plugin. Each user enters their own
TBO Support key in the app, which keeps it in the computer's credential store.

## Licence

Proprietary. © Team Back Office. All rights reserved. The source is visible because this repository
is public; the licence is unchanged.
