//! Guardrails on the agent's shell commands and on what tools show it
//! (TBO Copilot Phase 27, Q5).
//!
//! A permission mode or a session grant lets the agent run Bash without asking,
//! so safety cannot rest on the agent's instructions alone: on 21 Nov 2026 an
//! agent dropped a site through its own shell, put a database root password on
//! command lines, and printed a site's database password into the chat. Every
//! Bash command is assessed here before the permission decision:
//!
//! - **refused**: commands that destroy data or history beyond the project (a
//!   site or database dropped, a recursive delete outside the project, a
//!   force-push, a disk or the machine itself), whatever the mode or grants;
//! - **always asked**, with a plain reason, even when the session allows Bash:
//!   creating sites, running code against a site's data, starting or stopping
//!   services, system-wide installs, discarding local work, a password on the
//!   command line;
//! - otherwise the usual permission rules apply.
//!
//! Tool output is scrubbed of secret values before the model sees it.
//!
//! The assessment reads the command as text: it splits on `;`, `&&`, `||`,
//! `|` and new lines and looks at each part's program and words. It is a
//! guardrail, not a sandbox: it catches the plain forms an agent writes.

use regex::Regex;
use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

/// What happens to a shell command before the permission decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandVerdict {
    /// The usual permission rules decide.
    Allow,
    /// Always ask the person, with this reason, even under a grant or `auto`.
    Ask(String),
    /// Never run; the reason tells the agent why and the safe way.
    Refuse(String),
}

/// Assess a shell command. `cwd` is the folder it starts in (the session's
/// workspace); `allowed_roots` are the folders a recursive delete may target
/// (the workspace, its scratch folder, the temp folder). The working folder is
/// followed through `cd` and `pushd`, so a relative delete is placed where it
/// runs; when the folder cannot be known, the delete is asked.
pub fn assess(command: &str, cwd: Option<&Path>, allowed_roots: &[PathBuf]) -> CommandVerdict {
    assess_in(command, cwd, allowed_roots, &|path: &Path| path.is_dir())
}

/// `assess`, with the check whether a folder exists given (tests use a made-up file system). A `cd`
/// to a folder that does not exist fails and leaves the shell where it was, which the guard cannot
/// count on (`cd a && cd missing; rm -rf old` deletes in a): the folder is then unknown.
fn assess_in(
    command: &str,
    cwd: Option<&Path>,
    allowed_roots: &[PathBuf],
    is_dir: &dyn Fn(&Path) -> bool,
) -> CommandVerdict {
    let mut asks: Vec<String> = Vec::new();
    if let Some(reason) = destructive_sql(command) {
        return CommandVerdict::Refuse(reason);
    }
    if pipes_download_into_shell(command) {
        asks.push("runs a script downloaded from the internet".into());
    }
    let mut here: Option<PathBuf> = cwd.map(normalize);
    for segment in segments(command) {
        let words = words(&segment);
        let Some(run) = resolve_command(&words) else {
            continue;
        };
        match run.program.as_str() {
            "cd" | "pushd" => {
                here = change_dir(here.as_deref(), &run.args).filter(|dir| is_dir(dir));
                continue;
            }
            "popd" => {
                here = None;
                continue;
            }
            _ => {}
        }
        let place = Place {
            roots: allowed_roots,
            cwd: here.as_deref(),
            from_input: run.from_input,
        };
        let mut verdicts = vec![assess_one(&run.program, &run.args, &place)];
        if run.admin {
            verdicts.push(CommandVerdict::Ask(
                "runs a command as the administrator".into(),
            ));
        }
        for verdict in verdicts {
            match verdict {
                CommandVerdict::Refuse(reason) => return CommandVerdict::Refuse(reason),
                CommandVerdict::Ask(reason) => {
                    if !asks.contains(&reason) {
                        asks.push(reason);
                    }
                }
                CommandVerdict::Allow => {}
            }
        }
    }
    if asks.is_empty() {
        CommandVerdict::Allow
    } else {
        let mut reason = asks.join("; ");
        if let Some(first) = reason.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        CommandVerdict::Ask(reason)
    }
}

