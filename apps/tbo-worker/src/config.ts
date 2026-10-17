import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One OpenAI-compatible model the worker's engine talks to, with its prices. */
export type ModelConfig = {
  providerName: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  apiStyle: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** USD per million tokens; 0 when unknown, then the run's cost is 0. */
  priceInPerMillion: number;
  /** Input tokens the provider served from its cache, usually much cheaper; defaults to the input price. */
  priceCachedPerMillion?: number;
  priceOutPerMillion: number;
};

/**
 * A provider in the worker's own settings file: where its models answer and the key for them.
 * TBO Support names only the section and the model for each job (`run_context.models`), so a
 * key is only ever sent to an address this file holds.
 */
export type ProviderConfig = Omit<ModelConfig, "modelId" | "priceInPerMillion" | "priceCachedPerMillion" | "priceOutPerMillion"> & {
  /** The TBO Support section it serves (Settings → AI providers). */
  section: string;
};

/** The providers the settings file may name: `<prefix>_API_KEY` turns one on, the rest have defaults. */
export const PROVIDERS = [
  { prefix: "TBO_PROVIDER_OPENAI", section: "OpenAI", providerName: "TBO Worker · OpenAI", baseUrl: "https://api.openai.com/v1", apiStyle: "responses" },
  // Kimi: TBO Support reaches it through its Anthropic-compatible section, the engine through Moonshot's OpenAI-compatible address
  { prefix: "TBO_PROVIDER_MOONSHOT", section: "Anthropic-compatible", providerName: "TBO Worker · Moonshot", baseUrl: "https://api.moonshot.ai/v1", apiStyle: "chat_completions" },
] as const;

export type Limits = {
  maxToolCalls: number;
  maxMinutes: number;
  /** Tokens summed over every model request; each request resends the conversation, so this grows quickly. */
  maxTokens: number;
  /** Dollars per run, when the model's prices are set; 0 means no dollar limit. */
  maxUsd: number;
  claimIntervalMs: number;
  heartbeatIntervalMs: number;
};

/** A fix job's limits: it reads, edits and tests, so it gets more room than an investigation. */
export type FixLimits = {
  maxToolCalls: number;
  maxMinutes: number;
  maxTokens: number;
  /** Rounds of "change the code, run the check" the model may take before the worker gives up. */
  maxRounds: number;
};

export type HubAuth = { apiKey: string; apiSecret: string };

export type WorkerConfig = {
  workerId: string;
  /** `~/.tbo-worker`: the env file, the engine's data, clones, run folders and logs. */
  dir: string;
  dataDir: string;
  /** An empty home folder for the engine and git: nothing from the desktop app's setup reaches a run. */
  homeDir: string;
  reposDir: string;
  runsDir: string;
  logsDir: string;
  hubUrl: string;
  worker: HubAuth;
  /** An agent's key, used only by `eval` to start and read runs. */
  agent?: HubAuth;
  /** The providers this worker has a key for; each stage takes its model from TBO Support's list. */
  providers: ProviderConfig[];
  /** The older single model (`TBO_MODEL_*`): every stage uses it when TBO Support names no model this worker has a key for. */
  model?: ModelConfig;
  githubToken?: string;
  hostCoreBinary: string;
  sidecarEntry: string;
  nodeBinary: string;
  limits: Limits;
  keepRuns: boolean;
  /** app → repository, for apps a run names that the site registry does not list (evaluation). */
  repoMap: Record<string, string>;
  /** Tests only: repositories may be local folders. */
  allowLocalRepos?: boolean;
  /** The sandbox runner's socket on the server; without it the worker only investigates. */
  sandboxSocket?: string;
  fixLimits?: FixLimits;
  /** GitHub's REST API, for opening a fix's pull request (tests point it elsewhere). */
  githubApi?: string;
};

export class ConfigError extends Error {}

const DEFAULT_MODEL_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_MODEL_ID = "kimi-k2.6";

/** `KEY=value` lines; `#` comments (whole lines, or after an unquoted value), an optional `export ` and quotes are allowed. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // an unquoted value ends at a comment: `KEY=value   # note`
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]!] = value;
  }
  return values;
}

/** `app=url,app2=url2` */
export function parseRepoMap(text: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of (text ?? "").split(",")) {
    const [app, url] = part.split("=").map((piece) => piece?.trim());
    if (app && url) map[app] = url;
  }
  return map;
}

