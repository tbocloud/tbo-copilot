# TBO Copilot

TBO Copilot is Team Back Office's AI workbench for engineers. It is our own copy of
[PI-Desktop](https://github.com/vastsa/PI-Desktop) (LGPL-3.0), kept in sync with upstream releases.

The system it belongs to is described in [architecture.md](architecture.md): the backend, the
five plugins, the one-approval flow, traceability, sign-in and AI models.

## Repository layout

| Remote | URL | Purpose |
|---|---|---|
| `origin` | `https://github.com/tbocloud/tbo-copilot` (public fork of `vastsa/PI-Desktop`) | TBO Copilot |
| `upstream` | `https://github.com/vastsa/PI-Desktop` | The original project |

| Branch | Contents |
|---|---|
| `main` | An exact copy of `upstream/main`. Never commit TBO changes here. |
| `tbo` (default) | TBO Copilot: an upstream release plus the TBO changes below |

## Rules

1. **Change the core as little as possible.** Every core change makes upstream merges harder.
2. **Build TBO features as plugins** in the private repository `tbocloud/tbo-copilot-plugins`.
   Plugins use only the plugin API, so they can stay private under the LGPL.
3. **List every core change in this file.**
4. **Keep `LICENSE` and all copyright notices.** Changes to PI-Desktop's own files stay LGPL-3.0.
   This repository is public, so the source of every installer built from it is available.
5. **Never put secrets in this repository.** It is public: keys go in Actions secrets, and TBO-only
   logic goes in the private plugins repository.

## TBO changes to the core

| Change | Where | How it is kept |
|---|---|---|
| App name **TBO Copilot**, app ID `com.teambackoffice.copilot` (dev: `com.teambackoffice.copilot.dev`), installer names, Linux package name, macOS permission texts | `apps/desktop/package.json`, `packages/shared/src/protocol.ts`, `scripts/dev-electron.mjs` | Branding script |
| Own data folders `~/.tbo-copilot` and `~/.tbo-copilot-dev` | `apps/desktop/electron/main/data-paths.ts` | Branding script |
| Update feed and "Releases" link point at `tbocloud/tbo-copilot` | `apps/desktop/package.json`, `apps/desktop/electron/main/updater.ts` | Branding script |
| "PI-Desktop" → "TBO Copilot" in every user-visible message (9 languages) | `packages/i18n/src/locales/*/index.ts`, a few renderer and main-process files | Branding script |
| **Updates are off** unless `TBO_UPDATES=enabled` is set in the environment | `apps/desktop/electron/main/update-policy.ts` (`tboUpdatesEnabled`); tested by `apps/desktop/test/tbo-update-policy.test.mjs` | Normal commit |
| Upstream update tests run with `TBO_UPDATES=enabled`, so they keep testing upstream's update logic | `apps/desktop/test/update-preference.test.mjs`, `updater-controller.test.mjs` (one line each) | Normal commit |
| Tests that pin the product name, app ID, installer names and data folders expect the TBO values | 7 files in `apps/desktop/test/` | Branding script (test rules) |
| TBO release workflow (macOS + Windows installers) and its test | `.github/workflows/tbo-release.yml`, `apps/desktop/test/tbo-release-workflow.test.mjs` | New files (upstream never has them) |
| Shared TBO pull-request checks: Kimi review and task reference | `.github/workflows/ai-review.yml` (copy of `tbocloud/ai-review/caller.yml`), `.github/workflows/task-reference.yml` (same as `tbocloud/helpdesk_client`) | New files (upstream never has them) |
| **TBO logo** in the app icons (light and dark), Windows `.ico`, macOS `.icns`, menu bar icon, installer background and in-app logo | `apps/desktop/build/*`, `apps/desktop/src/assets/brand/*` | Branding script copies them from `scripts/tbo/assets/` |
| **Default theme TBO Dark** for a new install (`plugin:tbo.theme:tbo-dark`); without the plugin the shell falls back to System | `crates/host-core/src/rpc/mod.rs` (`settings.get` defaults) | Branding script |
| **Bundled private TBO plugins** (`tbo.theme`), copied in at build time | `scripts/tbo/bundled-plugins.json`, `scripts/tbo/fetch-plugins.mjs`, `.gitignore`, `tbo-release.yml` | New files; one `.gitignore` block |

### Brand images

All brand images come from **`scripts/tbo/make-brand-assets.py`**:

- It draws the Team Back Office mark (the folded teal banner with the orange flap) from vector
  geometry measured on the official logo: teal `#1C7690` / `#145868`, orange `#FB991C`.
- The official logo is a 191×80 PNG with a white "TEAM BACK OFFICE" wordmark. Its mark is only
  48 px wide, too small to scale to a 1024 px icon, so it is redrawn rather than scaled.
- The script writes every image to `scripts/tbo/assets/`, laid out like the repository, and writes
  the mark as an SVG to `scripts/tbo/brand/tbo-mark.svg`.
- `apply-branding.mjs` copies the images over upstream's files, and `--check` fails if any differs.

| Image | Used for |
|---|---|
| `build/icon_1024.png` (light tile) | Installer master; macOS Dock icon in development |
| `build/logo_dark.png` (dark tile) | Dark installer master (ADR 0125) |
| `build/icon.png`, `icon.ico`, `icon.icns` | Package, Windows and macOS app icons; `icon.png` is also the tray icon on Windows and Linux |
| `build/tray-icon-mac.png` | macOS menu bar (template: black silhouette) |
| `build/dmg-background.png` (+ `@2x`) | macOS installer window: "TBO Copilot", arrow, "Drag TBO Copilot to Applications to install" |
| `src/assets/brand/logo-light.png`, `logo-dark.png` | The logo inside the app (192 px, ADR 0125) |

**To change the brand:**
1. Edit the colours or geometry in `make-brand-assets.py`.
2. Run `python3 scripts/tbo/make-brand-assets.py` (needs Pillow; on macOS, so `iconutil` and the
   Helvetica Neue font are available).
3. Run `node scripts/tbo/apply-branding.mjs`.
4. Commit `scripts/tbo/assets/` and the copied files together.

The home-screen mascot (`src/assets/home-mascot-*`) is not the PI logo and is kept as is.

### Known test issue

When the checkout path contains a space (for example `tbo Copilot/`), 23 upstream tests fail:
`macos-release-verification`, `provider-endpoint-metadata`, `provider-lookup-model-handler`,
`model-binding-catalog-source` and `provider-model-list-scope`. They build file paths with
`new URL(...).pathname`, which keeps the space as `%20`. This is an upstream test bug, not a TBO
change. They pass in a path without spaces. The fix is to use `fileURLToPath`; send it upstream
rather than patching it here.

### Contributor rules

`AGENTS.md` and `CLAUDE.md` are upstream's contributor policies (one branch and worktree per task,
validation, commit format). Follow them for TBO work as well, with `tbo` in the role of `main`.