const REFUSED_BENCH: &[&str] = &[
    "drop-site",
    "reinstall",
    "restore",
    "partial-restore",
    "uninstall-app",
    "remove-app",
    "trim-database",
    "trim-tables",
];
const SITE_CODE_BENCH: &[&str] = &[
    "console",
    "execute",
    "mariadb",
    "db-console",
    "postgres",
    "run-patch",
];
const SETUP_BENCH: &[&str] = &[
    "new-site",
    "install-app",
    "setup",
    "update",
    "start",
    "restart",
];
const SERVICE_PROGRAMS: &[&str] = &[
    "redis-server",
    "mysqld",
    "mariadbd",
    "mysqld_safe",
    "systemctl",
    "service",
    "launchctl",
    "kill",
    "pkill",
    "killall",
];
const PACKAGE_MANAGERS: &[&str] = &[
    "apt", "apt-get", "yum", "dnf", "apk", "port", "zypper", "pacman",
];
const PASSWORD_FLAGS: &[&str] = &[
    "--mariadb-root-password",
    "--db-root-password",
    "--root-password",
    "--admin-password",
    "--db-password",
    "--password",
];

/// Where a command runs: the allowed roots, its working folder (None: unknown),
/// and whether it takes its operands from its input (`xargs`).
struct Place<'a> {
    roots: &'a [PathBuf],
    cwd: Option<&'a Path>,
    from_input: bool,
}

