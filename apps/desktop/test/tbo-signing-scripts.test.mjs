import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = (name) => fileURLToPath(new URL(`../../../scripts/${name}`, import.meta.url));
const windowsScript = scripts("tbo/configure-windows-signing.mjs");
const { azureSignOptions, configureWindowsSigning, SIGNING_VARIABLES } = await import(windowsScript);

const TEAM = "TBOTEAM001";
const VARIABLES = {
  TBO_WINDOWS_PUBLISHER_NAME: "Example Company LLC",
  AZURE_TRUSTED_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
  AZURE_TRUSTED_SIGNING_ACCOUNT: "tbo-signing",
  AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE: "tbo-public-trust",
};

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("Windows signing settings map onto electron-builder's azureSignOptions", () => {
  assert.deepEqual(SIGNING_VARIABLES, Object.keys(VARIABLES));
  assert.deepEqual(azureSignOptions(VARIABLES), {
    publisherName: "Example Company LLC",
    endpoint: "https://weu.codesigning.azure.net",
    codeSigningAccountName: "tbo-signing",
    certificateProfileName: "tbo-public-trust",
  });
});

test("Windows signing refuses missing or malformed settings", () => {
  assert.throws(
    () => azureSignOptions({ AZURE_TRUSTED_SIGNING_ENDPOINT: VARIABLES.AZURE_TRUSTED_SIGNING_ENDPOINT }),
    /missing repository variables: TBO_WINDOWS_PUBLISHER_NAME, AZURE_TRUSTED_SIGNING_ACCOUNT, AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE/,
  );
  for (const [name, value, message] of [
    ["TBO_WINDOWS_PUBLISHER_NAME", " Example Company LLC", /subject name/],
    ["AZURE_TRUSTED_SIGNING_ENDPOINT", "weu.codesigning.azure.net", /not a URL/],
    ["AZURE_TRUSTED_SIGNING_ENDPOINT", "http://weu.codesigning.azure.net", /codesigning\.azure\.net/],
    ["AZURE_TRUSTED_SIGNING_ENDPOINT", "https://example.com", /codesigning\.azure\.net/],
    ["AZURE_TRUSTED_SIGNING_ACCOUNT", "tbo signing", /resource name/],
    ["AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE", "profile';x", /resource name/],
  ]) {
    assert.throws(() => azureSignOptions({ ...VARIABLES, [name]: value }), message, `${name}=${value}`);
  }
});

test("Windows signing is written into the build.win block and keeps the rest", async (t) => {
  const dir = await tempDir(t, "tbo-win-signing-");
  const original = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const path = join(dir, "package.json");
  await writeFile(path, JSON.stringify(original, null, 2));

  configureWindowsSigning(path, VARIABLES);

  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.build.win.azureSignOptions.publisherName, "Example Company LLC");
  const { azureSignOptions: _added, ...win } = written.build.win;
  assert.deepEqual(win, original.build.win);
  assert.deepEqual({ ...written, build: { ...written.build, win: original.build.win } }, original);
});

test("the Windows signing command names what is missing and prints no secret", async (t) => {
  const dir = await tempDir(t, "tbo-win-signing-cli-");
  const path = join(dir, "package.json");
  await writeFile(path, JSON.stringify({ build: { win: {} } }));
  const secret = "client-secret-value-1234";
  const env = { PATH: process.env.PATH, AZURE_CLIENT_SECRET: secret };

  const failed = spawnSync(process.execPath, [windowsScript, path], { encoding: "utf8", env });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /::error::Windows signing is not configured: missing repository variables: TBO_WINDOWS_PUBLISHER_NAME/);
  assert.doesNotMatch(failed.stdout + failed.stderr, new RegExp(secret));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { build: { win: {} } });

  const done = spawnSync(process.execPath, [windowsScript, path], {
    encoding: "utf8",
    env: { ...env, ...VARIABLES },
  });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Windows signing: Azure Trusted Signing, publisher "Example Company LLC"/);
  assert.doesNotMatch(done.stdout + done.stderr, new RegExp(secret));
});

