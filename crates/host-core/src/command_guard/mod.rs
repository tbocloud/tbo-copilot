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
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

mod scrub;
pub use scrub::{is_site_config, is_site_config_path, scrub_secrets, StreamScrubber};

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
/// followed through `cd` and `pushd`, through `&&`, `||`, `;`, pipes and
/// subshells, so a relative delete is placed in every folder it may run in; a
/// link in the project to a folder outside it is followed; when a folder cannot
/// be known, the delete is asked.
pub fn assess(command: &str, cwd: Option<&Path>, allowed_roots: &[PathBuf]) -> CommandVerdict {
    let world = World {
        home: std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from),
        canonical: &|path: &Path| std::fs::canonicalize(path).ok(),
    };
    assess_in(command, cwd, allowed_roots, &world)
}

/// What the guard knows of the computer: the home folder, and a path as the file system resolves
/// it (links followed), when it exists. Tests give a made-up one.
struct World<'a> {
    home: Option<PathBuf>,
    canonical: &'a dyn Fn(&Path) -> Option<PathBuf>,
}

/// The folders a part of the command may run in; `None` is a folder the guard cannot know.
type Dirs = Vec<Option<PathBuf>>;

/// More possible folders than this and the folder is taken as unknown.
const MAX_DIRS: usize = 16;

fn add_dirs(into: &mut Dirs, from: &[Option<PathBuf>]) {
    for dir in from {
        if !into.contains(dir) {
            into.push(dir.clone());
        }
    }
    if into.len() > MAX_DIRS {
        *into = vec![None];
    }
}

fn both(a: &[Option<PathBuf>], b: &[Option<PathBuf>]) -> Dirs {
    let mut out = a.to_vec();
    add_dirs(&mut out, b);
    out
}