fn assess_one(program: &str, args: &[String], place: &Place<'_>) -> CommandVerdict {
    let lower: Vec<String> = args.iter().map(|a| a.to_ascii_lowercase()).collect();
    let has = |word: &str| lower.iter().any(|a| a == word);
    let mut ask: Option<String> = None;
    let mut ask_for = |reason: &str| {
        if ask.is_none() {
            ask = Some(reason.to_string());
        }
    };

    if args.iter().any(|a| {
        let a = a.to_ascii_lowercase();
        PASSWORD_FLAGS
            .iter()
            .any(|flag| a == *flag || a.starts_with(&format!("{flag}=")))
    }) {
        ask_for("puts a password on the command line, where logs and other programs can see it");
    }

    match program {
        "bench" => {
            if let Some(sub) = lower.iter().find(|a| REFUSED_BENCH.contains(&a.as_str())) {
                return CommandVerdict::Refuse(format!(
                    "`bench {sub}` deletes or replaces a site's data or apps. It is never run by the agent: \
                     if it is really needed, the person runs it in their own terminal after a backup"
                ));
            }
            if lower.iter().any(|a| SITE_CODE_BENCH.contains(&a.as_str())) {
                ask_for("runs code or SQL against a site's data");
            } else if lower.iter().any(|a| SETUP_BENCH.contains(&a.as_str())) {
                ask_for("creates or changes a site, an app or the bench itself");
            } else if has("set-config") && (has("-g") || has("--global")) {
                ask_for("changes a setting for every site of the bench");
            } else if has("set-maintenance-mode") {
                ask_for("puts a site in or out of maintenance");
            }
        }
        "rm" => {
            let recursive = lower.iter().any(|a| {
                a == "--recursive"
                    || (a.starts_with('-')
                        && !a.starts_with("--")
                        && (a.contains('r') || a.contains('R')))
            });
            if recursive {
                if place.from_input {
                    ask_for("deletes paths it reads from its input");
                }
                for target in args.iter().filter(|a| !a.starts_with('-')) {
                    match delete_target(target, place) {
                        Target::Outside => {
                            return CommandVerdict::Refuse(format!(
                                "`rm -r {target}` deletes outside the project. The agent only deletes inside the \
                                 project or its scratch folder"
                            ))
                        }
                        Target::Broad => ask_for("deletes everything in a folder"),
                        Target::Unknown => {
                            ask_for("deletes in a folder the guard cannot place (after a cd it cannot follow)")
                        }
                        Target::Inside => {}
                    }
                }
            }
        }
        "git" => {
            // past git's own options (`-C <dir>`, `-c <name=value>`, `--git-dir <dir>`…) to the subcommand
            let mut at = 0;
            while at < args.len() {
                let a = args[at].as_str();
                if GIT_OPTIONS_WITH_VALUE.contains(&a) {
                    at += 2;
                } else if a.starts_with('-') {
                    at += 1;
                } else {
                    break;
                }
            }
            let sub = lower.get(at).map(String::as_str);
            let sub_args: Vec<String> = args.iter().skip(at + 1).cloned().collect();
            let sub_lower: Vec<String> = lower.iter().skip(at + 1).cloned().collect();
            let has = |word: &str| sub_lower.iter().any(|a| a == word);
            let args = &sub_args;
            let lower = &sub_lower;
            match sub {
                Some("push") => {
                    if lower.iter().any(|a| {
                        a == "-f"
                            || a == "--force"
                            || a.starts_with("--force-with-lease")
                            || a == "--mirror"
                    }) || args.iter().any(|a| a.starts_with('+'))
                    {
                        return CommandVerdict::Refuse(
                            "a force-push rewrites history others may have. Push normally; if the branch moved, \
                             pull it first"
                                .into(),
                        );
                    }
                    if has("--delete")
                        || has("-d")
                        || args.iter().any(|a| a.starts_with(':') && a.len() > 1)
                    {
                        ask_for("deletes a branch on the remote");
                    }
                }
                Some("reset") if has("--hard") => {
                    ask_for("discards uncommitted work (git reset --hard)")
                }
                Some("clean") if lower.iter().any(|a| a.starts_with('-') && a.contains('f')) => {
                    ask_for("deletes untracked files (git clean)")
                }
                Some("checkout") | Some("restore")
                    if args.iter().any(|a| a == "." || a == "--") =>
                {
                    ask_for("discards uncommitted changes")
                }
                Some("branch") if args.iter().any(|a| a == "-D" || a == "--delete") => {
                    ask_for("deletes a local branch")
                }
                Some("stash") if has("drop") || has("clear") => {
                    ask_for("deletes saved work (git stash)")
                }
                _ => {}
            }
        }
        "su" => ask_for("runs a command as the administrator"),
        "brew" => {
            if has("services") {
                ask_for("starts or stops a service");
            } else if lower.iter().any(|a| {
                matches!(
                    a.as_str(),
                    "install" | "uninstall" | "remove" | "upgrade" | "reinstall"
                )
            }) {
                ask_for("installs or removes software on the computer");
            }
        }
        "npm" | "pnpm" | "yarn" => {
            if has("-g") || has("--global") || (program == "yarn" && has("global")) {
                ask_for("installs software for the whole computer");
            }
        }
        "pipx" => ask_for("installs software for the whole computer"),
        "uv" if lower.first().map(String::as_str) == Some("tool")
            && lower.get(1).map(String::as_str) == Some("install") =>
        {
            ask_for("installs software for the whole computer")
        }
        "docker" | "podman" => {
            if lower.iter().any(|a| {
                matches!(
                    a.as_str(),
                    "rm" | "rmi" | "prune" | "down" | "kill" | "stop"
                )
            }) {
                ask_for("stops or removes containers or images");
            }
        }
        p if p.starts_with("mkfs") || p == "diskutil" || p == "fdisk" || p == "format" => {
            return CommandVerdict::Refuse("changes a disk. The agent never does that".into())
        }
        "shutdown" | "reboot" | "halt" | "poweroff" => {
            return CommandVerdict::Refuse("turns the computer off or restarts it".into())
        }
        "dd" if args.iter().any(|a| a.starts_with("of=/dev/")) => {
            return CommandVerdict::Refuse("writes over a disk device".into())
        }
        "chmod" | "chown" if args.iter().any(|a| a == "/" || a == "~" || a == "$HOME") => {
            return CommandVerdict::Refuse(
                "changes permissions of the whole computer or home folder".into(),
            )
        }
        p if SERVICE_PROGRAMS.contains(&p) => {
            ask_for("starts, stops or signals a service or program")
        }
        p if PACKAGE_MANAGERS.contains(&p)
            && lower.iter().any(|a| {
                matches!(
                    a.as_str(),
                    "install" | "remove" | "purge" | "upgrade" | "add" | "del"
                )
            }) =>
        {
            ask_for("installs or removes software on the computer");
        }
        _ => {}
    }
    match ask {
        Some(reason) => CommandVerdict::Ask(reason),
        None => CommandVerdict::Allow,
    }
}

const GIT_OPTIONS_WITH_VALUE: &[&str] = &[
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
];

enum Target {
    Inside,
    Broad,
    Outside,
    Unknown,
}

fn inside(path: &Path, roots: &[PathBuf]) -> bool {
    let normal = normalize(path);
    roots.iter().any(|root| normal.starts_with(normalize(root)))
}