async function writeStub(bin, name, body) {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, name), `#!/usr/bin/env bash\n${body}`);
  await chmod(join(bin, name), 0o755);
}

test("the DMG notarisation script checks the team the TBO lane passes in", async (t) => {
  const root = await tempDir(t, "tbo-notarize-");
  const release = join(root, "release");
  const bin = join(root, "bin");
  await mkdir(release, { recursive: true });
  await writeFile(join(release, "TBO-Copilot-0.17.0-arm64.dmg"), "fixture");
  await writeStub(
    bin,
    "xcrun",
    'printf "%s\\n" "$*" >> "$NOTARY_LOG"\nif [[ "$1 $2" == "notarytool submit" ]]; then echo "  id: 1"; echo "  status: Accepted"; fi\nexit 0\n',
  );
  const run = (teamId) =>
    spawnSync("bash", [scripts("notarize-and-staple-macos-release-dmg.sh"), release], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NOTARY_LOG: join(root, "xcrun.log"),
        APPLE_ID: "release@example.com",
        APPLE_APP_SPECIFIC_PASSWORD: "app-specific-password",
        APPLE_TEAM_ID: teamId,
        MAC_SIGNING_TEAM_ID: TEAM,
        STAPLE_DELAY_SECONDS: "1",
      },
    });

  const wrong = run("DUV63RKYTW");
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, new RegExp(`APPLE_TEAM_ID must be ${TEAM}`));

  const accepted = run(TEAM);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Staple validation passed: .*TBO-Copilot-0\.17\.0-arm64\.dmg/);
});

async function verifyTboRelease(t, signatureLines) {
  const root = await tempDir(t, "tbo-verify-");
  const release = join(root, "release");
  const bin = join(root, "bin");
  const app = join(release, "mac-arm64", "TBO Copilot.app");
  await mkdir(join(app, "Contents", "Resources", "bin"), { recursive: true });
  await writeFile(join(app, "Contents", "Resources", "bin", "pi-desktop-host-core"), "fixture");
  await writeFile(join(release, "TBO-Copilot-0.17.0-arm64.dmg"), "fixture");
  const echo = signatureLines.map((line) => `echo '${line}' >&2`).join("; ");
  await writeStub(bin, "codesign", `if [[ "$*" == *"-dv"* ]]; then ${echo}; echo 'flags=0x10000(runtime)' >&2; fi\nexit 0\n`);
  await writeStub(bin, "spctl", "echo 'source=Notarized Developer ID' >&2\n");
  await writeStub(bin, "xcrun", "exit 0\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MAC_PRODUCT_NAME: "TBO Copilot", MAC_SIGNING_TEAM_ID: TEAM };
  delete env.MAC_SIGNING_IDENTITY;
  return spawnSync("bash", [scripts("verify-macos-release.sh"), release], { encoding: "utf8", env });
}

test("release verification accepts TBO Copilot.app signed by any Developer ID of TBO's team", async (t) => {
  const result = await verifyTboRelease(t, [
    `Authority=Developer ID Application: Example Company LLC (${TEAM})`,
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    `TeamIdentifier=${TEAM}`,
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /macOS release verification passed: .*TBO Copilot\.app/);
});

test("release verification refuses another team's or a non-Developer ID signature", async (t) => {
  for (const lines of [
    // Upstream's certificate.
    ["Authority=Developer ID Application: XingYu Liu (DUV63RKYTW)", "TeamIdentifier=DUV63RKYTW"],
    // The right name pattern but another team id.
    [`Authority=Developer ID Application: Example Company LLC (OTHERTEAM1)`, "TeamIdentifier=OTHERTEAM1"],
    // A development certificate of the right team.
    [`Authority=Apple Development: Someone (${TEAM})`, `TeamIdentifier=${TEAM}`],
    // An ad-hoc signature.
    ["Signature=adhoc", "TeamIdentifier=not set"],
  ]) {
    const result = await verifyTboRelease(t, lines);
    assert.equal(result.status, 1, lines.join(" | "));
    assert.match(result.stderr, new RegExp(`is not signed with Developer ID Application: <name> \\(${TEAM}\\)`));
  }
});