/** The repository this package lives in (apps/tbo-worker/{src,dist} → the root). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function findHostCore(root = repoRoot()): string | undefined {
  return [join(root, "target", "release", "pi-desktop-host-core"), join(root, "target", "debug", "pi-desktop-host-core")].find(
    (candidate) => existsSync(candidate),
  );
}

export function findSidecar(root = repoRoot()): string | undefined {
  return [
    join(root, "packages", "agent-runtime", "dist-bundle", "sidecar.js"),
    join(root, "packages", "agent-runtime", "dist", "sidecar.js"),
  ].find((candidate) => existsSync(candidate));
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a number above 0`);
  return parsed;
}

/** Prices and the dollar limit: 0 means unknown or off. */
function nonNegative(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new ConfigError(`${name} must be 0 or more`);
  return parsed;
}

/** A model address, without trailing slashes. A key only travels encrypted: https, or plain http to this machine (a local test model). */
function modelUrl(raw: string, name: string): string {
  const value = raw.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigError(`${name} must use https (plain http only to this machine)`);
  }
  return value;
}

/** The env file's path inside the worker's folder. */
export function envFilePath(dir: string): string {
  return join(dir, "env");
}

/** Warns (returns a message) when the env file can be read by other users. */
export function envFileWarning(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const mode = statSync(path).mode & 0o777;
  return mode & 0o077 ? `${path} can be read by other users (mode ${mode.toString(8)}); run chmod 600 on it` : undefined;
}

/**
 * Reads the worker's settings: the env file in `dir` first, then the process
 * environment on top. Missing required values are named together, never shown.
 */