fn delete_target(target: &str, place: &Place<'_>) -> Target {
    let roots = place.roots;
    let t = target.trim_matches(|c| c == '"' || c == '\'');
    if matches!(
        t,
        "/" | "/*" | "~" | "~/" | "~/*" | "$HOME" | "${HOME}" | "$HOME/" | "${HOME}/" | "$HOME/*"
    ) || t.starts_with("/*")
    {
        return Target::Outside;
    }
    if matches!(t, "." | "./" | "*" | "./*" | ".*") {
        return match place.cwd {
            Some(dir) if !inside(dir, roots) => Target::Outside,
            _ => Target::Broad,
        };
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let expanded: Option<PathBuf> = if let Some(rest) = t.strip_prefix("~/") {
        home.map(|h| h.join(rest))
    } else if let Some(rest) = t
        .strip_prefix("$HOME/")
        .or_else(|| t.strip_prefix("${HOME}/"))
    {
        home.map(|h| h.join(rest))
    } else if t.starts_with('/') {
        Some(PathBuf::from(t))
    } else {
        None
    };
    // a relative target is placed in the folder the command runs in
    let path = match expanded {
        Some(path) => path,
        None if t.contains('$') || t.contains('`') => return Target::Unknown,
        None => match place.cwd {
            Some(dir) => dir.join(t),
            None => return Target::Unknown,
        },
    };
    if inside(&path, roots) {
        Target::Inside
    } else {
        Target::Outside
    }
}

/// The folder after `cd <target>` (or `pushd`) from `from`; None when it cannot be known.
fn change_dir(from: Option<&Path>, args: &[String]) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let target = args
        .iter()
        .find(|a| !(a.starts_with('-') && a.len() > 1))
        .map(String::as_str)
        .unwrap_or("~");
    let path = match target {
        "~" | "$HOME" | "${HOME}" => home?,
        "-" => return None,
        t if t.contains('$') || t.contains('`') || t.contains('*') => return None,
        t if t.starts_with("~/") => home?.join(&t[2..]),
        t if t.starts_with('/') => PathBuf::from(t),
        t if t.starts_with('~') => return None,
        t => from?.join(t),
    };
    Some(normalize(&path))
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn destructive_sql(command: &str) -> Option<String> {
    static SQL: OnceLock<Regex> = OnceLock::new();
    static CLIENT: OnceLock<Regex> = OnceLock::new();
    let sql = SQL.get_or_init(|| {
        Regex::new(r"(?i)\b(drop\s+(database|schema|table)|truncate\s+(table\s+)?`?[a-z_])")
            .expect("sql regex")
    });
    let client = CLIENT.get_or_init(|| {
        Regex::new(r"(?i)\b(mysql|mariadb|psql|sqlite3|db-console|frappe\.db\.sql|mysqladmin)\b")
            .expect("client regex")
    });
    if sql.is_match(command) && client.is_match(command) {
        return Some(
            "drops or empties a database table or a whole database. The agent never does that; the person does it \
             in their own terminal after a backup, if it is really needed"
                .into(),
        );
    }
    None
}

fn pipes_download_into_shell(command: &str) -> bool {
    static PIPE: OnceLock<Regex> = OnceLock::new();
    PIPE.get_or_init(|| {
        Regex::new(r"(?i)\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b").expect("pipe regex")
    })
    .is_match(command)
}

/// The command's parts, split on `;`, `&&`, `||`, `|` and new lines.
fn segments(command: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            current.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                current.push(c);
            }
            ';' | '\n' | '|' | '&' => {
                if (c == '|' || c == '&') && chars.peek() == Some(&c) {
                    chars.next();
                }
                if c == '&' && current.trim_end().ends_with('>') {
                    current.push(c);
                    continue;
                }
                parts.push(std::mem::take(&mut current));
            }
            '(' | ')' | '{' | '}' => parts.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    parts.push(current);
    parts.into_iter().filter(|p| !p.trim().is_empty()).collect()
}

/// A part's words, quotes removed (a rough shell word split).
fn words(segment: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in segment.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => word.push(c),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started || !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
                started = false;
            }
            None => {
                word.push(c);
                started = true;
            }
        }
    }
    if started || !word.is_empty() {
        out.push(word);
    }
    out
}

/// The command a part really runs.
struct Run {
    /// Its file name: `/x/bin/bench` is `bench`.
    program: String,
    args: Vec<String>,
    /// Run through `sudo` or `doas`.
    admin: bool,
    /// Run through `xargs`: its operands come from its input.
    from_input: bool,
}

