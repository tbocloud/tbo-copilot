import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../../.github/workflows/tbo-release.yml", import.meta.url),
  "utf8",
);
const build = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).build;

test("TBO releases come from tbo-v tags; workflow edits and manual runs make test builds", () => {
  assert.match(workflow, /push:\n\s+tags: \['tbo-v\*'\]/);
  assert.match(
    workflow,
    /pull_request:\n\s+branches: \[tbo\]\n\s+paths:\n\s+- '\.github\/workflows\/tbo-release\.yml'/,
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /release:\n\s+name: Publish GitHub Release\n\s+if: startsWith\(github\.ref, 'refs\/tags\/tbo-v'\)/,
  );
});

test("TBO installers build without signing secrets and macOS builds are ad-hoc signed", () => {
  // The only secret is the read-only key for the private TBO plugins.
  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(secrets)], ["TBO_PLUGINS_DEPLOY_KEY"]);
  assert.doesNotMatch(workflow, /CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|APPLE_TEAM_ID/);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
  // Without this, pull-request test builds are not signed at all.
  assert.match(workflow, /CSC_FOR_PULL_REQUEST: 'true'/);
  assert.match(
    workflow,
    /run dist:mac --\$\{\{ matrix\.arch \}\} -c\.mac\.identity=-/,
  );
  // pnpm 12 forwards a literal `--`, after which electron-builder ignores
  // every option, so the build commands must not use one.
  assert.doesNotMatch(workflow, /run dist:(mac|win) -- /);
  assert.match(workflow, /codesign --verify --deep --strict "\$app"/);
});

test("the workflow checks the branding and expects the configured installer names", () => {
  assert.match(workflow, /node scripts\/tbo\/apply-branding\.mjs --check/);
  assert.equal(build.dmg.artifactName, "TBO-Copilot-${version}-${arch}.${ext}");
  assert.equal(build.mac.artifactName, "TBO-Copilot-${version}-${arch}-mac.${ext}");
  assert.equal(build.nsis.artifactName, "TBO-Copilot-Setup-${version}.${ext}");
  assert.equal(build.portable.artifactName, "TBO-Copilot-Portable-${version}.${ext}");
  assert.equal(build.win.artifactName, "TBO-Copilot-Portable-${version}.${ext}");
  assert.ok(workflow.includes('"$release"/TBO-Copilot-*-${{ matrix.arch }}.dmg'));
  assert.ok(workflow.includes('"$release"/TBO-Copilot-*-${{ matrix.arch }}-mac.zip'));
  assert.ok(workflow.includes('"$release"/TBO-Copilot-Setup-*.exe'));
  assert.ok(workflow.includes('"$release"/TBO-Copilot-Portable-*.exe'));
  assert.ok(workflow.includes('"$release"/TBO-Copilot-Portable-*.zip'));
});

test("Intel macOS builds are opt-in", () => {
  assert.match(workflow, /macos_intel:\n(?:\s+.+\n)*?\s+default: false/);
  assert.match(workflow, /if \[ "\$MACOS_INTEL" = "true" \]; then/);
});

test("installers bundle the private TBO plugins; releases fail without them", () => {
  assert.match(workflow, /HAS_TBO_PLUGINS_KEY: \$\{\{ secrets\.TBO_PLUGINS_DEPLOY_KEY != '' \}\}/);
  assert.match(
    workflow,
    /- name: Check out the TBO plugins\n\s+if: env\.HAS_TBO_PLUGINS_KEY == 'true'\n\s+uses: actions\/checkout@v7/,
  );
  assert.match(workflow, /ssh-key: \$\{\{ secrets\.TBO_PLUGINS_DEPLOY_KEY \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node scripts\/tbo\/fetch-plugins\.mjs --source \.tbo-plugins/);
  // A tag build without the key fails instead of shipping without the theme.
  assert.match(workflow, /elif \[\[ "\$GITHUB_REF" == refs\/tags\/tbo-v\* \]\]; then\n\s+echo "::error::/);
  assert.match(workflow, /- name: Check the bundled TBO plugins\n\s+if: env\.HAS_TBO_PLUGINS_KEY == 'true'/);
  // Bundling happens before packaging, the check after it.
  const bundle = workflow.indexOf("- name: Bundle the TBO plugins");
  const packageWin = workflow.indexOf("- name: Package Windows installers");
  const packageMac = workflow.indexOf("- name: Package macOS installers");
  const check = workflow.indexOf("- name: Check the bundled TBO plugins");
  assert.ok(bundle > 0 && bundle < packageWin && bundle < packageMac && check > packageMac);
});
