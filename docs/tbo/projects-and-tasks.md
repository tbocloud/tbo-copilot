# Projects and tasks in TBO Copilot

Do your TBO Support tasks in the desktop app, in your project's folders, and complete them there with your hours
(TBO Copilot Phase 22). Any task: from a ticket or not.

## 1. Your projects and their folders

Every task in TBO Support belongs to a project. In the TBO Support panel (**TBO Support: Projects and tasks** in the
command palette) you see:
- your open projects, the ones with your open tasks first;
- each project's open tasks of yours;
- each project's **folders on this computer**: the app's code, a bench, a documents folder.

**Add folder…** picks a folder; a project can have up to ten. They are kept on this computer only, per TBO Support site:
everyone's paths differ. The first folder (★) is the chat's own; **First** makes another one first. **Remove** forgets
a folder (it deletes nothing).

## 2. Opening a task

- **From TBO Support:** a task's **Open in TBO Copilot** (for the people it is assigned to). The app comes up and the
  panel asks **"Open task … in TBO Copilot?"**. Nothing opens until you press **Open the task**. A link for another TBO
  Support site than the one you signed in to opens nothing.
- **From the app:** **Open** next to the task in the panel. **Continue** means its chat already exists.

The task opens in its own chat, in its project's folders. With several folders, the app groups them as one project
(named "TBO · <project>"), so the chat sees all of them. The first time, the chat is given the task: it reads it, says
how it would do it and waits for your go-ahead. Opening the task again continues the same chat. If you deleted that
chat in the app, opening the task makes a new one and gives it the task again.

If the project has no folders here yet, the panel asks you to add them first.

When the app cannot group the folders, the task still opens, in its first folder, and the panel says why. The app keeps
a folder in one group only, so a folder you added to two projects stays in the group made first; and a group never
drops the folder that was first when it was made, so after you remove that folder here, add it back to see the folders
together again. A long project name is cut to the 80 characters a group's name may have.

## 3. Working and completing

In the task's chat, as with anything Copilot changes, the app asks you first:
- **Start:** the task becomes Working and its timer runs.
- **Pause / Hold / Resume:** pause the timer; put it On Hold with a reason (Laptop / system issue, Leave, Waiting on
  customer, Waiting on another task, Other); take it off hold.
- **How a task ends:** with a pull request that closes the task (the Frappe dev plugin writes `Closes TASK-…`), its
  merge completes the task: TBO Support stops the timer and logs its hours, or sends the task to Pending Review. Copilot
  does not complete such a task by hand. **Complete** is for work without a pull request, or for a task still open
  after its merge.
- **Complete:** Copilot asks your hours and on which days (it never guesses) and what was done, then completes the
  task. TBO Support puts each day's hours on that day's timesheet, the same as its Complete dialog. Its rule:
  - a day takes at most what is left of your working day (hours already on your timesheet count), and only a working
    day;
  - you type hours in for today and the last few working days (7 by default); an older day takes only what the task's
    timer recorded on it;
  - never a day in the future, or before the task was made.

  Copilot reads the days the timer ran and the hours still free on each first (`completion_days`), so it can suggest the
  split. A project that wants a review sends the task to Pending Review.

For Frappe app code, the chat uses the Frappe dev plugin: a task branch, TBO's conventions, tests, a pull request
([frappe-dev.md](./frappe-dev.md)).

## 4. Going live

Code that a customer's site runs goes live as a **release**: once merged, CI must pass, then one person who wrote none
of it approves, and Press deploys it tonight (the deploy window) or now.

After your pull request is merged and its CI passed, ask in the task's chat (or Copilot asks you) **"Go live tonight or
now?"**:
- the chat shows where it stands: waiting for CI, waiting for approval (and whose), going live tonight or now, live;
- your answer goes to the release's approver, who gets the release's card again with your request and decides;
- nobody approves their own change.

When Press starts the deploy, when it is live, and if it fails, the people TBO Support's settings name for deploy notices
(for example DevOps and a senior) hear it in Teams and TBO Support.

## Under the hood

- **Links:** the app registers `tbo-copilot://` links (installed builds; not the portable EXE). A link goes only to the
  TBO Support plugin, which only asks; it is never acted on by itself.
- **The plugin's permissions:** `desktop.control` (making and opening the task's chat, grouping a project's folders) and
  `fs.read` (the folder picker), both granted to the built-in plugin.
- **TBO Support calls** (as you): your projects and tasks, start, pause, hold, resume, complete, a task's release, and
  asking to go live. The plugin calls nothing else (`lib/helpdesk.js`).
- **Kept on this computer:** `projects.json` in the plugin's data folder: each project's folders, its folder group, and
  each task's chat. No secret is kept there.