TBO pull requests also follow the TBO Support rules:
- branch `feature/TASK-YYYY-NNNNN-short-name`;
- the PR says `Closes TASK-YYYY-NNNNN` (or `Refs …` when the PR is only part of the task);
- checks: CI, **AI Review** (Kimi), **Task Reference**, plus one approval.

**Not renamed, on purpose:**
- package names (`@pi-desktop/*`);
- the `pi-desktop-host-core` binary;
- the `PI_DESKTOP_DATA_DIR` variable;
- file markers such as "Generated by PI-Desktop" (existing plugins are recognised by them);
- prompts the model sees.

Renaming these would break things or make every upstream merge conflict.

### Branding script

`scripts/tbo/apply-branding.mjs` applies every rename. Run it after each upstream merge:

```bash
node scripts/tbo/apply-branding.mjs          # apply
node scripts/tbo/apply-branding.mjs --check  # exit 1 if anything is unbranded or a rule is stale
```

A **stale rule** means upstream changed or moved that text: update the rule in the script.

## Updates

**Status: off.** Staff install new versions by hand.

This repository is public, so its GitHub Releases could serve updates without a token in the app.
TBO has chosen to keep updates off for now.

**Planned (option c):** host installers on a private TBO file server and switch `publish` in
`apps/desktop/package.json` to electron-builder's `generic` provider pointing at that server. Then
enable updates with `TBO_UPDATES=enabled`, or by changing `tboUpdatesEnabled`.

## Bundled TBO plugins

