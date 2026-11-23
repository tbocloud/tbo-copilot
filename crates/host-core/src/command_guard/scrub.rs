//! Secret values hidden from what tools show the model (TBO Copilot Phase 27, Q5).
//!
//! `scrub_secrets` hides the values in a whole text. `StreamScrubber` does the
//! same for output that arrives in pieces (a running command), before it is
//! captured, clipped or sent to the app as a live notification: it passes text
//! on only once no secret value in it can still be running on, so a key and its
//! value are always scrubbed together, whether the value is on the key's line,
//! on the next line, or cut by the hold limit.

use regex::{Captures, Regex};
use std::borrow::Cow;
use std::path::Path;
use std::sync::OnceLock;

pub(super) const REDACTED: &str = "[redacted]";

/// Setting names whose values are secret (JSON keys, `.env` and YAML names).
const NAMES: &str = r"[a-z0-9_.\-]*(?:password|passwd|secret|token|api_?key|apikey|private_?key|access_?key|encryption_key|client_secret|auth_token|authorization)[a-z0-9_.\-]*";
/// The same as a shell variable name; the name may start with the secret word (`TOKEN=`).
const VAR_NAMES: &str = r"[a-z0-9_]*(?:password|passwd|secret|token|api_?key|apikey|private_?key|access_?key|encryption_key|client_secret|auth_token)[a-z0-9_]*";
/// What may come before a shell variable assignment: the start, a space or an operator.
const WORD_START: &str = r"(?:^|[\s;&|(])";
/// A whole shell word: quoted and unquoted pieces and escaped characters together.
const SHELL_WORD: &str = r#"(?:'[^'\n]*'|"(?:[^"\\\n]|\\.)*"|\\.|[^\s'"\\;&|])+"#;
/// A shell word cut short: whole pieces, then perhaps an unclosed quote or a lone backslash.
const SHELL_WORD_SO_FAR: &str =
    r#"(?:'[^'\n]*'|"(?:[^"\\\n]|\\.)*"|\\.|[^\s'"\\;&|])*(?:'[^'\n]*|"(?:[^"\\\n]|\\.)*\\?|\\)?"#;
const PASSWORD_FLAG: &str = r"--(?:mariadb-root-|db-root-|root-|admin-|db-)?password(?:=|\s+)";

fn rules() -> &'static [(Regex, &'static str)] {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            (
                // the whole string, escaped quotes and all; the key may be on the line before
                Regex::new(&format!(r#"(?i)("{NAMES}"\s*:\s*")(?:[^"\\]|\\.)+(")"#)).expect("json"),
                "${1}[redacted]${2}",
            ),
            (
                Regex::new(&format!(r#"(?im)^(\s*(?:export\s+)?{NAMES}\s*[=:]\s*)(?:"(?:[^"\\\n]|\\.)+"|'[^'\n]+'|[^\s"'\n]+)[ \t]*$"#))
                    .expect("env"),
                "${1}[redacted]",
            ),
            (
                // NAME=value inside a command line (`DB_PASSWORD='x' bench …`, `env TOKEN=x …`)
                Regex::new(&format!(r"(?i)({WORD_START})((?:export\s+)?{VAR_NAMES}=){SHELL_WORD}"))
                    .expect("inline"),
                "${1}${2}[redacted]",
            ),
            (
                // a password given as an argument: the whole shell word
                Regex::new(&format!(r"(?i)({PASSWORD_FLAG}){SHELL_WORD}")).expect("flag"),
                "${1}[redacted]",
            ),
            (
                Regex::new(r"(?i)(authorization:\s*(?:bearer|token|basic)\s+)\S+").expect("header"),
                "${1}[redacted]",
            ),
            (
                Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_\-]{20,}|xox[abprs]-[A-Za-z0-9\-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b")
                    .expect("tokens"),
                REDACTED,
            ),
            (
                Regex::new(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b").expect("jwt"),
                REDACTED,
            ),
        ]
    })
}

fn key_block() -> &'static Regex {
    static KEY: OnceLock<Regex> = OnceLock::new();
    KEY.get_or_init(|| {
        Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----")
            .expect("key block")
    })
}

/// Tool output with secret values replaced by `[redacted]`: private keys, the
/// values of password, secret, token and key settings (JSON, `.env`, YAML), a
/// password given on a command line, authorization headers, and well-known
/// token formats. Lines stay where they were: a key block keeps its line count.
pub fn scrub_secrets(text: &str) -> Cow<'_, str> {
    let mut out: Cow<'_, str> = Cow::Borrowed(text);
    if key_block().is_match(&out) {
        let replaced = key_block()
            .replace_all(&out, |found: &Captures<'_>| {
                let lines = found[0].matches('\n').count();
                if lines == 0 {
                    "-----BEGIN PRIVATE KEY----- [redacted] -----END PRIVATE KEY-----".to_string()
                } else {
                    format!(
                        "-----BEGIN PRIVATE KEY-----{}\n-----END PRIVATE KEY-----",
                        "\n[redacted]".repeat(lines - 1)
                    )
                }
            })
            .into_owned();
        out = Cow::Owned(replaced);
    }
    for (regex, replacement) in rules() {
        if regex.is_match(&out) {
            out = Cow::Owned(regex.replace_all(&out, *replacement).into_owned());
        }
    }
    out
}

