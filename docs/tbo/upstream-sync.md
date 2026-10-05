# Taking a new PI-Desktop release

How to bring a new upstream PI-Desktop release into TBO Copilot.

**When:** each upstream release (`vX.Y.Z` tag on `vastsa/PI-Desktop`), at least once a month for
security fixes.

**Before you start:** a clean working tree, and the remotes `origin` (tbocloud/tbo-copilot) and
`upstream` (vastsa/PI-Desktop). See [README.md](README.md).

## 1. Get the release

```bash
git fetch upstream --tags
git tag --sort=-creatordate | head -5        # newest releases
git checkout main
git merge --ff-only upstream/main
git push origin main --tags
```

Pick a **release tag** (e.g. `v0.16.2`), not the tip of `main`.

## 2. Merge it into a sync branch

```bash
git checkout tbo
git pull
git checkout -b sync/v0.16.2
git merge v0.16.2
```

### Resolving conflicts

| Conflicting file | What to do |
|---|---|
| A file changed **only by the branding script** (package.json, locales, `protocol.ts`, `data-paths.ts`, …) | Take upstream's version (`git checkout --theirs <file>`); the script re-applies the branding in step 3 |
| `apps/desktop/electron/main/update-policy.ts` | Keep upstream's new code **and** the `tboUpdatesEnabled` checks |
| `apps/desktop/test/*.test.mjs` with TBO name expectations | Take upstream's version, then re-apply the TBO expectations (see `git log -p --follow <file>` on `tbo`) |
| `scripts/tbo/`, `docs/tbo/` | Keep ours (upstream never has these) |

Then finish the merge:

```bash
git add -A
git commit
```

## 3. Re-apply the branding

```bash
node scripts/tbo/apply-branding.mjs
node scripts/tbo/apply-branding.mjs --check
```

If the script reports a **stale rule**, upstream changed or moved that text. Find the new text,
update the rule in `scripts/tbo/apply-branding.mjs`, and run it again. Also look for **new**
user-visible "PI-Desktop" text:

```bash
grep -rn "PI-Desktop" packages/i18n/src/locales/en apps/desktop/src apps/desktop/electron \
  --include='*.ts' --include='*.tsx' | grep -v "\.test\."
```

Add a rule for each new visible occurrence. Leave comments, internal markers and model prompts alone.

The script also copies the TBO brand images from `scripts/tbo/assets/` over upstream's. If it
reports **"brand image target not found"**, upstream moved or renamed that image. Move the file
in `scripts/tbo/assets/` to the new path, then run the script again. If upstream added a **new**
brand image (look for new files in `apps/desktop/build/` or `apps/desktop/src/assets/brand/`),
add it to `scripts/tbo/make-brand-assets.py`.

## 4. Install, build and test

```bash
unset ELECTRON_RUN_AS_NODE
pnpm install --frozen-lockfile
pnpm --filter '@pi-desktop/desktop^...' build
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo build -p host-core
(cd apps/desktop && node --test test/*.test.mjs)
pnpm typecheck
pnpm lint
cargo test -p host-core
```

All must pass. Fix TBO-caused failures. Report upstream failures upstream.

## 5. Smoke test the app

```bash
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 pnpm dev
```

Check that:
- the window title and menu say **TBO Copilot**;
- data is in `~/.tbo-copilot-dev`;
- a chat with the configured model works;
- the TBO plugins load.

## 6. Check upstream's workflows

```bash
git diff --stat <previous-tbo-commit> -- .github/workflows/
gh workflow list -R tbocloud/tbo-copilot --all
```

- **A new upstream workflow** must not run in this repository unless it is useful here. Disable it:
  `gh workflow disable <file> -R tbocloud/tbo-copilot`.
- **Keep `release.yml` disabled.** TBO builds come from `tbo-release.yml`.
- **If upstream changed its build steps** (`release.yml` "Prepare package inputs" or the
  `dist:*` scripts), copy the change into `tbo-release.yml`.

## 7. Merge and release

```bash
git push -u origin sync/v0.16.2
gh pr create --base tbo --title "Sync PI-Desktop v0.16.2" --body "Upstream release v0.16.2 merged; branding re-applied; tests pass."
```

After review, merge into `tbo`. Then build the installers by tagging the merge:

```bash
git checkout tbo && git pull
git tag tbo-v0.16.2
git push origin tbo-v0.16.2      # runs tbo-release.yml → GitHub Release with the installers
```

Record the upstream version in the release notes.
