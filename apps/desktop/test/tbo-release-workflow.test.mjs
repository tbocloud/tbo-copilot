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

/** Workflow lines without comments. */
const codeLines = workflow.split("\n").filter((line) => !line.trim().startsWith("#"));

/** The text of one step, from its `- name:` line to the next step or job. */
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `step "${name}" is missing`);
  const rest = workflow.slice(start + 1);
  const end = rest.search(/\n {6}- (?:name:|uses:)|\n {2}[a-z]+:\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

const SIGNED = "env.TBO_SIGNED_RELEASE == 'true'";
const UNSIGNED = "env.TBO_SIGNED_RELEASE != 'true'";
const MAC_SECRETS = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
const AZURE_SECRETS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
const WINDOWS_VARIABLES = [
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE",
  "TBO_WINDOWS_PUBLISHER_NAME",
];

test("TBO releases come from tbo-v tags; workflow edits and manual runs make test builds", () => {
  assert.match(workflow, /push:\n\s+tags: \['tbo-v\*'\]/);
  assert.match(
    workflow,
    /pull_request:\n\s+branches: \[tbo\]\n\s+paths:\n\s+- '\.github\/workflows\/tbo-release\.yml'/,
  );
  assert.match(workflow, /workflow_dispatch:/);
  // Only a pushed tag signs, and only a pushed tag is released: a manual run
  // on a tag ref is still an unsigned test build.
  assert.ok(
    workflow.includes(
      "TBO_SIGNED_RELEASE: ${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/tbo-v') }}",
    ),
  );
  assert.match(
    workflow,
    /release:\n\s+name: Create draft GitHub Release\n(?:\s+#.*\n)*\s+if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/tbo-v'\)\n\s+needs: build\n/,
  );
});

test("a tag build fails before building when a signing secret or variable is missing", () => {
  const mac = step("Require macOS signing secrets");
  const windows = step("Require Windows signing secrets and variables");
  assert.ok(mac.includes(`if: matrix.platform == 'macos' && ${SIGNED}\n`));
  assert.ok(windows.includes(`if: matrix.platform == 'windows' && ${SIGNED}\n`));
  for (const name of MAC_SECRETS) assert.ok(mac.includes(`${name}: \${{ secrets.${name} }}`), name);
  for (const name of AZURE_SECRETS) assert.ok(windows.includes(`${name}: \${{ secrets.${name} }}`), name);
  for (const name of WINDOWS_VARIABLES) assert.ok(windows.includes(`${name}: \${{ vars.${name} }}`), name);
  // Every one of them is checked.
  assert.ok(mac.includes(`for name in ${MAC_SECRETS.join(" ")}; do`));
  assert.ok(windows.includes(`for name in ${AZURE_SECRETS.join(" ")}; do`));
  assert.ok(windows.includes(`for name in ${WINDOWS_VARIABLES.join(" ")}; do`));
  // Each runner receives only its own platform's secrets.
  assert.doesNotMatch(mac, /AZURE_|vars\./);
  assert.doesNotMatch(windows, /CSC_|APPLE_/);
  for (const block of [mac, windows]) {
    // The check prints names only and fails the job.
    assert.match(block, /\[ -n "\$\{!name:-\}" \] \|\| missing="\$missing (?:secret|variable) \$name,"/);
    assert.match(block, /echo "::error::A tbo-v tag builds signed [^"]*, and these Actions settings are missing:\$\{missing%,\}\."/);
    assert.match(block, /exit 1/);
  }
  // Both run before anything is built.
  const prepare = workflow.indexOf("- name: Prepare package inputs");
  assert.ok(workflow.indexOf("- name: Require macOS signing secrets") < prepare);
  assert.ok(workflow.indexOf("- name: Require Windows signing secrets and variables") < prepare);
});

test("manual and pull-request builds stay unsigned, ad-hoc on macOS, with updates off", () => {
  const mac = step("Package macOS installers (ad-hoc signed test build)");
  assert.ok(mac.includes(`if: matrix.platform == 'macos' && ${UNSIGNED}\n`));
  assert.match(mac, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
  // Without this, pull-request test builds are not signed at all.
  assert.match(mac, /CSC_FOR_PULL_REQUEST: 'true'/);
  assert.match(mac, /run: pnpm --filter @pi-desktop\/desktop run dist:mac --\$\{\{ matrix\.arch \}\} -c\.mac\.identity=-\n/);

  const windows = step("Package Windows installers (unsigned test build)");
  assert.ok(windows.includes(`if: matrix.platform == 'windows' && ${UNSIGNED}\n`));
  assert.match(windows, /run: pnpm --filter @pi-desktop\/desktop run dist:win --\$\{\{ matrix\.arch \}\}\n/);

  for (const block of [mac, windows]) {
    assert.doesNotMatch(block, /secrets\.|vars\.|tboUpdates|forceCodeSigning|notarize/);
  }
  // pnpm 12 forwards a literal `--`, after which electron-builder ignores
  // every option, so the build commands must not use one.
  assert.doesNotMatch(workflow, /run dist:(mac|win) -- /);
  assert.match(step("Check the macOS signature"), /codesign --verify --deep --strict "\$app"/);
});

test("signed builds, and only signed builds, turn in-app updates on", () => {
  const flagged = codeLines.filter((line) => line.includes("-c.extraMetadata.tboUpdates=enabled"));
  assert.equal(flagged.length, 2, "one macOS and one Windows packaging command");
  assert.ok(step("Package macOS installers (signed and notarised)").includes("-c.extraMetadata.tboUpdates=enabled"));
  assert.ok(step("Package Windows installers (signed)").includes("-c.extraMetadata.tboUpdates=enabled"));
  // The Windows build script forwards the flag to all three electron-builder
  // runs, after which it adds the distribution marker.
  assert.equal(build.extraMetadata.tboUpdates, undefined, "never on in a local or test build");
});

test("tag builds sign, notarise and staple macOS with TBO's own team", () => {
  const pack = step("Package macOS installers (signed and notarised)");
  assert.ok(pack.includes(`if: matrix.platform == 'macos' && ${SIGNED}\n`));
  for (const name of MAC_SECRETS) {
    assert.ok(pack.includes(`${name}: \${{ secrets.${name} }}`), name);
  }
  assert.match(pack, /-c\.mac\.forceCodeSigning=true/);
  assert.match(pack, /-c\.mac\.notarize=true/);
  assert.doesNotMatch(pack, /-c\.mac\.identity=|CSC_NAME|DUV63RKYTW|XingYu/);
  // electron-builder's debug namespace prints the certificate password.
  assert.match(pack, /DEBUG: "electron-osx-sign\*,electron-notarize\*"/);
  assert.match(
    pack,
    /node scripts\/macos-signing-watchdog\.mjs \\\n\s+--label "dist:mac-\$\{\{ matrix\.arch \}\}" \\\n\s+-- pnpm --filter @pi-desktop\/desktop run dist:mac --\$\{\{ matrix\.arch \}\} \\/,
  );

  const dmg = step("Notarise and staple the macOS DMG");
  assert.ok(dmg.includes(`if: matrix.platform == 'macos' && ${SIGNED}\n`));
  assert.ok(dmg.includes("MAC_SIGNING_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}"));
  assert.match(dmg, /-- scripts\/notarize-and-staple-macos-release-dmg\.sh apps\/desktop\/release/);

  const verify = step("Verify the signed and notarised macOS installers");
  assert.ok(verify.includes(`if: matrix.platform == 'macos' && ${SIGNED}\n`));
  assert.match(verify, /MAC_PRODUCT_NAME: TBO Copilot\n/);
  assert.ok(verify.includes("MAC_SIGNING_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}"));
  assert.match(verify, /run: scripts\/verify-macos-release\.sh apps\/desktop\/release/);

  const order = [
    "- name: Package macOS installers (signed and notarised)",
    "- name: Notarise and staple the macOS DMG",
    "- name: Verify the signed and notarised macOS installers",
    "- name: Upload installers and update feeds",
  ].map((name) => workflow.indexOf(name));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("tag builds sign Windows with Azure Trusted Signing under the fixed publisher name", () => {
  const configure = step("Configure Windows signing (Azure Trusted Signing)");
  assert.ok(configure.includes(`if: matrix.platform == 'windows' && ${SIGNED}\n`));
  for (const name of WINDOWS_VARIABLES) {
    assert.ok(configure.includes(`${name}: \${{ vars.${name} }}`), name);
  }
  assert.doesNotMatch(configure, /secrets\./, "the configuration step reads no secret");
  assert.match(configure, /run: node scripts\/tbo\/configure-windows-signing\.mjs\n/);

  const pack = step("Package Windows installers (signed)");
  assert.ok(pack.includes(`if: matrix.platform == 'windows' && ${SIGNED}\n`));
  for (const name of AZURE_SECRETS) {
    assert.ok(pack.includes(`${name}: \${{ secrets.${name} }}`), name);
  }
  assert.match(pack, /run: pnpm --filter @pi-desktop\/desktop run dist:win --\$\{\{ matrix\.arch \}\} -c\.extraMetadata\.tboUpdates=enabled\n/);

  const verify = step("Verify the Windows signatures");
  assert.ok(verify.includes(`if: matrix.platform == 'windows' && ${SIGNED}\n`));
  assert.match(verify, /shell: pwsh/);
  assert.match(verify, /Get-AuthenticodeSignature/);
  assert.match(verify, /\$signature\.Status -ne 'Valid'/);
  assert.match(verify, /\$name -cne \$env:TBO_WINDOWS_PUBLISHER_NAME/);
  assert.match(verify, /win-unpacked\/TBO Copilot\.exe/);

  assert.ok(
    workflow.indexOf("- name: Configure Windows signing") < workflow.indexOf("- name: Package Windows installers (signed)"),
  );
});

test("secrets only reach steps through env and are never printed", () => {
  for (const line of codeLines.filter((text) => text.includes("secrets."))) {
    // NAME: ${{ secrets.NAME }}, or the team id for the scripts' team check.
    const match = line.match(/^\s+([A-Z_]+): \$\{\{ secrets\.([A-Z_]+) \}\}$/);
    assert.ok(match, `secret used outside an env entry: ${line.trim()}`);
    assert.ok(
      match[1] === match[2] || (match[1] === "MAC_SIGNING_TEAM_ID" && match[2] === "APPLE_TEAM_ID"),
      line.trim(),
    );
  }
  assert.doesNotMatch(workflow, /set -x|xtrace/);
  for (const name of [...MAC_SECRETS, ...AZURE_SECRETS]) {
    assert.doesNotMatch(workflow, new RegExp(`(echo|printf|Write-Output)[^\\n]*\\$\\{?${name}\\b`), name);
  }
  // Pull requests from forks never see secrets, and pull_request_target
  // would hand them to untrusted code.
  assert.doesNotMatch(workflow, /pull_request_target/);
});

test("every build uploads the installers, the blockmaps and the update feeds", () => {
  const names = step("Verify artifact names and update feeds");
  for (const expected of [
    '"$release"/TBO-Copilot-*-${{ matrix.arch }}.dmg',
    '"$release"/TBO-Copilot-*-${{ matrix.arch }}.dmg.blockmap',
    '"$release"/TBO-Copilot-*-${{ matrix.arch }}-mac.zip',
    '"$release"/TBO-Copilot-*-${{ matrix.arch }}-mac.zip.blockmap',
    '"$release"/latest-mac.yml',
    '"$release"/TBO-Copilot-Setup-*.exe',
    '"$release"/TBO-Copilot-Setup-*.exe.blockmap',
    '"$release"/TBO-Copilot-Portable-*.exe',
    '"$release"/TBO-Copilot-Portable-*.zip',
    '"$release"/latest.yml',
  ]) {
    assert.ok(names.includes(expected), expected);
  }
  // Installed copies update from the NSIS installer and the macOS ZIP.
  assert.ok(names.includes('update_file="TBO-Copilot-Setup-[^ ]*\\.exe"'));
  assert.ok(names.includes('update_file="TBO-Copilot-[^ ]*-${{ matrix.arch }}-mac\\.zip"'));

  assert.match(
    step("Name the macOS update feed by architecture"),
    /run: mv apps\/desktop\/release\/latest-mac\.yml apps\/desktop\/release\/latest-mac-\$\{\{ matrix\.arch \}\}\.yml/,
  );
  const upload = step("Upload installers and update feeds");
  for (const path of [
    "apps/desktop/release/TBO-Copilot-*.dmg",
    "apps/desktop/release/TBO-Copilot-*.zip",
    "apps/desktop/release/TBO-Copilot-*.exe",
    "apps/desktop/release/TBO-Copilot-*.blockmap",
    "apps/desktop/release/latest*.yml",
  ]) {
    assert.ok(upload.includes(`            ${path}\n`), path);
  }
  assert.match(upload, /if-no-files-found: error/);
});

test("the release is a draft with merged update feeds", () => {
  const merge = step("Merge the macOS update feeds");
  assert.match(merge, /working-directory: dist/);
  assert.ok(merge.includes('paths.include?("latest-mac-arm64.yml")'), "Apple Silicon is required");
  assert.ok(merge.includes('["latest-mac-arm64.yml", "latest-mac-x64.yml"]'), "Intel is optional");
  assert.ok(merge.includes('load.call("latest.yml")'), "the Windows and macOS feeds agree on the version");
  assert.ok(merge.includes('File.write("latest-mac.yml", merged.to_yaml)'));
  assert.match(merge, /rm latest-mac-\*\.yml/);

  const release = step("Create the draft GitHub Release");
  assert.match(release, /uses: softprops\/action-gh-release@v3/);
  assert.match(release, /draft: true\n/);
  assert.match(release, /files: dist\/\*\n/);
  assert.doesNotMatch(release, /prerelease:|draft: false|not signed/);
  assert.ok(workflow.indexOf("- name: Merge the macOS update feeds") < workflow.indexOf("- name: Create the draft GitHub Release"));
});

test("the workflow checks the branding and expects the configured installer names", () => {
  assert.match(workflow, /node scripts\/tbo\/apply-branding\.mjs --check/);
  assert.equal(build.dmg.artifactName, "TBO-Copilot-${version}-${arch}.${ext}");
  assert.equal(build.mac.artifactName, "TBO-Copilot-${version}-${arch}-mac.${ext}");
  assert.equal(build.nsis.artifactName, "TBO-Copilot-Setup-${version}.${ext}");
  assert.equal(build.portable.artifactName, "TBO-Copilot-Portable-${version}.${ext}");
  assert.equal(build.win.artifactName, "TBO-Copilot-Portable-${version}.${ext}");
  // Updates download from this repository's releases.
  assert.deepEqual(build.publish, [{ provider: "github", owner: "tbocloud", repo: "tbo-copilot" }]);
  // Signing settings come from the release workflow, never from the repository.
  assert.equal(build.win.azureSignOptions, undefined);
  assert.equal(build.mac.identity, undefined);
  assert.equal(build.mac.notarize, undefined);
});

test("Intel macOS builds are opt-in", () => {
  assert.match(workflow, /macos_intel:\n(?:\s+.+\n)*?\s+default: false/);
  assert.match(workflow, /if \[ "\$MACOS_INTEL" = "true" \]; then/);
});

test("every installer bundles the TBO plugins from this repository and checks them", () => {
  // No clone of another repository and no deploy key: tbo/plugins/ is in this checkout.
  assert.doesNotMatch(workflow, /TBO_PLUGINS_DEPLOY_KEY|HAS_TBO_PLUGINS_KEY|\.tbo-plugins|ssh-key:/);
  assert.match(workflow, /- name: Bundle the TBO plugins\n(?:\s+#.*\n)*\s+run: node scripts\/tbo\/fetch-plugins\.mjs\n/);
  // The check after packaging runs on every build, not only when a key is set.
  assert.match(workflow, /- name: Check the bundled TBO plugins\n\s+run: \|/);
  // Bundling happens before packaging, the check after it.
  const bundle = workflow.indexOf("- name: Bundle the TBO plugins");
  const packaging = [
    "- name: Package Windows installers (unsigned test build)",
    "- name: Package Windows installers (signed)",
    "- name: Package macOS installers (ad-hoc signed test build)",
    "- name: Package macOS installers (signed and notarised)",
  ].map((name) => workflow.indexOf(name));
  const check = workflow.indexOf("- name: Check the bundled TBO plugins");
  assert.ok(packaging.every((index) => bundle > 0 && bundle < index && index < check));
});
