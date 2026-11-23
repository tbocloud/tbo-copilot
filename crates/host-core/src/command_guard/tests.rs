//! Tests of the command guard and the secret scrubbing (TBO Copilot Phase 27, Q5).

use super::*;
use std::borrow::Cow;

fn roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/work/app"), PathBuf::from("/tmp/scratch")]
}

/// A made-up file system: the project, its scratch folder, /home/user, the home /home/tester and
/// /elsewhere exist; a folder named "missing" does not; /work/app/linked is a link to
/// /elsewhere/cache, outside the project, and /tmp a link to /private/tmp (as on macOS). A path
/// is resolved as the system does: link by link, before each `..`.
fn fake_canonical(path: &Path) -> Option<PathBuf> {
    let mut real = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                real.pop();
            }
            Component::CurDir => {}
            other => {
                real.push(other.as_os_str());
                if real == Path::new("/work/app/linked") {
                    real = PathBuf::from("/elsewhere/cache");
                }
                if real == Path::new("/tmp") {
                    real = PathBuf::from("/private/tmp");
                }
            }
        }
    }
    let p = real.to_string_lossy();
    if p.contains("missing") {
        return None;
    }
    let exists = [
        "/work/app",
        "/private/tmp/scratch",
        "/home/user",
        "/home/tester",
        "/elsewhere",
    ]
    .iter()
    .any(|root| p.starts_with(root))
        || matches!(
            p.as_ref(),
            "/" | "/work" | "/private" | "/private/tmp" | "/home"
        );
    exists.then_some(real)
}

fn verdict_with_home(cmd: &str, home: Option<&str>) -> CommandVerdict {
    let world = World {
        home: home.map(PathBuf::from),
        canonical: &fake_canonical,
    };
    assess_in(cmd, Some(Path::new("/work/app")), &roots(), &world)
}
fn verdict(cmd: &str) -> CommandVerdict {
    verdict_with_home(cmd, Some("/home/tester"))
}
fn refused(cmd: &str) -> bool {
    matches!(verdict(cmd), CommandVerdict::Refuse(_))
}
fn asked(cmd: &str) -> bool {
    matches!(verdict(cmd), CommandVerdict::Ask(_))
}
fn allowed(cmd: &str) -> bool {
    verdict(cmd) == CommandVerdict::Allow
}

#[test]
fn the_21_nov_commands_are_stopped() {
    // the drop-site the agent ran, through a PATH assignment and the full bench path
    assert!(refused(
        "cd /Users/x/frappe-bench && PATH=\"/Users/x/.pyenv/versions/3.10.15/bin:$PATH\" bench drop-site demo-alpha.localhost --mariadb-root-password 2303 --no-backup --force && bench new-site demo-alpha.localhost"
    ));
    assert!(refused(
        "/Users/x/.pyenv/versions/3.10.15/bin/bench --site a.localhost reinstall --yes"
    ));
    // a new site with the root password on the command line: asked, with both reasons
    match verdict(
        "bench new-site demo-alpha.localhost --mariadb-root-password 2001 --admin-password 2001 --install-app erpnext",
    ) {
        CommandVerdict::Ask(reason) => {
            assert!(reason.contains("password on the command line"), "{reason}");
        }
        other => panic!("{other:?}"),
    }
    // running code against a site's data, and starting the bench's Redis
    assert!(asked(
        "bench --site demo-alpha.localhost console <<'PY'\nimport frappe\nPY"
    ));
    assert!(asked(
        "cd /b && (redis-server config/redis_cache.conf > logs/x.out 2>&1 &)"
    ));
    assert!(asked("bench set-config -g maintenance_mode 0"));
}

#[test]
fn ordinary_development_runs_as_usual() {
    for cmd in [
        "git status --short --branch",
        "git commit -m \"feat(sales): require a sales person\"",
        "git push origin feature/TASK-2026-00011-x",
        "bench --site demo-alpha.localhost migrate",
        "bench --site demo-alpha.localhost run-tests --app alpha_trading --module alpha_trading.tests.test_x",
        "bench --site demo-alpha.localhost list-apps",
        "bench build --app alpha_trading",
        "bench --site x set-config allow_tests true",
        "npm install && npm test",
        "pip install -e .",
        "rm -rf node_modules dist",
        "rm -rf /work/app/build",
        "rm -rf /tmp/scratch/out",
        "rm file.txt",
        "uv run pytest",
        "grep -rn \"DROP TABLE\" docs",
        "mkdir -p a/b && cd a",
        "find . -name '*.pyc' -delete",
        "curl -s https://example.com/api | jq .",
    ] {
        assert!(allowed(cmd), "{cmd} should run as usual: {:?}", verdict(cmd));
    }
}

