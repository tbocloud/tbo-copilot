"use strict";

// A pull request's title and body: the repository's template (TBO's when it has none), the task
// as "Closes TASK-…" so the task-reference check passes and the hub moves the task, what changed,
// how to test it, and what Copilot ran before opening it.

const fs = require("node:fs");
const path = require("node:path");

const TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
];
const TITLE_MAX = 120;
// the sections a template may call "What and why" and "How to test"
const WHAT = /^what( and why)?$|^description$|^summary$/i;
const HOW = /^how to test|^testing$|^test plan$/i;

// helpdesk's template, without its hub-only checklist line
const TBO_TEMPLATE = `## Task

<!--
Replace YYYY-NNNNN with the TBO Support task number (e.g. 2026-00012).
"Closes" completes the task when this PR is merged; "Refs" only links it.
-->

Closes TASK-YYYY-NNNNN

## What and why

<!-- What changes, and the problem it solves. -->

## How to test

<!-- Steps a reviewer can follow, with the site, user and data to use. -->

1.

## Screenshots

<!-- For UI changes: before and after. Delete this section otherwise. -->

## Checklist

- [ ] Tests added or updated, and they pass
- [ ] Spec or docs updated for changed behaviour
- [ ] No secrets, tokens, passwords or customer data in code, tests or screenshots
`;

function findTemplate(root) {
  for (const rel of TEMPLATE_PATHS) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) return { source: rel, text: fs.readFileSync(file, "utf8") };
  }
  return { source: "TBO's template", text: TBO_TEMPLATE };
}

function title(task, summary) {
  const text = String(summary || "")
    .replace(/\s+/g, " ")
    .replace(new RegExp(`^${task}:?\\s*`, "i"), "")
    .trim();
  if (!text) throw Object.assign(new Error('"summary" is needed: one line saying what the PR does.'), { code: "INVALID_ARGUMENT" });
  const full = `${task}: ${text}`;
  return full.length > TITLE_MAX ? `${full.slice(0, TITLE_MAX - 1).trimEnd()}…` : full;
}

// Splits markdown at its "## " headings: [{ heading, body }], the first with heading null.
function sections(text) {
  const out = [{ heading: null, lines: [] }];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^## /.test(line)) out.push({ heading: line.slice(3).trim(), lines: [] });
    else out.at(-1).lines.push(line);
  }
  return out;
}

const stripComments = (lines) => lines.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
const isPlaceholder = (body) => body === "" || /^1\.\s*$/.test(body);

function checksText(checks) {
  const lines = [];
  for (const s of checks.lint.steps) {
    const notes = [s.fromCi ? "" : "not in CI", s.skipped && s.skipped.length ? `skipped hooks: ${s.skipped.join(", ")}` : ""].filter(Boolean);
    lines.push(`- ${s.name}: ${s.status}${notes.length ? ` (${notes.join("; ")})` : ""}`);
  }
  if (checks.tests) {
    for (const r of checks.tests.results) lines.push(`- tests \`${r.module}\` on a local site: ${r.status} (${r.detail})`);
  } else {
    lines.push(`- tests: none run locally (${checks.noTestsReason})`);
  }
  return `## Checks run by Copilot\n\nOn ${checks.head.slice(0, 12)}, before this PR was opened:\n\n${lines.join("\n")}\n`;
}

// The body: the task line filled in (or added at the top), the two sections the person wrote,
// an empty Screenshots section dropped, the tests box ticked when they passed, and the checks.
function body(template, { task, link, whatAndWhy, howToTest, checks }) {
  const ref = `${link} ${task}`;
  let text = template;
  if (/(Closes|Refs|Fixes|Resolves)\s+TASK-YYYY-NNNNN/i.test(text)) text = text.replace(/(Closes|Refs|Fixes|Resolves)\s+TASK-YYYY-NNNNN/i, ref);
  else if (/TASK-YYYY-NNNNN/.test(text)) text = text.replace(/TASK-YYYY-NNNNN/, task);
  const parts = sections(text);
  const fill = (re, value) => {
    const s = parts.find((p) => p.heading && re.test(p.heading));
    if (s) s.lines = ["", value.trim(), ""];
    else parts.push({ heading: re === WHAT ? "What and why" : "How to test", lines: ["", value.trim(), ""] });
  };
  if (whatAndWhy) fill(WHAT, whatAndWhy);
  if (howToTest) fill(HOW, howToTest);
  const kept = parts.filter((p) => !(p.heading && /^screenshots?$/i.test(p.heading) && isPlaceholder(stripComments(p.lines))));
  let out = kept
    .map((p) => (p.heading ? [`## ${p.heading}`, ...p.lines] : p.lines).join("\n"))
    .join("\n")
    .replace(/^\s*\n/, "");
  if (!new RegExp(`(Closes|Refs|Fixes|Resolves)\\s+${task}`, "i").test(out)) out = `${ref}\n\n${out}`;
  if (checks.tests && checks.tests.passed) out = out.replace(/- \[ \] (Tests added or updated[^\n]*)/i, "- [x] $1");
  return `${out.trimEnd()}\n\n${checksText(checks)}`;
}

module.exports = { findTemplate, title, body, TBO_TEMPLATE, TITLE_MAX };