TBO plugins live in the private repository
[`tbocloud/tbo-copilot-plugins`](https://github.com/tbocloud/tbo-copilot-plugins). The installers
ship the ones listed in `scripts/tbo/bundled-plugins.json` (today: `tbo.theme`, the TBO colours):

```json
{ "repository": "tbocloud/tbo-copilot-plugins", "ref": "main", "plugins": ["tbo.theme"] }
```

- **At build time** `tbo-release.yml` checks out that repository at `ref` with a read-only deploy key,
  and `scripts/tbo/fetch-plugins.mjs` copies each listed folder into
  `apps/desktop/resources/plugins/`. The host registers everything there as a bundled plugin, enabled
  by default. A later step checks the plugins are inside the packaged app.
- **Releases (`tbo-v*` tags) fail without the key**, so a release never ships without the theme.
  Manual and pull-request test builds only warn, and then open on the System theme.
- Only ids starting with `tbo.` are accepted, so a TBO plugin can never replace one of upstream's
  bundled plugins (`pi.browser`, `pi.file-manager`). The copied folders are ignored by git.
- `ref` is `main`, so a release ships the plugins as they are on `main` when it is built; the build log
  records the commit. Pin `ref` to a tag or commit to freeze them.

**Locally** (for `pnpm dev`, or to package by hand):

```bash
node scripts/tbo/fetch-plugins.mjs                          # clones with your git credentials
node scripts/tbo/fetch-plugins.mjs --source ../tbo-copilot-plugins   # or from a local checkout
```

### Setting up the deploy key (repository admin, once)

```bash
ssh-keygen -t ed25519 -N "" -C "tbo-copilot release" -f tbo-plugins-deploy-key
gh repo deploy-key add tbo-plugins-deploy-key.pub -R tbocloud/tbo-copilot-plugins --title "tbo-copilot release (read-only)"
gh secret set TBO_PLUGINS_DEPLOY_KEY -R tbocloud/tbo-copilot < tbo-plugins-deploy-key
rm tbo-plugins-deploy-key tbo-plugins-deploy-key.pub
```

The key can only read `tbo-copilot-plugins`. Pull requests from forks never receive it.

## Installers (CI)

`.github/workflows/tbo-release.yml` builds the installers:

| Platform | Files |
|---|---|
| macOS Apple Silicon | `TBO-Copilot-<version>-arm64.dmg`, `TBO-Copilot-<version>-arm64-mac.zip` |
| macOS Intel (opt-in) | `TBO-Copilot-<version>-x64.dmg`, `TBO-Copilot-<version>-x64-mac.zip` |
| Windows x64 | `TBO-Copilot-Setup-<version>.exe` (installer), `TBO-Copilot-Portable-<version>.exe` and `.zip` |

**How to run it:**

| Trigger | Result |
|---|---|
| Push a tag `tbo-v<version>` (e.g. `tbo-v0.16.1`; a rebuild of the same version: `tbo-v0.16.1-2`) | Verify, build, then a **GitHub Release** in this repository with the installers (public: anyone can download them) |
| Actions → **TBO Release** → Run workflow | Test build; installers kept as workflow artifacts for 14 days |
| A pull request into `tbo` that changes the workflow | The same test build |

`<version>` must equal `apps/desktop/package.json`'s version; the workflow checks it.

**Intel macOS** is off by default. Tick "Also build macOS Intel" when running it by hand, or set the
repository variable `TBO_BUILD_MACOS_INTEL=true` to include it in tag builds.

**Cost:** none. GitHub-hosted runners are free for public repositories. A full build takes about
35 minutes.

### Signing (not set up yet)

The installers are **unsigned**. macOS builds are **ad-hoc signed** (`-c.mac.identity=-`) so they run
on Apple Silicon.

**Opening them:**
- **macOS 15 or later:** open the app once (macOS blocks it), then System Settings →
  Privacy & Security → **Open Anyway** next to TBO Copilot.
- **Older macOS:** right-click the app → Open → Open, once.
- **Any macOS:** `xattr -dr com.apple.quarantine "/Applications/TBO Copilot.app"` removes the block.
- **Windows:** SmartScreen → More info → Run anyway.

**To sign later:**
- **macOS:** an Apple Developer ID (Apple Developer Program, TBO's own team). Add `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as Actions secrets,
  and replace `-c.mac.identity=-` with `-c.mac.forceCodeSigning=true -c.mac.notarize=true`.
  Upstream's `release.yml` shows the full signed lane.
- **Windows:** a code-signing certificate.

### Upstream workflows in this repository

Upstream's workflow files stay unchanged so merges stay clean, but these are **disabled** in the
repository's Actions settings:

| Workflow | Why it is disabled |
|---|---|
| `release.yml` | Would build on upstream `v*` tags with upstream's Apple team and PI-Desktop names |
| `linux-package.yml` | TBO does not ship Linux |
| `mirror-to-cnb.yml` | Mirrors upstream releases to CNB |
| `docs-check.yml` | Requires a Chinese mirror for every doc, which `docs/tbo/` does not have |
| `pr-base.yml` | Requires pull requests into `main`; TBO pull requests go into `tbo` |

`ci.yml` stays on: it tests every pull request.

## Run it locally

```bash
cd "tbo Copilot/tbo-copilot"
unset ELECTRON_RUN_AS_NODE        # needed when started from an Electron-based editor's terminal
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 pnpm dev
```

- The development build keeps its data in `~/.tbo-copilot-dev`. Add an AI provider in
  Settings → AI providers (OpenAI with an API key).
- Requirements: Node ≥22.19, pnpm 12.8.1, stable Rust (see the main `README.md`).

## Taking a new PI-Desktop release

See [upstream-sync.md](upstream-sync.md).