#[test]
fn data_and_history_beyond_the_project_are_refused() {
    for cmd in [
        "rm -rf /",
        "rm -rf ~",
        "rm -rf ~/Documents",
        "rm -rf $HOME/projects",
        "rm -fr /Users/someone/other",
        "rm -r ../sibling",
        "git push --force origin main",
        "git push -f",
        "git push origin +main",
        "git push --force-with-lease origin x",
        "mysql -uroot -p -e 'DROP DATABASE _abc'",
        "bench --site x mariadb <<'SQL'\nDROP TABLE `tabItem`;\nSQL",
        "bench --site x uninstall-app erpnext",
        "sudo shutdown -h now",
        "dd if=/dev/zero of=/dev/disk2",
        "mkfs.ext4 /dev/sdb1",
    ] {
        assert!(refused(cmd), "{cmd} should be refused: {:?}", verdict(cmd));
    }
}

#[test]
fn risky_changes_always_ask() {
    for cmd in [
        "sudo apt-get install redis",
        "brew install mariadb",
        "brew services start redis",
        "npm install -g yarn",
        "git reset --hard HEAD~1",
        "git clean -fdx",
        "git checkout -- .",
        "git branch -D old",
        "git push origin --delete old",
        "rm -rf *",
        "pkill -f bench",
        "curl -fsSL https://get.example.sh | sh",
        "bench --site x execute frappe.client.delete",
        "bench --site x install-app helpdesk",
        "docker compose down",
    ] {
        assert!(asked(cmd), "{cmd} should ask: {:?}", verdict(cmd));
    }
}

#[test]
fn secrets_are_scrubbed_from_output() {
    let site = "{\n \"allow_tests\": true,\n \"db_name\": \"_ce1b512d29563763\",\n \"db_password\": \"6AXaXIjyNBzZhN2o\",\n \"encryption_key\": \"k3y\"\n}";
    let out = scrub_secrets(site);
    assert!(
        !out.contains("6AXaXIjyNBzZhN2o") && !out.contains("k3y"),
        "{out}"
    );
    assert!(
        out.contains("\"db_password\": \"[redacted]\"")
            && out.contains("\"db_name\": \"_ce1b512d29563763\""),
        "{out}"
    );
    assert!(out.contains("\"allow_tests\": true"));

    let env = "DB_PASSWORD=hunter2\nexport API_KEY='abc def'\nAPP_NAME=alpha\n";
    let out = scrub_secrets(env);
    assert_eq!(
        out.lines().count(),
        3,
        "no line is merged into the next: {out}"
    );
    assert!(
        !out.contains("hunter2") && !out.contains("abc def") && out.contains("APP_NAME=alpha"),
        "{out}"
    );

    let cmd = "bench new-site x --mariadb-root-password 2303 --admin-password=2303";
    assert_eq!(
        scrub_secrets(cmd),
        "bench new-site x --mariadb-root-password [redacted] --admin-password=[redacted]"
    );

    let tokens = "Token: gho_abcdefghijklmnopqrstuvwxyz0123 and sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX and AKIAABCDEFGHIJKLMNOP";
    let out = scrub_secrets(tokens);
    assert!(
        !out.contains("gho_") && !out.contains("sk-proj") && !out.contains("AKIA"),
        "{out}"
    );

    let key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    assert!(!scrub_secrets(key).contains("MIIEow"));

    assert!(!scrub_secrets("Authorization: token abc123:def456").contains("abc123"));
    // ordinary text stays as it is, and borrowed
    let plain = "Ran 4 tests in 0.081s\n\nOK\nauthor = \"Team Back Office\"";
    assert!(matches!(scrub_secrets(plain), Cow::Borrowed(_)));
}