fn assess_in(
    command: &str,
    cwd: Option<&Path>,
    allowed_roots: &[PathBuf],
    world: &World<'_>,
) -> CommandVerdict {
    let mut asks: Vec<String> = Vec::new();
    if let Some(reason) = destructive_sql(command) {
        return CommandVerdict::Refuse(reason);
    }
    if pipes_download_into_shell(command) {
        asks.push("runs a script downloaded from the internet".into());
    }
    // The folders the shell may be in after the last part, when that part succeeded and when it
    // failed: a `cd` can fail (no such folder, no permission) and leave the shell where it was, and
    // `&&` / `||` decide which of the two the next part runs in.
    let mut ok: Dirs = vec![cwd.map(normalize)];
    let mut failed: Dirs = Vec::new();
    let mut join = Op::Seq;
    let mut subshells: Vec<Dirs> = Vec::new();
    // a pipeline's parts run side by side, each in the folder the pipeline started in
    let mut pipeline: Option<(Dirs, Dirs)> = None;
    let items = items(command);
    for (at, item) in items.iter().enumerate() {
        let text = match item {
            Item::Op(op) => {
                join = *op;
                continue;
            }
            // a subshell's `cd` ends with it
            Item::Open => {
                subshells.push(both(&ok, &failed));
                continue;
            }
            Item::Close => {
                if let Some(before) = subshells.pop() {
                    ok = before.clone();
                    failed = before;
                }
                continue;
            }
            Item::Part(text) => text,
        };
        let next = match items.get(at + 1) {
            Some(Item::Op(op)) => Some(*op),
            _ => None,
        };
        let (input, carry_ok, carry_failed): (Dirs, Dirs, Dirs) = match (join, &pipeline) {
            (Op::And, _) => (ok.clone(), Vec::new(), failed.clone()),
            (Op::Or, _) => (failed.clone(), ok.clone(), Vec::new()),
            (Op::Pipe, Some((input, _))) => (input.clone(), Vec::new(), Vec::new()),
            _ => (both(&ok, &failed), Vec::new(), Vec::new()),
        };
        if join != Op::Pipe && next == Some(Op::Pipe) {
            let all = both(&both(&input, &carry_ok), &carry_failed);
            pipeline = Some((input.clone(), all));
        }
        let detached = join == Op::Pipe || next == Some(Op::Pipe) || next == Some(Op::Background);

        let words = words(text);
        let run = resolve_command(&words);
        let changed: Option<Dirs> = match &run {
            Some(run) if run.program == "cd" || run.program == "pushd" => Some(
                input
                    .iter()
                    .map(|dir| change_dir(dir.as_deref(), &run.args, world.home.as_deref()))
                    .collect(),
            ),
            Some(run) if run.program == "popd" => Some(vec![None]),
            _ => None,
        };
        if let (Some(run), None) = (&run, &changed) {
            let dirs = if input.is_empty() {
                vec![None]
            } else {
                input.clone()
            };
            let place = Place {
                roots: allowed_roots,
                dirs: &dirs,
                from_input: run.from_input,
                world,
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

        if detached {
            // in a pipeline or in the background: run in a subshell, except perhaps a pipeline's
            // last part (zsh runs it in the shell itself), where a `cd` may or may not last
            let mut all = match (&pipeline, join) {
                (Some((_, all)), Op::Pipe) => all.clone(),
                _ => both(&both(&input, &carry_ok), &carry_failed),
            };
            let last_of_pipeline =
                join == Op::Pipe && next != Some(Op::Pipe) && next != Some(Op::Background);
            if let (Some(changed), true) = (&changed, last_of_pipeline) {
                add_dirs(&mut all, changed);
            }
            ok = all.clone();
            failed = all;
        } else {
            ok = both(changed.as_deref().unwrap_or(&input), &carry_ok);
            failed = both(&input, &carry_failed);
        }
        if next != Some(Op::Pipe) {
            pipeline = None;
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
    /// Every folder the part may run in.
    dirs: &'a [Option<PathBuf>],
    from_input: bool,
    world: &'a World<'a>,
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

/// Where a recursive delete lands, from safest to worst.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Target {
    Inside,
    Broad,
    Unknown,
    Outside,
}

fn inside(path: &Path, roots: &[PathBuf]) -> bool {
    let normal = normalize(path);
    roots.iter().any(|root| normal.starts_with(normalize(root)))
}

/// Where a delete target lands, in the worst of the folders the command may run in.
fn delete_target(target: &str, place: &Place<'_>) -> Target {
    let t = target.trim_matches(|c| c == '"' || c == '\'');
    if matches!(
        t,
        "/" | "/*" | "~" | "~/" | "~/*" | "$HOME" | "${HOME}" | "$HOME/" | "${HOME}/" | "$HOME/*"
    ) || t.starts_with("/*")
    {
        return Target::Outside;
    }
    place
        .dirs
        .iter()
        .map(|dir| delete_target_from(t, dir.as_deref(), place))
        .max()
        .unwrap_or(Target::Unknown)
}

fn delete_target_from(t: &str, dir: Option<&Path>, place: &Place<'_>) -> Target {
    if matches!(t, "." | "./" | "*" | "./*" | ".*") {
        return match dir {
            Some(dir) => match contained(dir, true, place) {
                Target::Inside => Target::Broad,
                other => other,
            },
            None => Target::Broad,
        };
    }
    let home = place.world.home.as_deref();
    let in_home = |rest: &str| home.map(|h| h.join(rest));
    let path = if let Some(rest) = t.strip_prefix("~/") {
        in_home(rest)
    } else if let Some(rest) = t
        .strip_prefix("$HOME/")
        .or_else(|| t.strip_prefix("${HOME}/"))
    {
        in_home(rest)
    } else if t.starts_with('/') {
        Some(PathBuf::from(t))
    } else if t.contains('$') || t.contains('`') || t.starts_with('~') {
        None
    } else {
        // a relative target is placed in the folder the command runs in
        dir.map(|dir| dir.join(t))
    };
    match path {
        // `x/` (and `x/.`) is the folder a link `x` points to; `x` alone is the link itself
        Some(path) => contained(&path, t.ends_with('/') || t.ends_with("/."), place),
        None => Target::Unknown,
    }
}

/// Inside the allowed folders as written and as the file system resolves the folders on the way
/// (a link in the project to a folder outside it). The path is resolved as the system does, link
/// by link before each `..` (`linked/../old` is next to the link's target, not in the project).
/// `follow_last` resolves the path itself too.
fn contained(path: &Path, follow_last: bool, place: &Place<'_>) -> Target {
    if !inside(&normalize(path), place.roots) {
        return Target::Outside;
    }
    let probe = if follow_last {
        path.to_path_buf()
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.to_path_buf())
    };
    let Some(real) = resolve_existing(&probe, place.world) else {
        return Target::Unknown;
    };
    let real_roots: Vec<PathBuf> = place
        .roots
        .iter()
        .map(|root| (place.world.canonical)(root).unwrap_or_else(|| normalize(root)))
        .collect();
    if inside(&real, &real_roots) {
        Target::Inside
    } else {
        Target::Outside
    }
}

/// `path` with its longest existing part resolved by the file system and the rest as written.
fn resolve_existing(path: &Path, world: &World<'_>) -> Option<PathBuf> {
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut at = path.to_path_buf();
    loop {
        if let Some(mut real) = (world.canonical)(&at) {
            for name in rest.iter().rev() {
                real.push(name);
            }
            return Some(real);
        }
        rest.push(at.file_name()?.to_os_string());
        if !at.pop() {
            return None;
        }
    }
}

/// The folder after `cd <target>` (or `pushd`) from `from`, if it succeeds; None when it cannot be
/// known.
fn change_dir(from: Option<&Path>, args: &[String], home: Option<&Path>) -> Option<PathBuf> {
    let target = args
        .iter()
        .find(|a| !(a.starts_with('-') && a.len() > 1))
        .map(String::as_str)
        .unwrap_or("~");
    let path = match target {
        "~" | "$HOME" | "${HOME}" => home?.to_path_buf(),
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

/// How a part follows the one before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    /// `;`, a new line or the start: runs whatever happened before.
    Seq,
    /// `&&`: runs only if the part before succeeded.
    And,
    /// `||`: runs only if the part before failed.
    Or,
    /// `|`: runs side by side with the part before.
    Pipe,
    /// `&`: the part before runs in the background.
    Background,
}

#[derive(Debug, PartialEq, Eq)]
enum Item {
    Part(String),
    Op(Op),
    /// `(` or `$(`: a subshell starts.
    Open,
    /// `)`: it ends.
    Close,
}

fn end_part(items: &mut Vec<Item>, current: &mut String) {
    if current.trim().is_empty() {
        current.clear();
    } else {
        items.push(Item::Part(std::mem::take(current)));
    }
}

/// The command's parts with the operators between them and its subshells. `{ … }` groups run in
/// the same shell and only separate parts; a brace inside a word (`${HOME}`, `build{1,2}`) stays
/// in it, as do `&>` and `>&`.
fn items(command: &str) -> Vec<Item> {
    let mut items = Vec::new();
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
            // the word keeps a `$` for what the substitution gives, which the guard cannot know
            // (`cd $(git rev-parse --show-toplevel)` goes to an unknown folder, not home)
            '$' if chars.peek() == Some(&'(') => {
                current.push('$');
                chars.next();
                end_part(&mut items, &mut current);
                items.push(Item::Open);
            }
            '(' => {
                end_part(&mut items, &mut current);
                items.push(Item::Open);
            }
            ')' => {
                end_part(&mut items, &mut current);
                items.push(Item::Close);
            }
            '{' | '}' if current.trim().is_empty() || current.ends_with(char::is_whitespace) => {
                end_part(&mut items, &mut current);
            }
            ';' | '\n' => {
                end_part(&mut items, &mut current);
                items.push(Item::Op(Op::Seq));
            }
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                end_part(&mut items, &mut current);
                items.push(Item::Op(Op::And));
            }
            '&' if chars.peek() == Some(&'>') || current.trim_end().ends_with('>') => {
                current.push(c)
            }
            '&' => {
                end_part(&mut items, &mut current);
                items.push(Item::Op(Op::Background));
            }
            '|' if chars.peek() == Some(&'|') => {
                chars.next();
                end_part(&mut items, &mut current);
                items.push(Item::Op(Op::Or));
            }
            '|' => {
                if chars.peek() == Some(&'&') {
                    chars.next();
                }
                end_part(&mut items, &mut current);
                items.push(Item::Op(Op::Pipe));
            }
            _ => current.push(c),
        }
    }
    end_part(&mut items, &mut current);
    items
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

/// Shell words that come before a command (`if rm …`, `then rm …`, `! rm …`).
const KEYWORDS: &[&str] = &["if", "then", "else", "elif", "do", "while", "until", "!"];

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
        if is_assignment || KEYWORDS.contains(&w.as_str()) {
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

#[cfg(test)]
mod tests;