/// A Frappe site's configuration files hold its database password and keys.
pub fn is_site_config(path: &str) -> bool {
    is_site_config_path(Path::new(path))
}

pub fn is_site_config_path(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some("site_config.json") | Some("common_site_config.json")
    )
}

/// A secret at the very end of a text whose value may not have ended yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Open {
    /// Where the secret starts (its key, name or flag).
    start: usize,
    /// Where its value starts; the text's end when no value has arrived yet.
    value: usize,
}

/// The first secret at the end of `text` whose value may still be running on: a JSON key with no
/// value yet (perhaps on the next line) or an unclosed string value, a `NAME=` / `name:` setting, a
/// password argument or an authorization header whose value reaches the end.
fn open_secret(text: &str) -> Option<Open> {
    static OPEN: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = OPEN.get_or_init(|| {
        [
            format!(r#"(?i)("{NAMES}"\s*:\s*")((?:[^"\\]|\\.)*\\?)\z"#),
            format!(r#"(?i)("{NAMES}"\s*:?\s*)()\z"#),
            format!(r#"(?im)(^[ \t]*(?:export\s+)?{NAMES}[ \t]*[=:]\s*)("(?:[^"\\\n]|\\.)*\\?|'[^'\n]*|[^\s"'\n]*)\z"#),
            format!(r"(?i)({WORD_START}(?:export\s+)?{VAR_NAMES}=)({SHELL_WORD_SO_FAR})\z"),
            format!(r"(?i)({PASSWORD_FLAG})({SHELL_WORD_SO_FAR})\z"),
            r"(?i)(authorization:[ \t]*(?:bearer|token|basic)[ \t]+)(\S*)\z".to_string(),
        ]
        .iter()
        .map(|p| Regex::new(p).expect("open secret"))
        .collect()
    });
    patterns
        .iter()
        .filter_map(|regex| {
            let found = regex.captures(text)?;
            let head = found.get(1)?;
            Some(Open {
                start: head.start(),
                value: head.end(),
            })
        })
        .min_by_key(|open| open.start)
}

/// The cut moved to the end of any secret that spans it, so a secret is never scrubbed in halves.
fn past_secrets(text: &str, mut cut: usize) -> usize {
    loop {
        let moved = std::iter::once(key_block())
            .chain(rules().iter().map(|(regex, _)| regex))
            .flat_map(|regex| regex.find_iter(text))
            .filter(|m| m.start() < cut && cut < m.end())
            .map(|m| m.end())
            .max();
        match moved {
            Some(end) => cut = end,
            None => return cut,
        }
    }
}

fn floor_char_boundary(text: &str, mut at: usize) -> usize {
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The longest text held back before an overlong line is passed on in pieces.
const STREAM_HOLD_MAX: usize = 64 * 1024;
/// What stays held when an overlong line is passed on, so a key name or a short value cut at the
/// edge is joined with what follows before it is scrubbed.
const STREAM_TAIL: usize = 4 * 1024;

/// Scrubs output as it streams. Complete lines are passed on, scrubbed, except
/// from a secret whose value may still be running on (held until it ends); a
/// private key block is hidden from its BEGIN line to its END line even when it
/// arrives in pieces.
#[derive(Debug, Default)]
pub struct StreamScrubber {
    pending: String,
    in_key: bool,
    /// A secret value longer than the hold was cut: the rest of its line is hidden.
    hide_rest_of_line: bool,
}

impl StreamScrubber {
    /// The scrubbed part of what has arrived so far that is safe to pass on.
    pub fn push(&mut self, text: &str) -> String {
        self.pending.push_str(text);
        if !text.contains(['\n', '\r']) && self.pending.len() <= STREAM_HOLD_MAX {
            return String::new();
        }
        let mut out = String::new();
        if self.hide_rest_of_line && !self.skip_hidden_line() {
            return out;
        }
        let hold_from = open_secret(&self.pending).map_or(self.pending.len(), |open| open.start);
        if let Some(end) = self.pending[..hold_from].rfind(['\n', '\r']) {
            let lines: String = self.pending.drain(..=end).collect();
            out.push_str(&self.emit(&lines));
        }
        if self.pending.len() > STREAM_HOLD_MAX {
            out.push_str(&self.pass_on_overlong());
        }
        out
    }

    /// The scrubbed rest, at the end of the output (also after a timeout or an abort): a secret
    /// value that never ended is hidden.
    pub fn finish(&mut self) -> String {
        if self.hide_rest_of_line && !self.skip_hidden_line() {
            return String::new();
        }
        let rest = std::mem::take(&mut self.pending);
        match open_secret(&rest) {
            Some(open) if open.value < rest.len() => {
                let mut out = self.emit(&rest[..open.value]);
                out.push_str(REDACTED);
                out
            }
            _ => self.emit(&rest),
        }
    }

    /// Drops the hidden rest of a line; false when its end has not arrived yet.
    fn skip_hidden_line(&mut self) -> bool {
        match self.pending.find(['\n', '\r']) {
            Some(end) => {
                self.pending.drain(..end);
                self.hide_rest_of_line = false;
                true
            }
            None => {
                self.pending.clear();
                false
            }
        }
    }

    /// A line longer than the hold, passed on in part.
    fn pass_on_overlong(&mut self) -> String {
        let text = std::mem::take(&mut self.pending);
        match open_secret(&text) {
            // a secret near the end: everything before it goes on, the secret waits
            Some(open) if text.len() - open.start <= STREAM_TAIL => {
                self.pending = text[open.start..].to_string();
                self.emit(&text[..open.start])
            }
            // a secret value longer than the tail: hidden, with the rest of its line
            Some(open) => {
                self.hide_rest_of_line = true;
                let mut out = self.emit(&text[..open.value]);
                out.push_str(REDACTED);
                out
            }
            // no secret running on: all but the tail goes on, never cutting a secret in two
            None => {
                let cut = past_secrets(&text, floor_char_boundary(&text, text.len() - STREAM_TAIL));
                self.pending = text[cut..].to_string();
                self.emit(&text[..cut])
            }
        }
    }

    /// Scrubbed text: key-block lines through the block state, the rest scrubbed together.
    fn emit(&mut self, text: &str) -> String {
        let mut out = String::new();
        let mut plain = String::new();
        for line in text.split_inclusive(['\n', '\r']) {
            let is_begin = line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----");
            let is_end = line.contains("-----END") && line.contains("PRIVATE KEY-----");
            if self.in_key {
                if is_end {
                    self.in_key = false;
                    out.push_str("-----END PRIVATE KEY-----\n");
                }
                continue;
            }
            if is_begin && !is_end {
                out.push_str(&scrub_secrets(&std::mem::take(&mut plain)));
                self.in_key = true;
                out.push_str("-----BEGIN PRIVATE KEY----- [redacted]\n");
                continue;
            }
            plain.push_str(line);
        }
        out.push_str(&scrub_secrets(&plain));
        out
    }
}