/// Each wrapper's options that take a value as the next word.
fn wrapper_options(wrapper: &str) -> &'static [&'static str] {
    match wrapper {
        "env" => &["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
        "nice" => &["-n", "--adjustment"],
        "time" => &["-f", "-o", "--format", "--output"],
        "exec" => &["-a"],
        "timeout" => &["-s", "-k", "--signal", "--kill-after"],
        "xargs" => &[
            "-I",
            "-i",
            "-n",
            "-P",
            "-L",
            "-l",
            "-s",
            "-E",
            "-e",
            "-d",
            "-a",
            "--max-args",
            "--max-procs",
            "--max-lines",
            "--max-chars",
            "--eof",
            "--delimiter",
            "--arg-file",
            "--replace",
        ],
        "sudo" | "doas" => &[
            "-u",
            "-g",
            "-h",
            "-p",
            "-C",
            "-r",
            "-t",
            "-U",
            "-D",
            "--user",
            "--group",
            "--host",
            "--prompt",
            "--close-from",
            "--role",
            "--type",
            "--other-user",
            "--chdir",
        ],
        _ => &[],
    }
}

const WRAPPERS: &[&str] = &[
    "env", "nohup", "time", "command", "exec", "nice", "timeout", "xargs", "stdbuf", "sudo", "doas",
];

/// The command a part runs, past variable assignments and wrappers (`env`, `nohup`, `nice -n 10`,
/// `timeout 30`, `xargs -0`, `sudo -u root`…) with their own options: a wrapper's option is never
/// taken for the program (`nice -n 10 bench drop-site` is a bench command).
fn resolve_command(words: &[String]) -> Option<Run> {
    let mut i = 0;
    let mut admin = false;
    let mut from_input = false;
    while i < words.len() {
        let w = &words[i];
        let is_assignment = w
            .split_once('=')
            .map(|(name, _)| {
                !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            })
            .unwrap_or(false);
        if is_assignment {
            i += 1;
            continue;
        }
        let base = Path::new(w)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| w.clone());
        if !WRAPPERS.contains(&base.as_str()) {
            return Some(Run {
                program: base,
                args: words[i + 1..].to_vec(),
                admin,
                from_input,
            });
        }
        admin |= matches!(base.as_str(), "sudo" | "doas");
        from_input |= base == "xargs";
        let with_value = wrapper_options(&base);
        i += 1;
        while i < words.len() {
            let a = words[i].as_str();
            if a == "--" {
                i += 1;
                break;
            }
            if base == "env" && a.contains('=') && !a.starts_with('-') {
                i += 1;
                continue;
            }
            if !a.starts_with('-') || a == "-" {
                break;
            }
            // `command -v x` only says where x is; it runs nothing
            if base == "command" && (a.contains('v') || a.contains('V')) {
                return None;
            }
            i += if with_value.contains(&a) { 2 } else { 1 };
        }
        // `timeout <duration> <command>`
        if base == "timeout" {
            i += 1;
        }
    }
    None
}

const REDACTED: &str = "[redacted]";

