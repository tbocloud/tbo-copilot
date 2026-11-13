#!/usr/bin/env node
// Turns on Azure Trusted Signing for a signed TBO Copilot Windows build.
//
// The TBO release workflow runs this on the Windows runner of a `tbo-v*` tag
// build, after it has checked that the signing secrets and variables exist.
// It writes `build.win.azureSignOptions` into apps/desktop/package.json on that
// runner only (the change is never committed), so every electron-builder run of
// the build (NSIS installer, ZIP, portable EXE) signs. Test builds never run it
// and stay unsigned.
//
// The settings are written to package.json rather than passed as `-c.win.…`
// options because the publisher name has spaces, and the Windows build script
// starts electron-builder through cmd.exe, which would split it.
//
// Reads these repository variables from the environment (none is a secret):
//   TBO_WINDOWS_PUBLISHER_NAME                 the certificate's subject name (CN),
//                                              exactly as Azure shows it. Installed
//                                              copies accept an update only when it
//                                              is signed with this name: never change it.
//   AZURE_TRUSTED_SIGNING_ENDPOINT             e.g. https://weu.codesigning.azure.net
//   AZURE_TRUSTED_SIGNING_ACCOUNT              the Trusted Signing account name
//   AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE  the certificate profile name
//
// The credentials (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET) are
// not read here: Microsoft's TrustedSigning module reads them from the
// environment of the packaging step.
//
//   node scripts/tbo/configure-windows-signing.mjs [path/to/package.json]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_JSON = join(ROOT, "apps", "desktop", "package.json");

export const SIGNING_VARIABLES = [
  "TBO_WINDOWS_PUBLISHER_NAME",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE",
];

const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{1,99}$/;

/** Validates the variables and returns electron-builder's azureSignOptions. */
export function azureSignOptions(env) {
  const missing = SIGNING_VARIABLES.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`missing repository variables: ${missing.join(", ")}`);
  }
  const publisherName = env.TBO_WINDOWS_PUBLISHER_NAME;
  if (publisherName !== publisherName.trim() || /[\r\n]/.test(publisherName)) {
    throw new Error(
      "TBO_WINDOWS_PUBLISHER_NAME must be the certificate's subject name, with no spaces around it",
    );
  }
  let endpoint;
  try {
    endpoint = new URL(env.AZURE_TRUSTED_SIGNING_ENDPOINT);
  } catch {
    throw new Error("AZURE_TRUSTED_SIGNING_ENDPOINT is not a URL");
  }
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".codesigning.azure.net")) {
    throw new Error(
      "AZURE_TRUSTED_SIGNING_ENDPOINT must be the account's https://<region>.codesigning.azure.net endpoint",
    );
  }
  for (const name of ["AZURE_TRUSTED_SIGNING_ACCOUNT", "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE"]) {
    if (!RESOURCE_NAME.test(env[name])) {
      throw new Error(`${name} must be an Azure resource name (letters, digits and hyphens)`);
    }
  }
  return {
    publisherName,
    endpoint: env.AZURE_TRUSTED_SIGNING_ENDPOINT,
    codeSigningAccountName: env.AZURE_TRUSTED_SIGNING_ACCOUNT,
    certificateProfileName: env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE,
  };
}

/** Writes the options into the package.json `build.win` block. */
export function configureWindowsSigning(packageJsonPath, env) {
  const options = azureSignOptions(env);
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (!pkg.build?.win) throw new Error(`${packageJsonPath} has no build.win block`);
  pkg.build.win.azureSignOptions = options;
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return options;
}

function main() {
  const target = resolve(process.argv[2] ?? PACKAGE_JSON);
  try {
    const options = configureWindowsSigning(target, process.env);
    console.log(
      `Windows signing: Azure Trusted Signing, publisher "${options.publisherName}", ` +
        `account ${options.codeSigningAccountName}, profile ${options.certificateProfileName}.`,
    );
  } catch (error) {
    console.error(`::error::Windows signing is not configured: ${error.message}.`);
    console.error("::error::See docs/tbo/README.md, Signing.");
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