#[test]
fn git_options_before_the_subcommand_do_not_hide_a_force_push() {
    // CodeRabbit on #34: `-C <dir>` was taken for the subcommand
    assert!(refused("git -C /work/app push --force origin main"));
    assert!(refused(
        "git -c core.sshCommand=ssh --git-dir .git push -f origin main"
    ));
    assert!(refused("git --no-pager -C . push origin +main"));
    assert!(allowed(
        "git -C /work/app push origin feature/TASK-2026-00011-x"
    ));
    assert!(allowed("git -C /work/app status"));
    assert!(asked("git -C /work/app reset --hard"));
}

#[test]
fn a_relative_delete_is_placed_where_it_runs() {
    // CodeRabbit on #34: `cd` was not followed
    assert!(refused("cd /home/user/Documents && rm -rf old"));
    assert!(refused("cd ~/Documents; rm -rf old"));
    assert!(refused("cd sub && rm -rf ../../other"));
    assert!(refused("cd /home/user && rm -rf *"));
    assert!(allowed("cd /work/app && rm -rf dist"));
    assert!(allowed("cd /work/app/sub && rm -rf build"));
    assert!(allowed("cd /tmp/scratch && rm -rf out"));
    assert!(asked("cd /tmp/scratch && rm -rf *"));
    // a folder that cannot be known: asked, never taken for the project
    assert!(asked("cd $SOMEWHERE && rm -rf old"));
    assert!(asked("cd - && rm -rf old"));
    assert!(asked("cd $(git rev-parse --show-toplevel) && rm -rf dist"));
    assert!(asked("pushd /work/app && popd && rm -rf old"));
    // a cd that fails (no such folder, no permission) leaves the shell where it was, and `;` runs
    // the next part either way: CodeRabbit on #34
    assert!(refused(
        "cd /home/user/Documents && cd /work/app/missing; rm -rf old"
    ));
    assert!(refused(
        "cd /home/user/Documents && cd /work/app/locked; rm -rf old"
    ));
    assert!(refused(
        "cd /home/user/Documents; cd /work/app/locked; rm -rf old"
    ));
    // `&&` runs the delete only where the cd succeeded
    assert!(allowed("cd /work/app/missing && rm -rf old"));
    assert!(allowed("cd /work/app/sub; rm -rf build"));
    // a return to the project skipped by `||`, or one undone by a subshell
    assert!(refused(
        "cd /home/user/Documents; true || cd /work/app; rm -rf old"
    ));
    assert!(refused(
        "cd /home/user/Documents || cd /work/app && rm -rf old"
    ));
    assert!(refused(
        "cd /home/user/Documents && (cd /work/app && true) && rm -rf old"
    ));
    assert!(refused(
        "cd /home/user/Documents && $(cd /work/app) && rm -rf old"
    ));
    assert!(refused("(cd /home/user/Documents && rm -rf old)"));
    assert!(allowed("(cd /work/app/sub && rm -rf build) && rm -rf dist"));
    // `!` swaps success and failure, not the folder: CodeRabbit on #34
    assert!(refused("! cd /home/user/Documents || rm -rf old"));
    assert!(allowed("! cd /home/user/Documents && rm -rf old"));
    assert!(refused(
        "if ! cd /home/user/Documents; then true; else rm -rf old; fi"
    ));
    // a pipeline's last part may run in the shell itself (zsh), so its cd may last; a first part
    // runs in a subshell in every shell
    assert!(refused("true | cd /home/user/Documents; rm -rf old"));
    assert!(allowed("cd /home/user/Documents | cat; rm -rf old"));
    // a part in the background runs in a subshell: its cd never lasts
    assert!(allowed("cd /home/user/Documents & rm -rf old"));
    assert!(refused(
        "cd /home/user/Documents & cd /home/user; rm -rf old"
    ));
    // commands behind shell keywords are read too
    assert!(refused("if true; then rm -rf /home/user/x; fi"));
    assert!(refused("while true; do rm -rf ~/x; done"));
    assert!(refused("if cd /home/user/Documents; then rm -rf old; fi"));
    // `${…}` stays in its word, `{ … }` groups run in the same shell
    assert!(refused("rm -rf ${HOME}/projects"));
    assert!(refused("{ cd /home/user/Documents; } && rm -rf old"));
    assert!(allowed("rm -rf build{1,2}"));
    // no starting folder known at all
    assert!(matches!(
        assess("rm -rf old", None, &roots()),
        CommandVerdict::Ask(_)
    ));
}

