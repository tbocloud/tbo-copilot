# Getting started with TBO Copilot

TBO Copilot is TBO's AI assistant for the support, DevOps and development teams. You use it in two places:

- **Microsoft Teams:** chat with **TBO Copilot**. Approve fixes, ask about tickets and tasks, report new work, ask about hosted sites.
- **The desktop app (macOS and Windows):** the same, plus deeper work:
  - reading tickets;
  - checking and changing TBO's AWS;
  - building a Frappe change from a task up to its pull request.

It always acts **as you**, with your own TBO Support permissions. It asks before it changes anything.

## 1. Install the desktop app

1. Open TBO Support's download page, **`/copilot-desktop`** on your TBO Support site (for example
   `https://teams.teambackoffice.com/copilot-desktop`, or `https://demo-tbo.tbocloud.in/copilot-desktop` on the demo
   hub), and log in with Microsoft. It offers the installer for your system, or says why you may not use the app yet,
   and lists **Your computers** (each one you signed in, with **Sign out**). The same files are on the
   [GitHub releases](https://github.com/tbocloud/tbo-copilot/releases):
   - **macOS** (Apple silicon): `TBO-Copilot-<version>-arm64.dmg`. Open it and drag TBO Copilot to Applications.
   - **Windows:** `TBO-Copilot-Setup-<version>.exe`, and run it.
2. **Until the installers are signed**, your computer warns you the first time:
   - **macOS 15 or later:** open the app once, then go to System Settings → Privacy & Security and press **Open Anyway** next to TBO Copilot.
   - **Older macOS:** right-click the app → Open → Open.
   - **Windows:** if SmartScreen appears, choose **More info → Run anyway**.
3. **Once installers are signed**, these warnings go away. From then on the app updates itself: it tells you when a new version is ready. To ask at once, choose **Check for Updates…** (macOS: the TBO Copilot menu; Windows: Help).

## 2. Sign in

1. When the app opens, it asks you to sign in to TBO Support. Press **Sign in with Microsoft**.
2. Your browser opens TBO Support. Sign in with your Microsoft work account if asked.
3. Check that the code in the browser matches the one in the app, and press **Allow**.

If the browser says you may not sign in yet (not on Allowed People, never logged in with Microsoft…), the app shows the
same reason under the code and keeps waiting until the code expires: log in with Microsoft from the page's button, or
ask a System Manager, then press **Allow**.

The app is then ready, with nothing to type:
- pick **TBO AI** as the model (the panel says when it is ready). **TBO AI · DeepSeek** (DeepSeek V3.2, run in TBO's
  own AWS account) is the second choice; it reads text only, and works once TBO Support's settings list `tbo-deepseek`
  for your key;
- TBO Support is connected as you.

**Signing in again:** the sign-in lasts 30 days. If it ends, a notice says why, the TBO Support panel keeps the reason,
and the panel opens by itself at the next start: sign in again there (**TBO Support: Sign in**).

**Signing out:** command palette → **TBO Support: Sign out**. A System Manager can also end a computer's sign-in in TBO Support (**TBO Desktop Sign-in**).

## 3. Keep the app asking

Two switches under the message box decide what Copilot may do:

| Switch | Use in the pilot | What it means |
|---|---|---|
| Permission mode | **Ask every time** | The app asks before each tool that can change something. Read the request, then press **Allow once**, **Allow for this chat** (no more questions for that tool in this chat) or **Deny**. *Accept edits* and *Auto* ask less or nothing: do not use them with TBO's systems |
| Mode | **Agent** | Copilot works with you. *Plan* and *Goal* only read and plan; they change nothing |

Changes to shared systems also need **another person's approval**, whatever the switches say:
- a Press action other than a backup;
- an AWS change.

The approver gets a card in Teams.

## 4. What to ask

**Tickets and the knowledge base** (the TBO Support plugin):
- *"Summarise ticket 1234, show its fix brief and find similar tickets."*
- *"Search the knowledge base for stock reconciliation errors."*

**Your tasks:**
- *"What are my tasks?"*
- *"Start TASK-2026-00123."* This moves the task to Working and starts its timer. The app asks you first.

**Hosted sites (Press):**
- *"Status of acme.tbo365.cloud"*, or *"failed jobs of the last 24 hours"*.
- *"Take a backup of demo.tbo365.cloud"* runs once you allow it. It says **started** with Press's job; ask *"Is the
  backup of demo.tbo365.cloud done?"* for its status. Asking again while one runs starts no second backup.
- A restart, update, migrate, plan change or deploy goes to an approver first. A restore or a new site is not
  offered from the app yet: ask in TBO Support.

**AWS** (DevOps):
- *"Which EC2 instances are running in ap-south-1?"* uses your own AWS login (`aws sso login`). The plugin's **AWS
  region** setting (ap-south-1 by default) is used when you name none.
- Changes are off until you turn on **Allow AWS changes** in the plugin's settings. Each change then needs an approver.

**Frappe development** (the Frappe Dev plugin):
- Open the app's repository as the workspace (from a task: make it the project's first folder), then type
  `/tbo.frappe-dev/start-task TASK-2026-00123`.
- Copilot creates the branch and builds the change with you. It runs the repository's linters and the tests the change touches.
- `/tbo.frappe-dev/open-pr` opens the pull request with the task in it. TBO Support then moves the task to Pending
  Review, and the merge completes it.

**Projects and tasks:** open a task in its project's folders from the TBO Support panel; see
[projects-and-tasks.md](projects-and-tasks.md).

## 5. In Teams

Find **TBO Copilot** in Teams' Apps, or in your chats if it is already installed for you. See [teams.md](teams.md) for what to write.

## 6. When something goes wrong

Write **report a problem:** and then what you asked and what happened:
- in Teams;
- in the TBO Copilot panel in TBO Support;
- or with **TBO Support: Report a problem** in the desktop app's command palette.

It becomes a task for the TBO Copilot team. See [report-a-problem.md](report-a-problem.md).

**Never** paste passwords, keys or a customer's personal data into a chat or a report.
