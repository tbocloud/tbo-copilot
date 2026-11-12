# AWS from TBO Copilot (`tbo_aws`)

**Status:** built for TBO Copilot Phase 18 (TASK-2026-00020). The tool lives in the bundled `tbo.support` plugin
(`tbo/plugins/tbo.support/lib/aws.js`), next to the TBO Support sign-in it uses for approvals.

TBO's team can check TBO's AWS (region `ap-south-1`) from the desktop app, and ask for a change, with **their own
AWS login**. Reads run at once. A change needs a setting on the person's computer **and** an approver in Teams for
that exact command. Delete and terminate operations are blocked in this version; any other change is shown to the
approver as the exact command before it can run.

## How it works

```
TBO Copilot (the person's computer)                                  TBO Support            Teams
  agent ── tbo_aws read ──► AWS API MCP server, READ_OPERATIONS_ONLY ─► AWS (the person's profile / SSO)
  agent ── tbo_aws change ─► block list ─► ask ───────────────────────► action approval ──► approver's card
           (same command again, once approved) ───── approved? ◄────── Approved
           ──► AWS API MCP server for this one call ─► AWS ─► outcome ─► recorded on the approval
```

- The plugin runs the official **AWS API MCP server** (`awslabs.aws-api-mcp-server`, pinned to one version) itself,
  over stdio, with `uv`. The app's own MCP support approves a tool by its name only, not by the command, and cannot
  answer the server's consent questions, so the plugin decides instead.
- **Reads** go to a server started with `READ_OPERATIONS_ONLY=true`: AWS's own list of read operations decides what
  runs. That server stays up for ten minutes between calls. A handful of reads that hand back a secret (a Secrets
  Manager value, a decrypted parameter, a Windows password, STS credentials, registry passwords) are refused before
  they reach it.
- **Changes** are two calls. The first passes the checks below and asks TBO Support for an **action approval** of the
  exact command, profile and region; an approver gets the card in Teams (or the TBO Support panel) and nothing runs.
  When the person says it is approved, the agent calls `change` again with exactly the same command: TBO Support
  confirms the approval (approved by someone else, within the hour), the plugin starts a server for that one call,
  runs it, and records the outcome on the approval. An approval is spent once it has run, and expires after 60
  minutes either way. Every read and change ends within 100 seconds, inside the app's 110-second limit; a change
  that gets no answer in time is recorded as spent ("may have run, check AWS"), so it can never run twice.
- **An upload is approved for its content.** For `aws s3 cp` or `sync` from a local folder, the tool hashes every
  file when it asks; the card shows the file count and the hash, and the approval names that hash. A file changed
  after the approval no longer matches, and the tool asks again instead of uploading.
- **Global options:** the checks read the service and operation after any AWS CLI global options
  (`aws --region x kms decrypt` is checked as `kms decrypt`). `--profile`, `--endpoint-url`, `--ca-bundle`,
  `--no-verify-ssl` and `--no-sign-request` are refused anywhere: the profile is the one in the settings (the one the
  approval names), and AWS's own endpoints are used with TLS checked.
- **Credentials** never pass through the plugin. The server reads the person's AWS profile (or SSO login) from their
  own `~/.aws`. AWS keys in the app's environment are not passed to the server. AWS output is cleaned of key-shaped
  text (access key ids, secret and session values, private keys) before the model sees it, and is marked as data,
  not instructions.
- Telemetry of the AWS server is off. Its `suggest_aws_commands` tool is not used: it would send the question to an
  AWS web service.

## Set it up (once per person)

1. **uv.** macOS or Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`. Windows:
   `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`. If the app does not find it,
   set **uv location** in Settings → Plugins → TBO Support.
2. **An AWS login.** TBO's AWS admin gives each person an IAM Identity Center (SSO) profile: a **read-only** one for
   everyone, and a **changes** one (no deletes, no IAM) for the people who may change things. Set it up with
   `aws configure sso` and log in with `aws sso login --profile <name>`. Never put AWS keys in the plugin, a chat or
   Git.
3. **The plugin settings** (Settings → Plugins → TBO Support): **AWS profile** (the profile's name), **AWS region**
   (`ap-south-1`), and, only for someone allowed to ask for changes, **Allow AWS changes**. For the website update,
   **Website bucket** and **Website CloudFront distribution** (from TBO's internal AWS notes).
4. **Install the AWS server:** ask the agent "set up the AWS tool" (`tbo_aws` `setup`). It installs the pinned version
   with uv in about a minute; "AWS tool status" then shows it ready.

## What is allowed, what is logged, what is blocked

| | What | Recorded where |
|---|---|---|
| **Allowed at once** | Any read AWS classifies as read-only: instances and status checks, CloudWatch metrics, DNS records, buckets and objects listed, CloudFront distributions, Elastic IPs, volumes, Cost Explorer | the app's own tool log |
| **Allowed after approval** | A change that passes the block list: start, stop or reboot an instance, a DNS record created or changed (`UPSERT`), an upload to a bucket, a CloudFront invalidation, and the like. Needs **Allow AWS changes** on the person's computer and an approver who is not the person | the action approval in TBO Support (who asked, the exact command, who approved, when, the outcome) and HDS Copilot Call Log |
| **Blocked** | Any operation that deletes or ends something (`delete*`, `terminate*`, `remove*`, `deregister*`, `purge*`, `disassociate*`, `revoke*`, `release*`, `detach*`); `aws s3 rm`, `rb`, `mv`; any `--delete`; a change batch with `DELETE` in it (plain or escaped JSON); S3 bucket lifecycle rules (they expire objects); IAM, STS, Organizations, SSO, KMS, Secrets Manager and account changes; a change that hides its content in `file://`; a change across all regions (`--region *`); the secret-returning reads above | refused before anything is sent |

The AWS permission sets are the second net: the read-only profile cannot change anything even if a check were wrong,
and the changes profile has no delete or IAM permissions.

## Runbooks (skills)

The plugin brings four skills the agent follows with `tbo_aws`:

| Skill | Use |
|---|---|
| **AWS server health** | Every instance: state, status checks, CPU and CPU credits for the last hour, by Name tag. Reads only |
| **AWS DNS records** | List a hosted zone's records; a new or changed record by approval (`UPSERT`), with what could break |
| **Website update on AWS** | Back up the website bucket to a separate backup location, upload the new files from the AWS tool's work folder, invalidate CloudFront: three approvals, in order |
| **AWS addresses and cost** | Elastic IPs and disks nothing uses; the month's cost by service; days that jump |

The AWS server reads local files only from its work folder (`status` shows where); a website build is put there
before the upload.

## Check it works

1. "How are our AWS servers?" lists every instance with its status checks and CPU.
2. "List the DNS records of teambackoffice.com" lists the zone's records.
3. With **Allow AWS changes** on: "Add a TXT record `_tbo-test.teambackoffice.com` with the value `hello`" answers
   "waiting for approval" with the approver's name, and a card reaches them in Teams. After Approve, "run it" creates
   the record; the approval in TBO Support shows the command, who approved it and the outcome.
4. "Delete that record" is refused (a change batch with `DELETE`).
5. With **Allow AWS changes** off, the same TXT request is refused on the computer, and TBO Support hears nothing.