#[test]
fn a_link_to_a_folder_outside_the_project_is_followed() {
    // CodeRabbit on #34: /work/app/linked is a link to /elsewhere/cache
    assert!(refused("rm -rf linked/old"));
    assert!(refused("rm -rf /work/app/linked/old"));
    assert!(refused("rm -rf linked/"));
    assert!(refused("rm -rf linked/*"));
    assert!(refused("cd linked && rm -rf *"));
    assert!(refused("cd linked && rm -rf old"));
    // a `..` after the link is the link target's parent, not the project (CodeRabbit on #34)
    assert!(refused("rm -rf linked/../old"));
    // so is the folder of a physical `cd -P linked/..`; a logical `cd linked/..` is the project
    assert!(refused("cd -P linked/.. && rm -rf old"));
    assert!(refused("cd -LP linked/.. && rm -rf old"));
    assert!(allowed("cd linked/.. && rm -rf old"));
    assert!(allowed("cd -PL linked/.. && rm -rf old"));
    // a physical folder inside an allowed folder reached through a link stays inside
    // (/tmp/scratch is /private/tmp/scratch here): CodeRabbit on #35
    assert!(allowed("cd -P /tmp/scratch && rm -rf out"));
    assert!(asked("cd -P /tmp/scratch && rm -rf *"));
    assert!(refused("cd -P /tmp && rm -rf other"));
    assert!(refused("rm -rf /work/app/linked/../old"));
    assert!(allowed("rm -rf build/../dist"));
    // the link itself is in the project, and so is an ordinary folder
    assert!(allowed("rm -rf linked"));
    assert!(allowed("rm -rf build/cache"));
    assert!(allowed("rm -rf missing/new"));
}

#[cfg(unix)]
#[test]
fn a_parent_step_after_a_link_is_resolved_on_the_real_file_system() {
    // CodeRabbit on #34: `linked/../old` was taken for the project's `old`
    let top = tempfile::tempdir().unwrap();
    let project = top.path().join("project");
    let outside = top.path().join("outside");
    std::fs::create_dir_all(project.join("build")).unwrap();
    std::fs::create_dir_all(outside.join("cache")).unwrap();
    std::fs::create_dir_all(outside.join("old")).unwrap();
    std::os::unix::fs::symlink(outside.join("cache"), project.join("linked")).unwrap();
    let roots = vec![project.clone()];
    let run = |cmd: &str| assess(cmd, Some(&project), &roots);
    assert!(
        matches!(run("rm -rf linked/../old"), CommandVerdict::Refuse(_)),
        "{:?}",
        run("rm -rf linked/../old")
    );
    assert!(matches!(run("rm -rf linked/x"), CommandVerdict::Refuse(_)));
    assert_eq!(run("rm -rf linked"), CommandVerdict::Allow);
    assert_eq!(run("rm -rf build/../dist"), CommandVerdict::Allow);
    // a physical cd through the link goes to the target's parent
    assert!(matches!(
        run("cd -P linked/.. && rm -rf old"),
        CommandVerdict::Refuse(_)
    ));
    assert_eq!(run("cd linked/.. && rm -rf dist"), CommandVerdict::Allow);
    // a physical cd to the project itself stays in it, even when the project is reached through a
    // link (a macOS temporary folder is /private/var/…)
    assert_eq!(run("cd -P . && rm -rf build"), CommandVerdict::Allow);
}

#[test]
fn the_home_folder_comes_from_the_guard_not_the_test_process() {
    // CodeRabbit on #34: the tests used the process's HOME
    assert!(refused("rm -rf ~/projects"));
    assert!(refused("cd ~; rm -rf old"));
    // no home known: a path in it cannot be placed, and is asked
    let no_home = |cmd: &str| verdict_with_home(cmd, None);
    assert!(matches!(
        no_home("rm -rf ~/projects"),
        CommandVerdict::Ask(_)
    ));
    assert!(matches!(
        no_home("rm -rf $HOME/projects"),
        CommandVerdict::Ask(_)
    ));
    assert!(matches!(
        no_home("cd ~ && rm -rf old"),
        CommandVerdict::Ask(_)
    ));
    assert!(matches!(no_home("rm -rf ~"), CommandVerdict::Refuse(_)));
}