/// Tool output with secret values replaced by `[redacted]`: private keys, the
/// values of password, secret, token and key settings (JSON, `.env`, YAML), a
/// password given on a command line, authorization headers, and well-known
/// token formats.
pub fn scrub_secrets(text: &str) -> Cow<'_, str> {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        let names = r"[a-z0-9_.\-]*(?:password|passwd|secret|token|api_?key|apikey|private_?key|access_?key|encryption_key|client_secret|auth_token|authorization)[a-z0-9_.\-]*";
        vec![
            (
                Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----")
                    .expect("key block"),
                "-----BEGIN PRIVATE KEY----- [redacted] -----END PRIVATE KEY-----",
            ),
            (
                // the whole string, escaped quotes and all
                Regex::new(&format!(r#"(?i)("{names}"\s*:\s*")(?:[^"\\]|\\.)+(")"#)).expect("json"),
                "${1}[redacted]${2}",
            ),
            (
                Regex::new(&format!(r#"(?im)^(\s*(?:export\s+)?{names}\s*[=:]\s*)(?:"(?:[^"\\\n]|\\.)+"|'[^'\n]+'|[^\s"'\n]+)[ \t]*$"#))
                    .expect("env"),
                "${1}[redacted]",
            ),
            (
                // NAME=value inside a command line (`DB_PASSWORD='x' bench …`), quotes respected
                Regex::new(r#"(?i)(^|[\s;&|(])((?:export\s+)?[a-z_][a-z0-9_]*(?:password|passwd|secret|token|api_?key|apikey|private_?key|access_?key|encryption_key|client_secret|auth_token)[a-z0-9_]*=)(?:'[^'\n]*'|"(?:[^"\\\n]|\\.)*"|\\.|[^\s'"\\;&|])+"#)
                    .expect("inline"),
                "${1}${2}[redacted]",
            ),
            (
                // a password given as an argument: the whole shell word, quoted and unquoted pieces and
                // escaped spaces together (`'alpha beta'gamma`, `alpha\ beta`)
                Regex::new(r#"(?i)(--(?:mariadb-root-|db-root-|root-|admin-|db-)?password(?:=|\s+))(?:'[^'\n]*'|"(?:[^"\\\n]|\\.)*"|\\.|[^\s'"\\])+"#)
                    .expect("flag"),
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
    });
    let mut out: Cow<'_, str> = Cow::Borrowed(text);
    for (regex, replacement) in rules {
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

/// The longest partial line held back before it is scrubbed and passed on anyway.
const STREAM_HOLD_MAX: usize = 64 * 1024;

/// Scrubs output as it streams, before it is captured, clipped or sent to the
/// app as a live notification: whole lines are scrubbed (a partial line waits
/// for its end), and a private key block is hidden from its BEGIN line to its
/// END line even when it arrives in pieces.
#[derive(Debug, Default)]
pub struct StreamScrubber {
    pending: String,
    in_key: bool,
    /// An overlong line was cut inside a secret value: the rest of that line is hidden.
    hide_rest_of_line: bool,
}

/// The start of a secret value that may run past where an overlong line is cut: a JSON value, a
/// NAME= assignment or a password argument, to the end of the text.
fn dangling_secret() -> &'static Regex {
    static DANGLING: OnceLock<Regex> = OnceLock::new();
    DANGLING.get_or_init(|| {
        let names = r"[a-z0-9_.\-]*(?:password|passwd|secret|token|api_?key|apikey|private_?key|access_?key|encryption_key|client_secret|auth_token|authorization)[a-z0-9_.\-]*";
        Regex::new(&format!(
            r#"(?i)("{names}"\s*:\s*"|(?:^|[\s;&|(]){names}\s*[=:]\s*|--(?:mariadb-root-|db-root-|root-|admin-|db-)?password(?:=|\s+))[^\n]*$"#
        ))
        .expect("dangling")
    })
}

impl StreamScrubber {
    /// The scrubbed complete lines of what has arrived so far.
    pub fn push(&mut self, text: &str) -> String {
        self.pending.push_str(text);
        let mut out = String::new();
        loop {
            if self.hide_rest_of_line {
                match self.pending.find(['\n', '\r']) {
                    Some(end) => {
                        self.pending.drain(..end);
                        self.hide_rest_of_line = false;
                    }
                    None => {
                        self.pending.clear();
                        return out;
                    }
                }
            }
            let Some(end) = self.pending.find(['\n', '\r']) else {
                break;
            };
            let line: String = self.pending.drain(..=end).collect();
            out.push_str(&self.line(&line));
        }
        if self.pending.len() > STREAM_HOLD_MAX {
            // a line longer than the hold is passed on in pieces; one cut inside a secret value hides
            // the value and the rest of its line (CodeRabbit on #34)
            let rest = std::mem::take(&mut self.pending);
            let scrubbed = self.line(&rest);
            match dangling_secret().captures(&scrubbed) {
                Some(found) => {
                    let start = found.get(1).map(|m| m.end()).unwrap_or(scrubbed.len());
                    out.push_str(&scrubbed[..start]);
                    out.push_str(REDACTED);
                    self.hide_rest_of_line = true;
                }
                None => out.push_str(&scrubbed),
            }
        }
        out
    }

    /// The scrubbed rest, at the end of the output.
    pub fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.pending);
        if rest.is_empty() {
            return rest;
        }
        self.line(&rest)
    }

    fn line(&mut self, line: &str) -> String {
        let is_begin = line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----");
        let is_end = line.contains("-----END") && line.contains("PRIVATE KEY-----");
        if self.in_key {
            if is_end {
                self.in_key = false;
                return "-----END PRIVATE KEY-----\n".into();
            }
            return String::new();
        }
        if is_begin && !is_end {
            self.in_key = true;
            return "-----BEGIN PRIVATE KEY----- [redacted]\n".into();
        }
        scrub_secrets(line).into_owned()
    }
}

#[cfg(test)]
mod tests;