export function loadConfig(options: { env?: NodeJS.ProcessEnv; dir?: string } = {}): WorkerConfig {
  const processEnv = options.env ?? process.env;
  const dir = resolve(options.dir ?? processEnv.TBO_WORKER_DIR ?? join(homedir(), ".tbo-worker"));
  const fileEnv = existsSync(envFilePath(dir)) ? parseEnvFile(readFileSync(envFilePath(dir), "utf8")) : {};
  const env: Record<string, string | undefined> = { ...fileEnv, ...processEnv };

  const missing: string[] = [];
  const need = (name: string, ...alternatives: string[]): string => {
    for (const key of [name, ...alternatives]) {
      const value = env[key]?.trim();
      if (value) return value;
    }
    missing.push(alternatives.length ? `${name} (or ${alternatives.join(", ")})` : name);
    return "";
  };
  const hubUrl = need("TBO_HUB_URL").replace(/\/+$/, "");
  const worker = { apiKey: need("TBO_WORKER_API_KEY"), apiSecret: need("TBO_WORKER_API_SECRET") };
  const apiKey = env.TBO_MODEL_API_KEY?.trim() || env.MOONSHOT_API_KEY?.trim() || "";
  const providers = PROVIDERS.flatMap((provider): ProviderConfig[] => {
    const key = env[`${provider.prefix}_API_KEY`]?.trim();
    if (!key) return [];
    const value = (name: string) => env[`${provider.prefix}_${name}`]?.trim();
    return [
      {
        section: provider.section,
        providerName: provider.providerName,
        baseUrl: modelUrl(value("BASE_URL") || provider.baseUrl, `${provider.prefix}_BASE_URL`),
        apiKey: key,
        apiStyle: value("API_STYLE") || provider.apiStyle,
        contextWindow: positive(value("CONTEXT_WINDOW"), 256_000, `${provider.prefix}_CONTEXT_WINDOW`),
        maxOutputTokens: positive(value("MAX_OUTPUT_TOKENS"), 16_000, `${provider.prefix}_MAX_OUTPUT_TOKENS`),
      },
    ];
  });
  if (!apiKey && !providers.length) missing.push("TBO_PROVIDER_OPENAI_API_KEY (or TBO_PROVIDER_MOONSHOT_API_KEY, or the older TBO_MODEL_API_KEY)");
  const hostCoreBinary = env.TBO_HOST_CORE_BIN?.trim() || findHostCore() || "";
  const sidecarEntry = env.TBO_SIDECAR?.trim() || findSidecar() || "";
  if (!hostCoreBinary) missing.push("TBO_HOST_CORE_BIN (no built pi-desktop-host-core found)");
  if (!sidecarEntry) missing.push("TBO_SIDECAR (no built agent sidecar found)");
  if (missing.length) throw new ConfigError(`Missing settings: ${missing.join("; ")}`);

  const agentKey = env.TBO_HUB_AGENT_API_KEY?.trim();
  const agentSecret = env.TBO_HUB_AGENT_API_SECRET?.trim();
  return {
    workerId: env.TBO_WORKER_ID?.trim() || `tbo-worker@${hostname()}`,
    dir,
    dataDir: join(dir, "data"),
    homeDir: join(dir, "home"),
    reposDir: join(dir, "repos"),
    runsDir: join(dir, "runs"),
    logsDir: join(dir, "logs"),
    hubUrl,
    worker,
    ...(agentKey && agentSecret ? { agent: { apiKey: agentKey, apiSecret: agentSecret } } : {}),
    providers,
    ...(apiKey
      ? {
          model: {
            providerName: env.TBO_MODEL_PROVIDER_NAME?.trim() || "TBO Worker model",
            baseUrl: modelUrl(env.TBO_MODEL_BASE_URL?.trim() || DEFAULT_MODEL_BASE_URL, "TBO_MODEL_BASE_URL"),
            modelId: env.TBO_MODEL_ID?.trim() || DEFAULT_MODEL_ID,
            apiKey,
            apiStyle: env.TBO_MODEL_API_STYLE?.trim() || "chat_completions",
            contextWindow: positive(env.TBO_MODEL_CONTEXT_WINDOW, 256_000, "TBO_MODEL_CONTEXT_WINDOW"),
            maxOutputTokens: positive(env.TBO_MODEL_MAX_OUTPUT_TOKENS, 16_000, "TBO_MODEL_MAX_OUTPUT_TOKENS"),
            priceInPerMillion: nonNegative(env.TBO_MODEL_PRICE_IN, 0, "TBO_MODEL_PRICE_IN"),
            priceOutPerMillion: nonNegative(env.TBO_MODEL_PRICE_OUT, 0, "TBO_MODEL_PRICE_OUT"),
            ...(env.TBO_MODEL_PRICE_CACHED?.trim()
              ? { priceCachedPerMillion: nonNegative(env.TBO_MODEL_PRICE_CACHED, 0, "TBO_MODEL_PRICE_CACHED") }
              : {}),
          },
        }
      : {}),
    ...(env.GITHUB_TOKEN?.trim() ? { githubToken: env.GITHUB_TOKEN.trim() } : {}),
    hostCoreBinary,
    sidecarEntry,
    nodeBinary: env.TBO_NODE?.trim() || process.execPath,
    limits: {
      maxToolCalls: positive(env.TBO_MAX_TOOL_CALLS, 60, "TBO_MAX_TOOL_CALLS"),
      maxMinutes: positive(env.TBO_MAX_MINUTES, 20, "TBO_MAX_MINUTES"),
      maxTokens: positive(env.TBO_MAX_TOKENS, 4_000_000, "TBO_MAX_TOKENS"),
      maxUsd: nonNegative(env.TBO_MAX_USD, 0, "TBO_MAX_USD"),
      claimIntervalMs: positive(env.TBO_CLAIM_SECONDS, 15, "TBO_CLAIM_SECONDS") * 1000,
      heartbeatIntervalMs: positive(env.TBO_HEARTBEAT_SECONDS, 30, "TBO_HEARTBEAT_SECONDS") * 1000,
    },
    keepRuns: env.TBO_KEEP_RUNS === "1",
    repoMap: parseRepoMap(env.TBO_REPOS),
    ...(env.TBO_SANDBOX_SOCKET?.trim() ? { sandboxSocket: env.TBO_SANDBOX_SOCKET.trim() } : {}),
    fixLimits: {
      maxToolCalls: positive(env.TBO_FIX_MAX_TOOL_CALLS, 120, "TBO_FIX_MAX_TOOL_CALLS"),
      maxMinutes: positive(env.TBO_FIX_MAX_MINUTES, 60, "TBO_FIX_MAX_MINUTES"),
      maxTokens: positive(env.TBO_FIX_MAX_TOKENS, 8_000_000, "TBO_FIX_MAX_TOKENS"),
      maxRounds: positive(env.TBO_FIX_MAX_ROUNDS, 3, "TBO_FIX_MAX_ROUNDS"),
    },
    githubApi: (env.TBO_GITHUB_API?.trim() || "https://api.github.com").replace(/\/+$/, ""),
  };
}

/** The GitHub CLI's token, when it is logged in: used when GITHUB_TOKEN is not set, so the token is not copied into a file. */
export function githubTokenFromGh(): string | undefined {
  try {
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}
