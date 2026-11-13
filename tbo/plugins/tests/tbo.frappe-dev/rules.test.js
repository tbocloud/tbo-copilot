"use strict";

// The pure parts of tbo.frappe-dev: branch names, what CI runs, commit titles, the PR's text,
// and which tests belong to a change.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { taskId, taskOf, shortName, branchFor, checkBranchName, githubSlug } = require("../../tbo.frappe-dev/lib/git");
const { plan, semgrepConfigs, commitProblem, preCommitHooks, installFailure } = require("../../tbo.frappe-dev/lib/lint");
const pr = require("../../tbo.frappe-dev/lib/pr");
const { findBench, findSite, testModules } = require("../../tbo.frappe-dev/lib/tests");

function tempTree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tbo-dev-rules-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

// --- branches ---------------------------------------------------------------------------

test("a task's branch is feature/ or fix/, the task number and a short name from its subject", () => {
  assert.equal(branchFor("TASK-2026-00021", "Copilot: Frappe development (plugin tbo-frappe-dev)", "feature"), "feature/TASK-2026-00021-copilot-frappe-development-plugin-tbo");
  assert.equal(branchFor("TASK-2026-00004", "Restore get_minimum_margin", "fix"), "fix/TASK-2026-00004-restore-get-minimum-margin");
  assert.equal(branchFor("TASK-2026-00009", "Rapport für Kündigungen — Ü", undefined), "feature/TASK-2026-00009-rapport-fur-kundigungen-u");
  assert.equal(branchFor("TASK-2026-00010", "!!! ???", "feature"), "feature/TASK-2026-00010");
  assert.equal(shortName("a".repeat(60)).length, 40);
  assert.ok(shortName("one two three four five six seven eight nine ten").length <= 40);
  assert.doesNotMatch(shortName("x; rm -rf ~ && $(id) `id`"), /[^a-z0-9-]/);
  assert.equal(shortName("<untrusted_ticket_content>Cap the discount</untrusted_ticket_content>"), "cap-the-discount");
});

test("task numbers are checked and found the way the hub finds them", () => {
  assert.equal(taskId(" task-2026-00021 "), "TASK-2026-00021");
  for (const bad of ["", "TASK-26-1", "TASK-2026-000211", "2026-00021", "TASK-2026-00021; echo"]) {
    assert.throws(() => taskId(bad), { code: "INVALID_ARGUMENT" }, bad);
  }
  assert.equal(taskOf("feature/TASK-2026-00021-frappe-dev"), "TASK-2026-00021");
  assert.equal(taskOf("fix/task-2026-00004_margin"), "TASK-2026-00004");
  assert.equal(taskOf("feature/XTASK-2026-00021"), null);
  assert.equal(taskOf("main"), null);
});

test("branch names and GitHub remotes are checked", () => {
  assert.equal(checkBranchName("tbo-copilot", "base"), "tbo-copilot");
  for (const bad of ["-x", "a..b", "a b", "x/", "x.lock", "a@{1}", "a//b", ""]) assert.throws(() => checkBranchName(bad, "base"), { code: "INVALID_ARGUMENT" }, bad);
  assert.equal(githubSlug("git@github.com:tbocloud/demo-alpha-app.git"), "tbocloud/demo-alpha-app");
  assert.equal(githubSlug("https://github.com/tbocloud/helpdesk"), "tbocloud/helpdesk");
  assert.equal(githubSlug("https://gitlab.com/x/y.git"), null);
});

// --- what CI runs -----------------------------------------------------------------------

const HELPDESK_LINT = `name: Lint
jobs:
  commit-lint:
    steps:
      - run: |
          npm install @commitlint/cli @commitlint/config-conventional
          npx commitlint --verbose --from x --to y
  linter:
    steps:
      - uses: pre-commit/action@v3.0.1
      - run: git clone --depth 1 https://github.com/frappe/semgrep-rules.git frappe-semgrep-rules
      - run: semgrep ci --config ./frappe-semgrep-rules/rules --config r/python.lang.correctness
`;

