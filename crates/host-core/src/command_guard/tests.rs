//! Tests of the command guard and the secret scrubbing (TBO Copilot Phase 27, Q5).

use super::*;

fn roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/work/app"), PathBuf::from("/tmp/scratch")]
}
/// A made-up file system: the project, its scratch folder, /home/user and the real home exist; a
/// folder named "missing" does not.
fn fake_dir(path: &Path) -> bool {
    let p = path.to_string_lossy();
    let home = std::env::var("HOME").unwrap_or_default();
    let known = ["/work/app", "/tmp/scratch", "/home/user"]
        .iter()
        .any(|root| p.starts_with(root))
        || (!home.is_empty() && p.starts_with(&home));
    known && !p.contains("missing")
}

fn verdict(cmd: &str) -> CommandVerdict {
    assess_in(cmd, Some(Path::new("/work/app")), &roots(), &fake_dir)
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
    assert!(asked("pushd /work/app && popd && rm -rf old"));
    // a cd that fails (no such folder) leaves the shell where it was: CodeRabbit on #34
    assert!(!allowed(
        "cd /home/user/Documents && cd /work/app/missing; rm -rf old"
    ));
    assert!(asked("cd /work/app/missing && rm -rf old"));
    // no starting folder known at all
    assert!(matches!(
        assess("rm -rf old", None, &roots()),
        CommandVerdict::Ask(_)
    ));
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
fn site_configs_are_known() {
    assert!(is_site_config(
        "sites/demo-alpha.localhost/site_config.json"
    ));
    assert!(is_site_config("/b/sites/common_site_config.json"));
    assert!(!is_site_config("app/config.json"));
}
