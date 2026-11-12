---
name: AWS DNS records
description: Use when someone asks to list or change DNS records in Route 53 (a hosted zone such as teambackoffice.com or tbocloud.in). Lists with read; a new or changed record asks an approver in Teams.
---

# AWS DNS records (Route 53)

## Listing

1. `aws route53 list-hosted-zones` with the tbo_aws `read` action: find the zone's id (the part after
   `/hostedzone/`).
2. `aws route53 list-resource-record-sets --hosted-zone-id <id>`.

Show a table: name, type, TTL, values (or the alias target). Keep the zone's NS and SOA records at the end.

## Adding or changing a record

A record change is a `change`: it needs "Allow AWS changes" on this computer and an approver in Teams for that exact
command. Write the whole change in the command (never `file://`), with `UPSERT` (or `CREATE` for a name that must
not exist yet), for example a test record:

```
aws route53 change-resource-record-sets --hosted-zone-id <id> --change-batch '{"Comment":"TBO Copilot test","Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"_tbo-test.teambackoffice.com","Type":"TXT","TTL":60,"ResourceRecords":[{"Value":"\"hello\""}]}}]}'
```

1. Before asking, list the current records of that name, and tell the person what changes: the old value and the
   new one. A record that a site, mail (MX, SPF, DKIM, DMARC) or a certificate check depends on deserves a sentence
   on what could break.
2. Call `change` with a one-sentence `reason`. It returns "waiting for approval" with the approver's name: tell the
   person, and stop. Nothing has run.
3. When the person says it is approved, call `change` again with exactly the same command. It runs once.
4. Read the record back to confirm, and give the change id AWS returned (`aws route53 get-change --id <id>` shows
   when it reached every DNS server).

A change batch with `DELETE` is blocked: deleting a record is for TBO's admins in the AWS console.