test("the checks follow the repository's CI: pre-commit, Semgrep's own configs, commitlint", (t) => {
  const root = tempTree(t, { ".github/workflows/lint.yml": HELPDESK_LINT, ".pre-commit-config.yaml": "repos: []\n", "my_app/hooks.py": "" });
  const p = plan(root);
  assert.deepEqual(p.preCommit, { fromCi: true });
  assert.deepEqual(p.semgrep, { fromCi: true, configs: [{ kind: "frappe", sub: "rules" }, { kind: "registry", name: "r/python.lang.correctness" }] });
  assert.equal(p.flake8, false);
  assert.deepEqual(p.commits, { fromCi: true, blocking: true });
});

test("a Frappe app whose CI runs nothing still gets Semgrep with Frappe's rules and the commit titles", (t) => {
  const root = tempTree(t, { ".github/workflows/ci.yml": "jobs:\n  tests:\n    steps:\n      - run: bench run-tests --app my_app\n", "my_app/hooks.py": "" });
  const p = plan(root);
  assert.equal(p.preCommit, null);
  assert.equal(p.semgrep.fromCi, false);
  assert.equal(p.semgrep.configs[0].kind, "frappe");
  assert.deepEqual(p.commits, { fromCi: false, blocking: true });
  const plain = tempTree(t, { "README.md": "not a Frappe app" });
  assert.equal(plan(plain).semgrep, null);
  assert.equal(plan(plain).commits.blocking, false);
});

test("Semgrep configs: Frappe's clone, registry sets and repository files; nothing else", (t) => {
  const root = tempTree(t, { "rules/local.yml": "rules: []\n" });
  const text = [
    "run: semgrep ci --config ./frappe-semgrep-rules/rules/security --config=p/python --config rules/local.yml --config ../outside.yml --config https://evil.example/r.yml",
    "run: echo --config not-semgrep",
  ].join("\n");
  assert.deepEqual(semgrepConfigs(text, root), [
    { kind: "frappe", sub: "rules/security" },
    { kind: "registry", name: "p/python" },
    { kind: "local", path: "rules/local.yml" },
  ]);
});

test("flake8 and ruff run on their own only when CI calls them directly", (t) => {
  const direct = tempTree(t, { ".github/workflows/l.yml": "steps:\n  - run: flake8 my_app\n  - run: |\n      ruff check .\n" });
  assert.equal(plan(direct).flake8, true);
  assert.equal(plan(direct).ruff, true);
  const viaPreCommit = tempTree(t, { ".github/workflows/l.yml": "steps:\n  - uses: pre-commit/action@v3\n", ".pre-commit-config.yaml": "  - id: flake8\n" });
  assert.equal(plan(viaPreCommit).flake8, false);
});

test("commit titles follow conventional commits, in lower case", () => {
  for (const ok of ["feat: add the tier cap", "fix(margin): skip cancelled invoices", "feat(api)!: drop v1", "Merge branch 'main' into x", "chore(deps): bump frappe-ui to 0.1.200"]) {
    assert.equal(commitProblem(ok), null, ok);
  }
  assert.match(commitProblem("Add the tier cap"), /type\(scope\): summary/);
  assert.match(commitProblem("feature: add"), /type\(scope\): summary/);
  assert.match(commitProblem("feat: Add the tier cap"), /capital letter/);
  assert.match(commitProblem("feat: ADD CAP"), /capital letter/);
  assert.match(commitProblem("feat: add the tier cap."), /full stop/);
  assert.match(commitProblem(`feat: ${"x".repeat(100)}`), /100 characters/);
  assert.equal(commitProblem("feat: TASK-2026-00021 cap per tier"), null);
});

// --- the pull request's text --------------------------------------------------------------