#[test]
fn wrappers_and_their_options_do_not_hide_the_command() {
    // CodeRabbit on #34: `nice -n 10` made `-n` the program
    for cmd in [
        "nice -n 10 bench drop-site dev.localhost",
        "nice -10 bench drop-site dev.localhost",
        "env -u HOME bench drop-site dev.localhost",
        "env -i PATH=/bin bench --site x reinstall",
        "timeout 30 bench drop-site dev.localhost",
        "timeout -s KILL 30 bench drop-site dev.localhost",
        "time -p bench drop-site dev.localhost",
        "nohup git push --force &",
        "exec -a x bench drop-site dev.localhost",
        "sudo -u root bench drop-site dev.localhost",
        "sudo -- rm -rf /",
        "stdbuf -oL bench drop-site dev.localhost",
    ] {
        assert!(refused(cmd), "{cmd} should be refused: {:?}", verdict(cmd));
    }
    assert!(allowed("nice -n 10 bench --site x migrate"));
    assert!(allowed(
        "timeout 600 bench --site x run-tests --app a --module a.tests.test_x"
    ));
    assert!(allowed("command -v bench"));
    assert!(asked("sudo -u root ls"));
    // xargs: the paths come from its input
    assert!(asked("find . -name '*.log' | xargs rm -rf"));
    assert!(asked("printf 'a\\0b' | xargs -0 -n 1 rm -r"));
}

