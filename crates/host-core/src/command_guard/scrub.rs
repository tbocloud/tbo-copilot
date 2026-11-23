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

/// A Frappe site's configuration by its content, whatever its name (a copy, a hard link): a JSON
/// object with a `db_password` or an `encryption_key` setting.
pub fn looks_like_site_config(text: &str) -> bool {
    text.trim_start().starts_with('{')
        && (text.contains("\"db_password\"") || text.contains("\"encryption_key\""))
}

/// What kind of secret runs on at the end of a text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenKind {
    /// Inside a JSON string value (its opening quote is before `value`).
    JsonValue,
    /// A JSON key whose value has not started (`colon`: its `:` has arrived).
    JsonKey { colon: bool },
    /// A `NAME=` or `name:` setting, a password argument or an authorization header.
    Other,
}

/// A secret at the very end of a text whose value may not have ended yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Open {
    /// Where the secret starts (its key, name or flag).
    start: usize,
    /// Where its value starts; the text's end when no value has arrived yet.
    value: usize,
    kind: OpenKind,
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
        .enumerate()
        .filter_map(|(at, regex)| {
            let found = regex.captures(text)?;
            let head = found.get(1)?;
            let kind = match at {
                0 => OpenKind::JsonValue,
                1 => OpenKind::JsonKey {
                    colon: head.as_str().trim_end().ends_with(':'),
                },
                _ => OpenKind::Other,
            };
            Some(Open {
                start: head.start(),
                value: head.end(),
                kind,
            })
        })
        .min_by_key(|open| open.start)
}

/// Where a run of name characters (`DB_PASSWORD`, `--admin-password`) that holds a secret word
/// reaches the end of `text` from before `cut`: a setting's name cut before its `=` has arrived.
fn name_at(text: &str, cut: usize) -> Option<usize> {
    static SECRET_WORD: OnceLock<Regex> = OnceLock::new();
    let secret_word = SECRET_WORD.get_or_init(|| {
        Regex::new(r"(?i)password|passwd|secret|token|api_?key|apikey|private_?key|access_?key|encryption_key|client_secret|auth_token|authorization")
            .expect("secret word")
    });
    let start = text
        .char_indices()
        .rev()
        .take_while(|(_, c)| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .last()
        .map(|(at, _)| at)?;
    (start < cut && secret_word.is_match(&text[start..])).then_some(start)
}

/// A double-quoted string at a cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AtCut {
    /// The cut is not inside a string, or inside a value's string (whose key is not secret: a
    /// secret key's value is an open secret).
    Clear,
    /// The cut is inside a string that ends at this position: cut there instead.
    Past(usize),
    /// The cut is inside a string in a key's place that has not ended (`escaped`: it ends with a
    /// backslash): it may be a secret key whose name has not arrived whole.
    OpenKey { start: usize, escaped: bool },
}

fn string_at(text: &str, cut: usize) -> AtCut {
    let bytes = text.as_bytes();
    let from = text[..cut].rfind('\n').map_or(0, |i| i + 1);
    let mut start: Option<usize> = None;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(from) {
        match start {
            Some(s) => {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    if s < cut && cut <= i {
                        return AtCut::Past(i + 1);
                    }
                    start = None;
                } else if b == b'\n' {
                    start = None;
                }
            }
            None if i >= cut => return AtCut::Clear,
            None if b == b'"' => start = Some(i),
            None => {}
        }
    }
    match start {
        Some(s) if s < cut => {
            let before = text[from..s].trim_end();
            if before.is_empty() || before.ends_with('{') || before.ends_with(',') {
                AtCut::OpenKey { start: s, escaped }
            } else {
                AtCut::Clear
            }
        }
        _ => AtCut::Clear,
    }
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

