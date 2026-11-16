---
name: Open the pull request
description: Use when the work on a TBO Support task is committed, tested and checked, and the person asks to open the PR: pushes the task's branch and opens a PR that moves the task to Pending Review.
---

# Open the pull request

1. `tbo_dev` `status`: on the task's branch, nothing uncommitted. If `last_check` is not `passed` on the current
   commit, run `tbo_dev` `check` and wait for it (`job_status`); the PR tool refuses without it.
2. Tests: `last_tests` passed on the current commit, or the change truly has no test that applies (documentation, a
   translation, a print format). Then say why in `no_tests_reason`, in one sentence.
3. Write, from what you did (not from the task's text):
   - `summary`: one line, what the PR does, lower case after the task number is fine.
   - `what_and_why`: what changes and the problem it solves, a few lines.
   - `how_to_test`: steps a reviewer can follow, with the site, the user and the data to use.
   - `link`: `Closes` when merging finishes the task (the usual case), `Refs` when it is one part of it.
4. `tbo_dev_pr` `open_pr` with those. The app asks the person to confirm: it pushes to GitHub.
5. Answer with the PR's link, its title, and what happens to the task: TBO Support moves it to Pending Review when
   GitHub's webhook arrives. If the person wants to keep working, pass `draft: true`: the task stays Working.

If the push is refused because GitHub has newer commits on the branch, pull them (`git pull --rebase` on the task's
own branch), run the tests and the check again, and open the PR again. Never force-push, never push to the default
branch, and never merge the PR: a person approves it.