#[test]
fn quoted_and_escaped_secrets_are_hidden_whole() {
    // CodeRabbit on #34
    let json = r#"{"db_password":"alpha\"omega","db_name":"x"}"#;
    let out = scrub_secrets(json);
    assert!(!out.contains("omega") && !out.contains("alpha"), "{out}");
    assert!(out.contains(r#""db_name":"x""#), "{out}");

    let inline = "DB_PASSWORD='alpha beta' bench --site dev.localhost list-apps";
    let out = scrub_secrets(inline);
    assert!(!out.contains("alpha") && !out.contains("beta"), "{out}");
    assert!(
        out.contains("bench --site dev.localhost list-apps"),
        "{out}"
    );
    let out = scrub_secrets("env API_TOKEN=\"s3 cret\" MODE=dev ./run");
    assert!(
        !out.contains("s3 cret") && out.contains("MODE=dev"),
        "{out}"
    );

    let flag = "bench new-site x --admin-password 'alpha beta' --install-app erpnext";
    let out = scrub_secrets(flag);
    assert!(!out.contains("alpha") && !out.contains("beta"), "{out}");
    assert!(out.contains("--install-app erpnext"), "{out}");
    // the whole shell word: quoted and unquoted pieces, escaped spaces (CodeRabbit on #34)
    let out =
        scrub_secrets("bench new-site x --admin-password 'alpha beta'gamma --install-app erpnext");
    assert!(!out.contains("gamma") && !out.contains("beta"), "{out}");
    assert!(out.contains("--install-app erpnext"), "{out}");
    let out = scrub_secrets("x --admin-password alpha\\ beta y");
    assert!(!out.contains("beta"), "{out}");
    assert_eq!(
        scrub_secrets("DB_PASSWORD='a b'c ./run"),
        "DB_PASSWORD=[redacted] ./run"
    );
    let out = scrub_secrets(r#"x --db-password "a \" b" y"#);
    assert!(!out.contains("a \\\" b") && out.ends_with(" y"), "{out}");
}

#[test]
fn streamed_output_is_scrubbed_across_chunks() {
    // CodeRabbit on #34: live output and clipped output must not carry secrets
    let mut scrubber = StreamScrubber::default();
    let mut out = String::new();
    for chunk in [
        "{\n \"db_pass",
        "word\": \"s3cret",
        "Value\",\n \"allow_tests\": true\n}\n",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIE",
        "ow\nabc\n-----END RSA PRIVATE KEY-----\nafter\nlast without newline: token=",
    ] {
        out.push_str(&scrubber.push(chunk));
    }
    out.push_str(&scrubber.finish());
    assert!(
        !out.contains("s3cretValue") && !out.contains("MIIE") && !out.contains("abc"),
        "{out}"
    );
    assert!(
        out.contains("\"allow_tests\": true") && out.contains("after"),
        "{out}"
    );
    assert!(
        out.contains("-----BEGIN PRIVATE KEY----- [redacted]")
            && out.contains("-----END PRIVATE KEY-----")
    );
    // a line longer than the hold, cut inside a secret value: the value and the rest of the line
    // stay hidden, the next line is shown (CodeRabbit on #34)
    let mut long = StreamScrubber::default();
    let mut shown = long.push(&format!("{{\"db_password\": \"{}", "s".repeat(70_000)));
    shown.push_str(&long.push("tail\", \"x\": 1}\nnext line\n"));
    shown.push_str(&long.finish());
    assert!(
        !shown.contains("sss") && !shown.contains("tail"),
        "{}",
        &shown[..shown.len().min(200)]
    );
    assert!(shown.contains("next line"), "{shown}");
    // a partial line waits for its end
    let mut s = StreamScrubber::default();
    assert_eq!(s.push("DB_PASSWORD=hun"), "");
    assert_eq!(s.push("ter2\n"), "DB_PASSWORD=[redacted]\n");
}

#[test]
fn live_output_holds_a_secret_until_its_value_ends() {
    // CodeRabbit on #34, each case passed a value on unscrubbed
    let run = |chunks: &[&str]| {
        let mut scrubber = StreamScrubber::default();
        let mut out: String = chunks.iter().map(|c| scrubber.push(c)).collect();
        out.push_str(&scrubber.finish());
        out
    };
    // a key name cut by the hold limit
    let out = run(&[
        &format!("{}{{\"db_pas", " ".repeat(65_529)),
        "sword\": \"s3cret\"}\n",
    ]);
    assert!(
        !out.contains("s3cret") && out.contains("[redacted]"),
        "{}",
        out.trim()
    );
    // a JSON value on the line after its key, and the colon on the next line
    let out = run(&["{\n \"db_password\":\n", "  \"s3cret\"\n}\n"]);
    assert!(!out.contains("s3cret"), "{out}");
    let out = run(&["{\n \"db_password\"\n", " : \"s3cret\"\n}\n"]);
    assert!(!out.contains("s3cret"), "{out}");
    // the held line is passed on, scrubbed, as soon as its value has ended
    let mut s = StreamScrubber::default();
    assert_eq!(s.push("{\n \"db_password\":\n"), "{\n");
    assert_eq!(
        s.push("  \"s3cret\",\n \"x\": 1\n"),
        " \"db_password\":\n  \"[redacted]\",\n \"x\": 1\n"
    );
    // an overlong line that starts with a whole secret: the value is hidden, what follows is shown
    let out = run(&[
        &format!("DB_PASSWORD=s3cret {}", "diagnostic ".repeat(7_000)),
        "end of the diagnostics\nnext line\n",
    ]);
    assert!(!out.contains("s3cret"), "{}", &out[..80]);
    assert!(
        out.contains("end of the diagnostics") && out.contains("next line"),
        "{}",
        &out[out.len() - 80..]
    );
    // a whole key and value across a line end, the value's line not ended yet: passed on together
    let mut s = StreamScrubber::default();
    assert_eq!(s.push("{\n \"db_password\":\n  \"s3cret\""), "{\n");
    let out = format!("{}{}", s.push(",\n \"x\": 1\n}\n"), s.finish());
    assert!(!out.contains("s3cret") && out.contains("\"x\": 1"), "{out}");
    // a key longer than the tail, cut before its name ends (CodeRabbit on #34)
    let out = run(&[
        &format!("{}{{\"db_password{}", " ".repeat(61_430), "x".repeat(4_100)),
        "\": \"s3cret\"}\nnext\n",
    ]);
    assert!(
        !out.contains("s3cret") && out.contains("next"),
        "{}",
        &out[out.len().saturating_sub(120)..]
    );
    let out = run(&[
        &format!(
            "{}{{\"db_password_{}",
            " ".repeat(61_000),
            "a".repeat(5_000)
        ),
        "\":\"s3cret\"}\nnext\n",
    ]);
    assert!(
        !out.contains("s3cret") && out.contains("next"),
        "{}",
        &out[out.len().saturating_sub(120)..]
    );
    // a key, then more white space than the hold, then its value on a later line
    let out = run(&[
        &format!("{{\"db_password\":{}", " ".repeat(70_000)),
        "\n  \"s3cret\"\n}\nafter\n",
    ]);
    assert!(
        !out.contains("s3cret") && out.contains("after"),
        "{}",
        &out[out.len().saturating_sub(120)..]
    );
    let out = run(&[
        &format!("{{\"db_password\"{}", " ".repeat(70_000)),
        "\n : \"s3cret\", \"x\": 1}\n",
    ]);
    assert!(
        !out.contains("s3cret") && out.contains("\"x\": 1"),
        "{}",
        &out[out.len().saturating_sub(120)..]
    );
    // a long setting name with a secret word, cut before its `=` (CodeRabbit on #34)
    let out = run(&[
        &format!("{}DB_PASSWORD{}", " ".repeat(61_430), "x".repeat(4_100)),
        "=s3cret\nnext\n",
    ]);
    assert!(
        !out.contains("s3cret") && out.contains("next"),
        "{}",
        &out[out.len().saturating_sub(120)..]
    );
    // spaces between the long name and its `=` keep the value hidden; another word ends it
    let out = run(&[
        &format!("{}DB_PASSWORD{}", " ".repeat(61_430), "x".repeat(4_100)),
        "  = s3cret\nnext\n",
    ]);
    assert!(
        !out.contains("s3cret") && out.contains("next"),
        "{}",
        &out[out.len().saturating_sub(120)..]
    );
    let out = run(&[
        &format!("{}DB_PASSWORD{}", " ".repeat(61_430), "x".repeat(4_100)),
        " is not set\n",
    ]);
    assert!(
        out.contains(" is not set"),
        "{}",
        &out[out.len().saturating_sub(120)..]
    );
    // a long ordinary name is shown whole
    let name = "x".repeat(4_100);
    let out = run(&[&format!("{}{name}", " ".repeat(61_430)), "=1\n"]);
    assert!(out.contains(&format!("{name}=1")) && !out.contains("[redacted]"));
    // a long ordinary value is shown whole
    let body = "b".repeat(70_000);
    let out = run(&[&format!("{{\"body\": \"{body}"), "\", \"n\": 1}\n"]);
    assert!(
        out.contains(&body) && !out.contains("[redacted]"),
        "{}",
        &out[..80]
    );
    // the output ends (a timeout, an abort) inside a secret value: the value is hidden
    let out = run(&["{\"db_password\": \"s3c"]);
    assert_eq!(out, "{\"db_password\": \"[redacted]");
    let out = run(&["export API_TOKEN='abc"]);
    assert!(!out.contains("abc"), "{out}");
    // ordinary output that ends without a new line is shown as it is
    assert_eq!(run(&["Ran 4 tests", " in 0.08s"]), "Ran 4 tests in 0.08s");
    assert_eq!(run(&["token count: "]), "token count: ");
}

#[test]
fn a_bare_secret_name_on_a_command_line_is_hidden() {
    // CodeRabbit on #34: `TOKEN=` was missed when nothing came before the word
    assert_eq!(
        scrub_secrets("env TOKEN=fixture-value MODE=dev ./run"),
        "env TOKEN=[redacted] MODE=dev ./run"
    );
    assert_eq!(
        scrub_secrets("PASSWORD=x SECRET='a b' ./run"),
        "PASSWORD=[redacted] SECRET=[redacted] ./run"
    );
    // a key block keeps its lines, so a Read window stays in place
    let key = "a\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY-----\nb";
    let out = scrub_secrets(key);
    assert_eq!(out.lines().count(), key.lines().count(), "{out}");
    assert!(!out.contains("MIIE") && out.ends_with("\nb"), "{out}");
}

#[test]
fn site_configs_are_known() {
    assert!(is_site_config(
        "sites/demo-alpha.localhost/site_config.json"
    ));
    assert!(is_site_config("/b/sites/common_site_config.json"));
    assert!(!is_site_config("app/config.json"));
}