/// The last line end at or before `end` that no whole secret spans, so a JSON key on one line and
/// its value on the next are passed on together; None when every line end before is inside one.
fn line_end_outside_secrets(text: &str, mut end: usize) -> Option<usize> {
    loop {
        let spanning = rules()
            .iter()
            .flat_map(|(regex, _)| regex.find_iter(text))
            .filter(|m| m.start() <= end && end < m.end())
            .map(|m| m.start())
            .min();
        match spanning {
            None => return Some(end),
            Some(start) => end = text[..start].rfind(['\n', '\r'])?,
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

/// What the stream scrubber is hiding, after a cut fell inside a secret.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Hiding {
    #[default]
    Nothing,
    /// A key string cut by the hold, to its closing quote.
    Key { escaped: bool },
    /// After a hidden key: a `:` next makes the next value hidden too.
    AfterKey,
    /// A setting's name cut by the hold, to its end; an `=` or `:` after it (or white space after
    /// a `--` argument) makes the next value hidden too.
    Name { argument: bool },
    /// A secret's value that has not started: the next value (a quoted string or a word) is hidden,
    /// wherever it comes (on a later line, after any white space).
    Value,
    /// Inside that value.
    ValueWord { quote: Option<char>, escaped: bool },
}

/// Scrubs output as it streams. Complete lines are passed on, scrubbed, except
/// from a secret whose value may still be running on (held until it ends); a
/// private key block is hidden from its BEGIN line to its END line even when it
/// arrives in pieces. A line longer than the hold is passed on in pieces, never
/// cutting a secret in two: a key or value cut there is hidden to its end.
#[derive(Debug, Default)]
pub struct StreamScrubber {
    pending: String,
    in_key: bool,
    hiding: Hiding,
}

impl StreamScrubber {
    /// The scrubbed part of what has arrived so far that is safe to pass on.
    pub fn push(&mut self, text: &str) -> String {
        self.pending.push_str(text);
        if !text.contains(['\n', '\r']) && self.pending.len() <= STREAM_HOLD_MAX {
            return String::new();
        }
        let mut out = self.pass_hidden();
        if self.hiding != Hiding::Nothing {
            return out;
        }
        let hold_from = open_secret(&self.pending).map_or(self.pending.len(), |open| open.start);
        let line_end = self.pending[..hold_from]
            .rfind(['\n', '\r'])
            .and_then(|end| line_end_outside_secrets(&self.pending, end));
        if let Some(end) = line_end {
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
        let mut out = self.pass_hidden();
        if self.hiding != Hiding::Nothing {
            self.pending.clear();
            return out;
        }
        let rest = std::mem::take(&mut self.pending);
        match open_secret(&rest) {
            Some(open) if open.value < rest.len() => {
                out.push_str(&self.emit(&rest[..open.value]));
                out.push_str(REDACTED);
            }
            _ => out.push_str(&self.emit(&rest)),
        }
        out
    }

    /// Passes over what is being hidden at the start of `pending`. Only the white space and the
    /// `:` between a hidden key and its value are shown, with `[redacted]` for a hidden value.
    fn pass_hidden(&mut self) -> String {
        let mut shown = String::new();
        let mut end = self.pending.len();
        for (i, c) in self.pending.char_indices() {
            let ends_word =
                |c: char| c.is_whitespace() || matches!(c, ',' | '}' | ']' | ';' | '&' | '|');
            match self.hiding {
                Hiding::Nothing => {
                    end = i;
                    break;
                }
                Hiding::Key { escaped } => {
                    self.hiding = match c {
                        _ if escaped => Hiding::Key { escaped: false },
                        '\\' => Hiding::Key { escaped: true },
                        '"' => Hiding::AfterKey,
                        _ => Hiding::Key { escaped: false },
                    };
                }
                Hiding::Name { .. }
                    if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') => {}
                Hiding::Name { .. } if c == '=' || c == ':' => {
                    shown.push(c);
                    self.hiding = Hiding::Value;
                }
                Hiding::Name { argument: true } if c == ' ' || c == '\t' => {
                    shown.push(c);
                    self.hiding = Hiding::Value;
                }
                Hiding::Name { .. } => {
                    self.hiding = Hiding::Nothing;
                    end = i;
                    break;
                }
                Hiding::AfterKey if c.is_whitespace() => shown.push(c),
                Hiding::AfterKey if c == ':' => {
                    shown.push(c);
                    self.hiding = Hiding::Value;
                }
                Hiding::AfterKey => {
                    self.hiding = Hiding::Nothing;
                    end = i;
                    break;
                }
                Hiding::Value if c.is_whitespace() => shown.push(c),
                Hiding::Value if ends_word(c) => {
                    self.hiding = Hiding::Nothing;
                    end = i;
                    break;
                }
                Hiding::Value => {
                    shown.push_str(REDACTED);
                    self.hiding = Hiding::ValueWord {
                        quote: matches!(c, '"' | '\'').then_some(c),
                        escaped: false,
                    };
                }
                Hiding::ValueWord { quote, escaped } => {
                    self.hiding = match (quote, c) {
                        _ if escaped => Hiding::ValueWord {
                            quote,
                            escaped: false,
                        },
                        (q, '\\') if q != Some('\'') => Hiding::ValueWord {
                            quote,
                            escaped: true,
                        },
                        (Some(q), c) if c == q => Hiding::ValueWord {
                            quote: None,
                            escaped: false,
                        },
                        (Some(_), _) => Hiding::ValueWord {
                            quote,
                            escaped: false,
                        },
                        (None, '"' | '\'') => Hiding::ValueWord {
                            quote: Some(c),
                            escaped: false,
                        },
                        (None, c) if ends_word(c) => {
                            self.hiding = Hiding::Nothing;
                            end = i;
                            break;
                        }
                        (None, _) => Hiding::ValueWord {
                            quote,
                            escaped: false,
                        },
                    };
                }
            }
        }
        self.pending.drain(..end);
        shown
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
            // a secret whose value is longer than the tail, or has not come after a long key or
            // much white space: the key goes on, its value is hidden wherever it comes
            Some(open) => {
                let mut out = self.emit(&text[..open.value]);
                self.hiding = match open.kind {
                    OpenKind::JsonValue => {
                        out.push_str(REDACTED);
                        Hiding::ValueWord {
                            quote: Some('"'),
                            escaped: false,
                        }
                    }
                    OpenKind::JsonKey { colon: false } => Hiding::AfterKey,
                    OpenKind::JsonKey { colon: true } | OpenKind::Other => Hiding::Value,
                };
                self.pending = text[open.value..].to_string();
                out.push_str(&self.pass_hidden());
                out
            }
            // no secret running on: all but the tail goes on, never cutting a secret or a string
            // in two; a long string in a key's place that has not ended is hidden, with its value
            None => {
                let mut cut = floor_char_boundary(&text, text.len() - STREAM_TAIL);
                loop {
                    cut = past_secrets(&text, cut);
                    match string_at(&text, cut) {
                        AtCut::Past(end) if end > cut => cut = end,
                        AtCut::OpenKey { start, escaped } => {
                            let mut out = self.emit(&text[..start]);
                            out.push_str(REDACTED);
                            self.hiding = Hiding::Key { escaped };
                            return out;
                        }
                        _ => break,
                    }
                }
                // a long setting name with a secret word, its `=` not arrived: hidden, with its value
                if let Some(start) = name_at(&text, cut) {
                    let mut out = self.emit(&text[..start]);
                    out.push_str(REDACTED);
                    self.hiding = Hiding::Name {
                        argument: text[start..].starts_with("--"),
                    };
                    return out;
                }
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
