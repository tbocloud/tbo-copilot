# TBO Copilot

TBO Copilot is Team Back Office's AI workbench for engineers. It is our own copy of
[PI-Desktop](https://github.com/vastsa/PI-Desktop) (LGPL-3.0), taken on 30 Sep 2026. Since
14 Oct 2026 it no longer takes PI-Desktop's changes (see [PI-Desktop changes](#pi-desktop-changes)).

The system it belongs to is described in [architecture.md](architecture.md): the backend, the
five plugins, the one-approval flow, traceability, sign-in and AI models.

## Repository layout

| Remote | URL | Purpose |
|---|---|---|
| `origin` | `https://github.com/tbocloud/tbo-copilot` (public; not a fork) | TBO Copilot: the desktop app, the Copilot worker and the TBO plugins |

| Branch | Contents |
|---|---|
| `main` | PI-Desktop as it was at the last sync (30 Sep 2026). Frozen: nothing is added to it. Never commit here. |
| `tbo` (default) | TBO Copilot: that PI-Desktop copy plus the TBO changes below |

| Folder | Contents |
|---|---|
| `tbo/plugins/` | The TBO plugins and their tests (see `tbo/plugins/README.md`) |
| `apps/tbo-worker/` | The Copilot worker |
| `scripts/tbo/`, `docs/tbo/` | TBO's build scripts and documents |

## Rules

1. **Change the core as little as possible.** A small, listed set of changes keeps the app easy to
   follow, and makes copying a single PI-Desktop fix by hand possible.
2. **Build TBO features as plugins** in `tbo/plugins/`. Plugins use only the plugin API.
3. **List every core change in this file.**
4. **Keep `LICENSE` and all copyright notices.** Changes to PI-Desktop's own files stay LGPL-3.0.
   This repository is public, so the source of every installer built from it is available.
5. **Never put secrets or private material in this repository.** It is public: keys go in Actions
   secrets; customer names, evaluation cases and other private documents stay out of it.

## TBO changes to the core

| Change | Where | How it is kept |
|---|---|---|
| App name **TBO Copilot**, app ID `com.teambackoffice.copilot` (dev: `com.teambackoffice.copilot.dev`), installer names, Linux package name, macOS permission texts | `apps/desktop/package.json`, `packages/shared/src/protocol.ts`, `scripts/dev-electron.mjs` | Branding script |
| Own data folders `~/.tbo-copilot` and `~/.tbo-copilot-dev` | `apps/desktop/electron/main/data-paths.ts` | Branding script |
| Update feed and "Releases" link point at `tbocloud/tbo-copilot` | `apps/desktop/package.json`, `apps/desktop/electron/main/updater.ts` | Branding script |
| "PI-Desktop" → "TBO Copilot" in every user-visible message (9 languages) | `packages/i18n/src/locales/*/index.ts`, a few renderer and main-process files | Branding script |
| **Updates only in signed release builds**: the app looks for updates only when its packaged `package.json` says `"tboUpdates": "enabled"`, which the release workflow writes into signed tag builds; `TBO_UPDATES=enabled` also turns them on, for tests and development. A packaged build without it says "Updates are off in this build" instead of "disabled in development builds" | `apps/desktop/electron/main/update-policy.ts` (`tboUpdatesEnabled`, `setTboUpdatesBuildFlag`), `updater.ts` (reads the flag; the message); tested by `apps/desktop/test/tbo-update-policy.test.mjs` | Normal commit |
| Upstream update tests run with `TBO_UPDATES=enabled`, so they keep testing upstream's update logic | `apps/desktop/test/update-preference.test.mjs`, `updater-controller.test.mjs` (one line each) | Normal commit |
| Tests that pin the product name, app ID, installer names and data folders expect the TBO values | 7 files in `apps/desktop/test/` | Branding script (test rules) |
| TBO release workflow (signed macOS + Windows installers, update feeds, draft release), the Windows signing script, and their tests | `.github/workflows/tbo-release.yml`, `scripts/tbo/configure-windows-signing.mjs`, `apps/desktop/test/tbo-release-workflow.test.mjs`, `tbo-signing-scripts.test.mjs` | New files (upstream never has them) |
| Upstream's macOS notarisation and verification scripts take the Apple team (`MAC_SIGNING_TEAM_ID`) and the app name (`MAC_PRODUCT_NAME`) from the environment, with upstream's values as defaults; the entitlements comment no longer names upstream's team | `scripts/notarize-and-staple-macos-release-dmg.sh`, `scripts/verify-macos-release.sh`, `apps/desktop/build/entitlements.mac.plist` | Normal commit; additive, upstream's lane is unchanged |
| **TBO release notes in the app**: a version listed in `changelog-tbo.ts` (English) shows those notes in every language, ahead of upstream's catalog | `packages/shared/src/changelog-tbo.ts`, `changelog.ts`, `changelog-loader.ts`, `changelog-tbo.test.ts`, one assertion in `changelog.test.ts` | Normal commit |
| Settings says "Updates are off in this build." where it said "Updates are disabled in development builds." (9 languages) | `packages/i18n/src/locales/*/index.ts` (`updates.devDisabled`) | Normal commit |
| Shared TBO pull-request checks: Kimi review and task reference | `.github/workflows/ai-review.yml` (copy of `tbocloud/ai-review/caller.yml`), `.github/workflows/task-reference.yml` (same as `tbocloud/helpdesk_client`) | New files (upstream never has them) |
| **TBO logo** in the app icons (light and dark), Windows `.ico`, macOS `.icns`, menu bar icon, installer background and in-app logo | `apps/desktop/build/*`, `apps/desktop/src/assets/brand/*` | Branding script copies them from `scripts/tbo/assets/` |
| **Default theme TBO Dark** for a new install (`plugin:tbo.theme:tbo-dark`); without the plugin the shell falls back to System | `crates/host-core/src/rpc/mod.rs` (`settings.get` defaults) | Branding script |
| **TBO plugins** in `tbo/plugins/`; the installers bundle the ones listed in `scripts/tbo/bundled-plugins.json`, copied in at build time; CI tests and packs them | `tbo/plugins/`, `scripts/tbo/bundled-plugins.json`, `scripts/tbo/fetch-plugins.mjs`, `.gitignore`, `tbo-release.yml`, `.github/workflows/tbo-plugins.yml` and their tests | New files; one `.gitignore` block |
| **A 429 that says the account is out of credit or quota is not retried** (OpenAI `insufficient_quota`, Moonshot "insufficient balance" / `exceeded_current_quota_error`); other 429s are retried as before. Without it, a turn kept backing off for many minutes on an account that could not answer | `packages/agent-runtime/src/agent-errors.ts` (`ACCOUNT_EXHAUSTED_PATTERN`), one test in `agent-errors.test.ts` | Normal commit |
| **A plugin may configure the provider rows it owns** (ADR 0319): store or clear the API key, write only, and set the base URL when its declaration leaves it out. The bundled `tbo.support` plugin uses it to give the app TBO's AI after the person signs in, so nobody types a key | host-core `plugins/providers/owned.rs` and the `plugin.providers.*` RPC; `apps/desktop/electron/main/plugin-runtime.ts`, `plugin-host-process.mjs`, `services/plugin-services.ts`; `packages/plugin-sdk` (`pi.providers`); tests in `plugins/providers/tests.rs`, `rpc/mod.rs` and `apps/desktop/test/plugin-provider-api.test.mjs` | Normal commit; small and additive, so it can be offered to PI-Desktop |
| **`provider.register` is listed as high risk** in the install dialog's risk table and the devkit's high-risk list (the matrix rates it high; the dialog showed it high only as an unknown permission). A test checks the dialog never rates a permission below the matrix (Phase 21, [security.md](security.md) F6) | `apps/desktop/src/features/plugins/model.ts` (`PERMISSION_RISK`), `packages/plugin-devkit/src/check.ts` (`HIGH_RISK_PERMISSIONS`) and its test; `apps/desktop/test/tbo-permission-risk.test.mjs` | Normal commit; one line each, can be offered to PI-Desktop |
| **TBO Copilot worker**: the headless worker that investigates TBO Support tickets read-only (Phase 1c-1) and, with a sandbox runner, writes and tests fixes and opens their pull requests (Phase 1c-2); it uses the engine packages as they are, so the core is unchanged. Its files hold no keys, customer data or evaluation answers; at run time it reads a ticket and the customer's code into a folder that it deletes after the run. See `apps/tbo-worker/README.md` | `apps/tbo-worker/`, its entry in `pnpm-lock.yaml` | New app (upstream never has it) |

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

**Status: on in signed release builds.** TBO Copilot updates itself from this repository's GitHub
Releases. The builds made before signing (`tbo-v0.16.1` to `tbo-v0.16.1-3`) have updates off.

- **Source:** the newest **published** release in `tbocloud/tbo-copilot` that is not a pre-release.
  The app reads `latest.yml` (Windows) or `latest-mac.yml` (macOS) from it and downloads the file
  that feed names. The repository is public, so the app needs no token. A draft is invisible to it.
- **Which builds update:** only builds from a `tbo-v*` tag. The release workflow builds them with
  `-c.extraMetadata.tboUpdates=enabled`, which writes `"tboUpdates": "enabled"` into the app's
  `package.json`; `update-policy.ts` turns updates on only when it finds that value. Test builds and
  local builds never have it, and Settings → Info says "Updates are off in this build."
- **How an update arrives:**
  - macOS (installed from the DMG) and the Windows installer: the app checks 15 seconds after it
    opens and every 6 hours, downloads the new version in the background and installs it when the
    app restarts or quits. Settings → Info → Update behavior can switch this to manual.
  - Windows portable EXE and ZIP: a notice with a link to the release; they never replace
    themselves.
  - Help → Check for Updates checks at once.
- **Version numbers:** a release is offered only when its version is higher than the installed one.
  A rebuild tag (`tbo-v0.17.0-2`) keeps the version, so copies that already have that version do not
  take it. Bump the version for anything staff should receive.
- **Release notes:** `packages/shared/src/changelog-tbo.ts` (English). A version listed there shows
  those notes in the update notice and under Settings → Info → Release notes.
- **A bad release:** turning it back into a draft stops new downloads. The app never goes back a
  version, so copies that already took it stay on it until a higher version is published.

**Moving from the unsigned builds:** everyone on `tbo-v0.16.1` to `tbo-v0.16.1-3` installs the first
signed build by hand, once: the DMG (drag TBO Copilot over the old app) or
`TBO-Copilot-Setup-<version>.exe`. Settings and data stay. Later versions then arrive by themselves.

### Releasing a version

1. **Bump the version** on a branch: `node scripts/release.mjs <version> --skip-docs-check`. It sets
   the version in every `package.json`, `Cargo.toml`, `Cargo.lock` and `APP_VERSION`. Do not pass
   `--tag`: that makes upstream's `v<version>` tag.
2. **Add the release notes** for `<version>` at the top of `packages/shared/src/changelog-tbo.ts`.
3. Open a pull request into `tbo` and merge it.
4. **Tag the merge commit** and push the tag:
   `git tag -a tbo-v<version> -m "TBO Copilot <version>" <commit>`, then
   `git push origin tbo-v<version>`.
5. The workflow verifies, builds, signs and creates a **draft** release with the installers, the
   blockmaps and the update feeds. Install the draft's DMG and Setup EXE on a Mac and a PC, and open
   them.
6. **Publish the draft** (Releases → the draft → Edit → Publish release, with "Set as the latest
   release" ticked). Installed copies take it at their next check.

To build a tag again after a failure, delete its draft first: every run makes a new draft.

## Bundled TBO plugins

TBO plugins live in this repository, in `tbo/plugins/`. The installers ship the ones listed in
`scripts/tbo/bundled-plugins.json`; that file is the list, so this page does not repeat it. Among
them are `tbo.theme`, the TBO colours, and `tbo.support`, which signs the app in through TBO
Support, gives it TBO AI and reads TBO Support.

- **At build time** `tbo-release.yml` runs `scripts/tbo/fetch-plugins.mjs`, which copies each listed
  folder into `apps/desktop/resources/plugins/`. The host registers everything there as a bundled
  plugin, enabled by default. A later step checks the plugins are inside the packaged app.
- Every build ships the plugins as they are in the commit it builds; no key or second repository is
  involved.
- Only ids starting with `tbo.` are accepted, so a TBO plugin can never replace one of upstream's
  bundled plugins (`pi.browser`, `pi.file-manager`). The copied folders are ignored by git.
- **The shipped copy cannot reach this computer:** the script removes `localhost`, `*.localhost` and
  loopback addresses from each copied manifest's `net.domains` and says so in its output. To test
  `tbo.support` against a local bench, load `tbo/plugins/tbo.support` as a development plugin
  ([security.md](security.md) F4).
- **Checks:** `.github/workflows/tbo-plugins.yml` runs the plugins' unit tests and validates and packs
  each plugin whenever one changes.

**Locally** (for `pnpm dev`, or to package by hand):

```bash
node scripts/tbo/fetch-plugins.mjs
```

## Installers (CI)

`.github/workflows/tbo-release.yml` builds the installers:

| Platform | Files |
|---|---|
| macOS Apple Silicon | `TBO-Copilot-<version>-arm64.dmg`, `TBO-Copilot-<version>-arm64-mac.zip` (what the app updates from), each with a `.blockmap` |
| macOS Intel (opt-in) | `TBO-Copilot-<version>-x64.dmg`, `TBO-Copilot-<version>-x64-mac.zip`, each with a `.blockmap` |
| Windows x64 | `TBO-Copilot-Setup-<version>.exe` (installer, and what the app updates from) with its `.blockmap`, `TBO-Copilot-Portable-<version>.exe` and `.zip` |
| Update feeds | `latest.yml` (Windows) and `latest-mac.yml` (macOS, every architecture built) |

**How to run it:**

| Trigger | Result |
|---|---|
| Push a tag `tbo-v<version>` (e.g. `tbo-v0.17.0`; a rebuild of the same version: `tbo-v0.17.0-2`) | Verify, build **signed** installers, then a **draft** GitHub Release with the installers and update feeds. Publishing it releases it (public: anyone can download it) |
| Actions → **TBO Release** → Run workflow | Unsigned test build (macOS ad-hoc signed, updates off), kept as workflow artifacts for 14 days; no secret is used |
| A pull request into `tbo` that changes the workflow | The same test build |

`<version>` must equal `apps/desktop/package.json`'s version; the workflow checks it.

**Intel macOS** is off by default. Tick "Also build macOS Intel" when running it by hand, or set the
repository variable `TBO_BUILD_MACOS_INTEL=true` to include it in tag builds. If anyone uses an Intel
Mac, set the variable: a release without an Intel build gives Intel Macs nothing to update to.

**Cost:** none for the runners: GitHub-hosted runners are free for public repositories. A test build
takes about 35 minutes; a signed build takes longer, mostly waiting for Apple's notarisation.

### Signing

Tag builds are signed; test builds are not, and need no secrets.

- **macOS:** signed with TBO's own **Developer ID Application** certificate (hardened runtime),
  notarised by Apple, and the notarisation ticket stapled to the app and the DMG. The workflow then
  checks that the signature is from TBO's team (`APPLE_TEAM_ID`), that Gatekeeper accepts the app as
  "Notarized Developer ID", and both tickets (`scripts/verify-macos-release.sh`).
- **Windows:** the installer, the portable EXE and the app's executables are signed with **Azure
  Trusted Signing**. `scripts/tbo/configure-windows-signing.mjs` turns it on for the tag build only.
  The workflow then checks that each EXE has a valid signature under the publisher name. SmartScreen
  may still warn on the first downloads of a new publisher, until Microsoft has seen it for a while.
- **A missing secret or variable fails the tag build** before anything is built, and the error names
  what is missing, never a value. An unsigned build is never released.

**Actions secrets and variables** (Settings → Secrets and variables → Actions). None exists yet:

| Name | Kind | Holds |
|---|---|---|
| `CSC_LINK` | Secret | The Developer ID Application certificate with its private key, exported from Keychain Access as a `.p12` file, base64-encoded |
| `CSC_KEY_PASSWORD` | Secret | The password set when exporting that `.p12` |
| `APPLE_ID` | Secret | The email of an Apple ID in TBO's developer team; it notarises the builds |
| `APPLE_APP_SPECIFIC_PASSWORD` | Secret | An app-specific password for that Apple ID (account.apple.com → Sign-In and Security) |
| `APPLE_TEAM_ID` | Secret | TBO's 10-character Apple team ID (developer.apple.com → Account → Membership details) |
| `AZURE_TENANT_ID` | Secret | The Microsoft Entra tenant (directory) ID of the app registration that signs |
| `AZURE_CLIENT_ID` | Secret | The application (client) ID of that app registration |
| `AZURE_CLIENT_SECRET` | Secret | A client secret of that app registration |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | Variable | The Trusted Signing account's endpoint for its region, e.g. `https://weu.codesigning.azure.net` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | Variable | The Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE` | Variable | The certificate profile name |
| `TBO_WINDOWS_PUBLISHER_NAME` | Variable | The certificate's subject name (CN), exactly as the certificate profile shows it: the company's validated legal name. **Never change it** (below) |
| `TBO_BUILD_MACOS_INTEL` | Variable (optional) | `true` to build macOS Intel in every tag build |

**Apple, once:**
1. Enrol the company in the **Apple Developer Program** as an organisation (99 USD a year). Apple
   asks for the company's **D-U-N-S number**, legal name and website, and the person enrolling must
   be allowed to sign for the company. Approval can take several days.
2. As the team's Account Holder (only that role can), create a **Developer ID Application**
   certificate: Certificates, IDs & Profiles → Certificates → +. Make the request on a Mac with
   Keychain Access and install the downloaded certificate there.
3. In Keychain Access, export the certificate with its private key as a `.p12` with a strong
   password. `base64 -i developer-id.p12 | pbcopy` copies the value for `CSC_LINK`; the password is
   `CSC_KEY_PASSWORD`. Keep the `.p12` in TBO's password manager, never in a repository.
4. Pick the Apple ID that notarises (a member of the team), create an app-specific password for it,
   and copy the team ID.

**Azure, once:**
1. In an Azure subscription, create a **Trusted Signing account** in a supported region. Its overview
   page shows the endpoint.
2. Complete **identity validation** for the company (Public Trust). Microsoft checks the
   organisation; the validated name becomes the certificate's subject.
3. Create a **certificate profile** of type Public Trust on that validation.
4. Create an **app registration** in Microsoft Entra ID with a client secret, and give it the
   **Trusted Signing Certificate Profile Signer** role on the account.
5. Add the three Azure secrets and the four variables above.

**Never change the Windows publisher name.** Every installed copy keeps the name it was built with
and refuses an update signed under another name; after a change, everyone would have to install by
hand again. Keep signing macOS with the same Apple team for the same reason.

**Renewals:** the Developer ID certificate lasts five years. The Azure client secret expires on the
date chosen when it was made: replace the secret before then, or the next tag build fails.

**Opening a test build** (unsigned; macOS builds are ad-hoc signed so they run on Apple Silicon):
- **macOS 15 or later:** open the app once (macOS blocks it), then System Settings →
  Privacy & Security → **Open Anyway** next to TBO Copilot.
- **Older macOS:** right-click the app → Open → Open, once.
- **Any macOS:** `xattr -dr com.apple.quarantine "/Applications/TBO Copilot.app"` removes the block.
- **Windows:** SmartScreen → More info → Run anyway.

### Upstream workflows in this repository

Upstream's workflow files stay unchanged (upstream's own tests read them), but these are **disabled**
in the repository's Actions settings:

| Workflow | Why it is disabled |
|---|---|
| `release.yml` | Would build on upstream `v*` tags with upstream's Apple team and PI-Desktop names |
| `linux-package.yml` | TBO does not ship Linux |
| `mirror-to-cnb.yml` | Mirrors upstream releases to CNB |
| `docs-check.yml` | Requires a Chinese mirror for every doc, which `docs/tbo/` does not have |
| `pr-base.yml` | Requires pull requests into `main`; TBO pull requests go into `tbo` |

`ci.yml` stays on: it tests every pull request. `tbo-plugins.yml` tests and packs the TBO plugins
when they change.

## Run it locally

```bash
cd "tbo Copilot/tbo-copilot"
unset ELECTRON_RUN_AS_NODE        # needed when started from an Electron-based editor's terminal
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 pnpm dev
```

- The development build keeps its data in `~/.tbo-copilot-dev`. Add an AI provider in
  Settings → AI providers (OpenAI with an API key).
- Requirements: Node ≥22.19, pnpm 12.8.1, stable Rust (see the main `README.md`).

## PI-Desktop changes

TBO Copilot no longer takes PI-Desktop's changes (owner's decision, 14 Oct 2026). The repository
left PI-Desktop's fork network, and `main` stays frozen.