const CHECKS = {
  head: "0123456789abcdef0123",
  lint: { steps: [{ name: "pre-commit", status: "passed", fromCi: true }, { name: "semgrep", status: "passed", fromCi: false }] },
  tests: { passed: true, results: [{ module: "my_app.tests.test_discounts", status: "passed", detail: "3 test(s), OK" }] },
  noTestsReason: "",
};

test("TBO's template is filled: Closes the task, what and why, how to test, checks; empty screenshots dropped", () => {
  const body = pr.body(pr.TBO_TEMPLATE, { task: "TASK-2026-00021", link: "Closes", whatAndWhy: "Caps the discount.", howToTest: "1. Open an invoice.", checks: CHECKS });
  assert.match(body, /^## Task[\s\S]*\nCloses TASK-2026-00021\n/);
  assert.doesNotMatch(body, /TASK-YYYY-NNNNN/);
  assert.match(body, /## What and why\n\nCaps the discount\.\n/);
  assert.match(body, /## How to test\n\n1\. Open an invoice\.\n/);
  assert.doesNotMatch(body, /## Screenshots/);
  assert.match(body, /- \[x\] Tests added or updated, and they pass/);
  assert.match(body, /## Checks run by Copilot\n\nOn 0123456789ab/);
  assert.match(body, /- semgrep: passed \(not in CI\)/);
  assert.match(body, /- tests `my_app\.tests\.test_discounts` on a local site: passed \(3 test\(s\), OK\)/);
});

test("Refs instead of Closes, and no tests with the reason given", () => {
  const body = pr.body(pr.TBO_TEMPLATE, { task: "TASK-2026-00021", link: "Refs", whatAndWhy: "x", howToTest: "y", checks: { ...CHECKS, tests: null, noTestsReason: "only a translation" } });
  assert.match(body, /\nRefs TASK-2026-00021\n/);
  assert.match(body, /- \[ \] Tests added or updated/);
  assert.match(body, /- tests: none run locally \(only a translation\)/);
});

test("a repository's own template without the task line gets it at the top; missing sections are added", () => {
  const own = "## Description\n\n<!-- describe -->\n\n## Notes\n\nKeep this.\n";
  const body = pr.body(own, { task: "TASK-2026-00021", link: "Closes", whatAndWhy: "Caps it.", howToTest: "Run the tests.", checks: CHECKS });
  assert.match(body, /^Closes TASK-2026-00021\n\n## Description\n\nCaps it\.\n/);
  assert.match(body, /## Notes\n\nKeep this\./);
  assert.match(body, /## How to test\n\nRun the tests\./);
});

test("the template comes from the repository when it has one, else TBO's", (t) => {
  const own = tempTree(t, { ".github/pull_request_template.md": "## Task\n\nCloses TASK-YYYY-NNNNN\n" });
  assert.equal(pr.findTemplate(own).source, ".github/pull_request_template.md");
  const none = tempTree(t, { "README.md": "" });
  assert.equal(pr.findTemplate(none).source, "TBO's template");
});

test("the title is the task number and one line, never doubled or too long", () => {
  assert.equal(pr.title("TASK-2026-00021", "  cap the discount\nper tier "), "TASK-2026-00021: cap the discount per tier");
  assert.equal(pr.title("TASK-2026-00021", "TASK-2026-00021: cap it"), "TASK-2026-00021: cap it");
  assert.equal(pr.title("TASK-2026-00021", "x".repeat(300)).length, pr.TITLE_MAX);
  assert.throws(() => pr.title("TASK-2026-00021", "  "), { code: "INVALID_ARGUMENT" });
});

// --- the bench and the tests ---------------------------------------------------------------

test("the bench is the setting or the folder that holds the repository in apps/; the site must exist", (t) => {
  const bench = tempTree(t, { "apps/frappe/setup.py": "", "apps/my_app/my_app/hooks.py": "", "sites/dev.localhost/site_config.json": "{}", "sites/currentsite.txt": "dev.localhost\n" });
  const repo = path.join(bench, "apps", "my_app");
  assert.equal(findBench(repo, ""), bench);
  assert.equal(findBench(repo, bench), bench);
  assert.equal(findBench(tempTree(t, { "x/y.py": "" }), ""), null);
  assert.throws(() => findBench(repo, "/nowhere"), { code: "NO_BENCH" });
  assert.equal(findSite(bench, ""), "dev.localhost");
  assert.equal(findSite(bench, "dev.localhost"), "dev.localhost");
  assert.throws(() => findSite(bench, "live.example.com"), { code: "NO_SITE" });
  assert.throws(() => findSite(bench, "../../etc"), { code: "NO_SITE" });
});

test("a change's test modules: changed tests, tests beside the code, a DocType's own test, the package's tests/", (t) => {
  const root = tempTree(t, {
    "my_app/selling/discounts.py": "",
    "my_app/selling/test_discounts.py": "",
    "my_app/accounts/margin.py": "",
    "my_app/tests/test_margin.py": "",
    "my_app/my_app/doctype/tier/tier.py": "",
    "my_app/my_app/doctype/tier/tier.json": "",
    "my_app/my_app/doctype/tier/test_tier.py": "",
    "my_app/tests/test_other.py": "",
    "my_app/hooks.py": "",
  });
  const changed = ["my_app/selling/discounts.py", "my_app/accounts/margin.py", "my_app/my_app/doctype/tier/tier.json", "my_app/my_app/doctype/tier/tier.py", "my_app/tests/test_other.py", "my_app/hooks.py", "README.md"];
  assert.deepEqual(testModules(root, changed), [
    "my_app.my_app.doctype.tier.test_tier",
    "my_app.selling.test_discounts",
    "my_app.tests.test_margin",
    "my_app.tests.test_other",
  ]);
});

test("a hook whose tools cannot be installed is named, with the hooks to skip, and is not blamed on the code", (t) => {
  const root = tempTree(t, {
    ".pre-commit-config.yaml": [
      "repos:",
      "  - repo: https://github.com/psf/black",
      "    rev: 22.6.0",
      "    hooks:",
      "      - id: black",
      "  - repo: https://github.com/pre-commit/mirrors-prettier",
      "    rev: v2.6.2",
      "    hooks:",
      "      - id: prettier",
      "",
    ].join("\n"),
  });
  const hooks = preCommitHooks(root);
  assert.deepEqual(hooks, { "https://github.com/psf/black": ["black"], "https://github.com/pre-commit/mirrors-prettier": ["prettier"] });
  const output = [
    "[INFO] Installing environment for https://github.com/pre-commit/mirrors-prettier.",
    "[INFO] Once installed this environment will be reused.",
    "An unexpected error has occurred: CalledProcessError: command: (...npm install --allow-git=root...)",
    "    npm error code EALLOWGIT",
    "",
  ].join("\n");
  const said = installFailure(output, hooks);
  assert.match(said, /could not install the tools of https:\/\/github\.com\/pre-commit\/mirrors-prettier \(npm error code EALLOWGIT\)/);
  assert.match(said, /not a problem in the code/);
  assert.match(said, /skip_hooks: \["prettier"\]/);
  assert.match(said, /npm 11\.12/);
  assert.equal(installFailure("black....Failed\n- hook id: black\n", hooks), null);
});

test("hooks left out are written into the PR's checks", () => {
  const checks = { ...CHECKS, lint: { steps: [{ name: "pre-commit", status: "passed", fromCi: true, skipped: ["prettier"] }] } };
  const body = pr.body(pr.TBO_TEMPLATE, { task: "TASK-2026-00021", link: "Closes", whatAndWhy: "x", howToTest: "y", checks });
  assert.match(body, /- pre-commit: passed \(skipped hooks: prettier\)/);
});
