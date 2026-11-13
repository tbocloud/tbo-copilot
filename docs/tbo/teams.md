# TBO Copilot in Microsoft Teams

TBO Copilot is a personal chat in Teams. It runs on TBO Support (the hub), as you, with your TBO Support permissions.

**Using it:** §1–§2. **Setting it up for the organisation:** §3–§4, for TBO's Microsoft 365 admin.

## 1. What you can write

| You write | Copilot |
|---|---|
| `help` | Shows what it can do |
| `what is waiting for me?` | Your approvals and fix tasks |
| *"what did Copilot change in TASK-2026-00123, and why?"* | Answers from the run's own record, with links |
| `approve it`, or `reject: the tier is per customer` | Shows the fix's card; you press Approve, or Yes to reject with your reason |
| *"use the price list rate instead"* | Asks Copilot for a new fix with your words, after you confirm |
| *"Alpha Trading: quotation discount wrong"*, with a screenshot or video | Raises a ticket for that customer and lets Copilot investigate, after you confirm |
| `fix ticket 0009`, or `build ticket 0004` | Asks Copilot to fix a bug it diagnosed, or build an approved customisation |
| `status of acme.tbo365.cloud`, `take a backup of demo.tbo365.cloud` | Press: a site's status; a backup runs at once |
| `restart the bench of acme`, `update demo.tbo365.cloud` | Press: an approver gets a card first |
| `remind me in 2 hours` | Snoozes an approval's reminders |
| `report a problem: …` | Files a task for the TBO Copilot team ([report-a-problem.md](report-a-problem.md)) |

**Nothing changes until you press Yes** on Copilot's card, or a card's own button (Approve, Reject, Let Copilot fix it).

**Cards you did not ask for:**
- a fix waiting for your approval;
- news of a fix you approved or started;
- the 09:00 digest of what waits for you.

## 2. If Copilot does not know you

If Teams cannot tell Copilot your work email, Copilot answers with **Link my Teams account**:
1. Open the link. It works once, for 30 minutes.
2. Sign in to TBO Support as yourself if asked.
3. Press **Link**.

**Only TBO Support agents can use Copilot.** Anyone else who opens it gets a polite refusal.

## 3. Publish the app for the organisation (admin)

**Once per hub; repeat steps 1, 2 and 4 for each new version.**

1. **Set the version and pages.** In TBO Support → HDS Copilot Settings → Teams bot:
   - **Raise Teams app version** (for example 1.0.3). Teams refuses a package whose version it already has.
   - **Fill in the Privacy page and Terms of use page.** The app's listing links to them.
2. **Download the package.** As a System Manager, open `https://<the hub>/api/method/helpdesk.api.copilot_teams.app_package`.
3. **Upload it to the organisation's catalogue.** In the Teams admin centre:
   - First time: Teams apps → Manage apps → **Upload new app** → choose the zip.
   - An update: open **TBO Copilot** in Manage apps → **Upload file** (the same app ID, a higher version).
4. **Make it available to everyone.** In Manage apps → TBO Copilot:
   - set the status to **Allowed**;
   - set who can install it to **Everyone**, or allow it in the org-wide permission policy if your tenant still uses policies.
   - People without a TBO Support agent account get the refusal in §2.
5. **Install and pin it for the support staff.** Teams apps → Setup policies → **Add**, for example *TBO Copilot staff*:
   - Installed apps: add **TBO Copilot**.
   - Pinned apps: add **TBO Copilot**.
   - Assign the policy to the group of TBO Support agents (Group policy assignment).
   - Teams can take up to 24 hours to install it for everyone.
6. **Check.** One of the staff writes `help` to TBO Copilot.

**What the app asks of Microsoft:**
- The package asks for `identity` and `messageTeamMembers`, and nothing else.
- The bot has **no Microsoft Graph permission**.
- The hub accepts calls from TBO's own tenant only.
- To set up the bot itself (the Azure Bot and its secret), see helpdesk's `docs/tbo-copilot.md`, *Setting up the bot*.

## 4. Meetings: limit the calendar permission

TBO Support's meetings feature uses an Entra app with the Graph **application** permission `Calendars.ReadWrite`. It is set in HD Meeting Settings.

**The risk:** without a limit, that permission reaches every mailbox in the tenant.

**The fix:** an Exchange **ApplicationAccessPolicy** keeps it to staff mailboxes.

**What you need:**
- Exchange Online PowerShell;
- an Exchange admin;
- the app's client ID (Application ID) from HD Meeting Settings' Connected App.

```powershell
Connect-ExchangeOnline -UserPrincipalName <admin>@<your domain>

# 1. A mail-enabled security group of the mailboxes meetings may use (the staff who organise meetings)
New-DistributionGroup -Name "TBO Support meeting organisers" -Alias tbo-meeting-organisers -Type Security
Add-DistributionGroupMember -Identity tbo-meeting-organisers -Member <staff member>@<your domain>
#    (one line per person; later joiners are added the same way)

# 2. Limit the app to that group
New-ApplicationAccessPolicy -AppId <client id> `
  -PolicyScopeGroupId tbo-meeting-organisers@<your domain> `
  -AccessRight RestrictAccess `
  -Description "TBO Support meetings: staff calendars only"

# 3. Check: Granted for a member, Denied for anyone else
Test-ApplicationAccessPolicy -Identity <staff member>@<your domain> -AppId <client id>
Test-ApplicationAccessPolicy -Identity <someone not in the group>@<your domain> -AppId <client id>
```

**After the policy:**
- It can take up to an hour to apply.
- A meeting by someone outside the group then fails with Graph's "Access is denied". Add that person to the group.

**Microsoft's newer way:** *RBAC for Applications* in Exchange Online does the same with a management scope. Microsoft recommends it over ApplicationAccessPolicy, which still works. Either way, keep a written list of who is in the scope.

**Offboarding:** the hub reads the directory with `User.Read.All`. That permission is read-only, and no Exchange policy narrows it. It is accepted as is ([security.md](security.md), F10).