To bring in **one specific fix**, for example a security fix, copy that commit by hand:

```bash
git remote add pi-desktop https://github.com/vastsa/PI-Desktop.git   # once
git fetch origin
git fetch pi-desktop
git checkout -b feature/TASK-YYYY-NNNNN-pi-desktop-fix origin/tbo
git cherry-pick -x <commit>
node scripts/tbo/apply-branding.mjs && node scripts/tbo/apply-branding.mjs --check
```

Resolve any conflict in favour of the TBO changes listed above, run the tests, and open a pull
request into `tbo`.

## Using TBO Copilot

- [getting-started.md](./getting-started.md): install, sign in, the settings to keep, and what to ask.
- [teams.md](./teams.md): TBO Copilot in Teams, publishing it for the organisation, and limiting the meetings app's mailbox access.
- [report-a-problem.md](./report-a-problem.md): reporting what went wrong; each report becomes a task.
- [security.md](./security.md): the security review (Phase 21): permissions, domains, secrets, writes, logs, and the findings.

## Design documents

- [architecture.md](./architecture.md): the agreed principles and decisions.
- [system-design.md](./system-design.md): the full system design (approved 8 Oct 2026).
- [build-plan.md](./build-plan.md): the build plan with a status per phase.
- [models.md](./models.md): which AI model does which job, the providers' data terms, and the desktop app's setup.
- [worker-server.md](./worker-server.md): running the Copilot worker server, and what to do when something goes wrong.
- One plan per phase, approved before building: [Phase 0](./phases/phase-0.md), [Phase 1a](./phases/phase-1a.md),
  [Phase 1b](./phases/phase-1b.md).
