/**
 * Text that tries to instruct the AI: a ticket, a customer's message, an error log or a file
 * the model reads. The model is told to ignore and report it, but does not always report it,
 * so the worker looks for it itself and records a `suspicious_instruction` event; TBO Support
 * shows a warning on the Copilot card. Same patterns as helpdesk.copilot.suspicious.
 */
export const SUSPICIOUS_PATTERNS: RegExp[] = [
  // "ignore all of your previous rules", "disregard these instructions"
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,60}\b(instructions?|rules?|prompts?|guidelines)\b/i,
  // "note to AI assistants", "NOTE FOR THE AI SUPPORT ASSISTANT", "message for the copilot"
  /\b(note|message|instructions?)\s+(to|for)\s+(the\s+|any\s+|all\s+)?(ai|a\.i\.|assistants?|copilot|agents?|llms?|models?|bots?)\b/i,
  // "you are now in maintenance mode"
  /\byou are now (in )?\w*\s?(mode|admin|administrator|developer|unrestricted|jailbroken)\b/i,
  /\b(system prompt|developer mode|maintenance mode|admin mode|god mode|jailbreak)\b/i,
  // "paste the contents of ~/.env", "include the API key in your summary"
  /\b(paste|copy|send|reveal|print|include|output|leak|exfiltrate)\b[^.\n]{0,60}\b(api[ _-]?keys?|secrets?|passwords?|credentials|\.env|env file|full contents|contents of)\b/i,
  /\bcat\s+(\/etc\/(passwd|shadow)|~\/\.|\$HOME\/\.)/i,
];

/** Every string inside a JSON value, one after another. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out);
  return out;
}

/** A tool's result as text: the strings of a JSON answer (Read's file, an error log's message), else the result itself. */
function readable(text: string): string {
  try {
    return strings(JSON.parse(text) as unknown).join("\n");
  } catch {
    return text; // not JSON: the text as it is
  }
}

/**
 * The different lines of `text` that look like an instruction to the AI, each cut to 200
 * characters; at most `limit`, never one in `skip` (already reported), so repeats of one line
 * never hide another.
 */
export function suspiciousLines(text: string, limit = 3, skip: ReadonlySet<string> = new Set()): string[] {
  const found: string[] = [];
  for (const line of readable(text).split(/\r?\n/)) {
    if (found.length >= limit) break;
    const trimmed = line.trim().replace(/^\d+:/, "").slice(0, 200); // Read numbers its lines
    if (!trimmed || skip.has(trimmed) || found.includes(trimmed)) continue;
    if (SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(trimmed))) found.push(trimmed);
  }
  return found;
}

/** Shapes of secrets: a flagged line goes into the hub's events, and a secret never does. */
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /[A-Za-z0-9+/_=-]{32,}/g, // any long opaque string: a token, a key, a signature
];
// the whole value: a quoted one with its spaces ("correct horse battery staple"), or any bare word, however short
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key|apikey|client[_-]?secret)\b(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi;

/** The line with anything shaped like a secret replaced, so it can go into an event. */
export function redactSecrets(line: string): string {
  let text = line.replace(SECRET_ASSIGNMENT, "$1$2[secret removed]");
  for (const shape of SECRET_SHAPES) text = text.replace(shape, "[secret removed]");
  return text;
}

/** Remembers what was reported, so a file read twice gives one event. */
export class SuspiciousWatch {
  private readonly seen = new Set<string>();

  /** The new suspicious lines in a tool's result, at most 5 a run. */
  check(text: string): string[] {
    if (this.seen.size >= 5) return [];
    const fresh = suspiciousLines(text, 5 - this.seen.size, this.seen);
    for (const line of fresh) this.seen.add(line);
    return fresh.map(redactSecrets);
  }
}
