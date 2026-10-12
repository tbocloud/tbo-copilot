import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError, envFileWarning, loadConfig, parseEnvFile, parseRepoMap } from "./config.js";

const required = {
  TBO_HUB_URL: "http://tbo.localhost:8000/",
  TBO_WORKER_API_KEY: "k",
  TBO_WORKER_API_SECRET: "s",
  MOONSHOT_API_KEY: "m",
  TBO_HOST_CORE_BIN: "/bin/host-core",
  TBO_SIDECAR: "/lib/sidecar.js",
};

describe("parseEnvFile", () => {
  it("reads KEY=value lines with comments, export and quotes", () => {
    expect(parseEnvFile('# comment\nexport A=1\nB = "two words"\nC=\'3\'\nnot a line\n')).toEqual({ A: "1", B: "two words", C: "3" });
  });
});

describe("parseRepoMap", () => {
  it("reads app=url pairs", () => {
    expect(parseRepoMap("billing_app=acme/billing-app, tax_app=https://github.com/acme/tax_app")).toEqual({
      billing_app: "acme/billing-app",
      tax_app: "https://github.com/acme/tax_app",
    });
  });
});

describe("loadConfig", () => {
  it("uses the env file, lets the environment win, and fills the defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "tbo-worker-config-"));
    writeFileSync(join(dir, "env"), "TBO_WORKER_API_KEY=from-file\nTBO_MAX_TOOL_CALLS=12\n");
    const cfg = loadConfig({ dir, env: { ...required, TBO_WORKER_API_KEY: "from-env" } });
    expect(cfg.worker.apiKey).toBe("from-env");
    expect(cfg.hubUrl).toBe("http://tbo.localhost:8000");
    expect(cfg.limits.maxToolCalls).toBe(12);
    expect(cfg.model).toMatchObject({ baseUrl: "https://api.moonshot.ai/v1", modelId: "kimi-k2.6", apiKey: "m", apiStyle: "chat_completions" });
    expect(cfg.homeDir).toBe(join(dir, "home"));
    expect(cfg.agent).toBeUndefined();
  });

  it("names every missing setting without showing any value", () => {
    const dir = mkdtempSync(join(tmpdir(), "tbo-worker-config-"));
    try {
      loadConfig({ dir, env: { TBO_WORKER_API_SECRET: "secret-value", TBO_HOST_CORE_BIN: "/x", TBO_SIDECAR: "/y" } });
      throw new Error("expected a ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("TBO_HUB_URL");
      expect((error as Error).message).toContain("TBO_WORKER_API_KEY");
      expect((error as Error).message).toContain("TBO_MODEL_API_KEY (or MOONSHOT_API_KEY)");
      expect((error as Error).message).not.toContain("secret-value");
    }
  });

  it("refuses a negative limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "tbo-worker-config-"));
    expect(() => loadConfig({ dir, env: { ...required, TBO_MAX_MINUTES: "-1" } })).toThrow(ConfigError);
  });
});

describe("envFileWarning", () => {
  it("warns when other users can read the env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tbo-worker-config-"));
    const file = join(dir, "env");
    writeFileSync(file, "A=1\n");
    chmodSync(file, 0o644);
    expect(envFileWarning(file)).toContain("chmod 600");
    chmodSync(file, 0o600);
    expect(envFileWarning(file)).toBeUndefined();
  });
});
