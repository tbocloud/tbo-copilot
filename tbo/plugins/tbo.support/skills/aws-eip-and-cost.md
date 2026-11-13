---
name: AWS addresses and cost
description: Use when someone asks about TBO's AWS bill, cost by service, or waste such as Elastic IPs and disks nothing uses. Reads only, with the tbo_aws tool.
---

# AWS addresses and cost

Reads only, with the tbo_aws `read` action. Nothing is released or deleted from here: removing an address or a disk
is blocked, and is TBO's admins' call.

## Elastic IPs

`aws ec2 describe-addresses`. An address with no `AssociationId` is attached to nothing and is still billed
(about $3.65 a month each). List every address with its Name tag (if any), the instance it belongs to, and flag the
unattached ones.

## Disks nothing uses

`aws ec2 describe-volumes --filters Name=status,Values=available`. Each is billed for its size every month. List
id, size, type, created, and any Name tag; flag them.

## Cost

Cost Explorer charges about $0.01 per question, so ask it only what the person asked:

- This month by service: `aws ce get-cost-and-usage --time-period Start=<first day of this month>,End=<today> --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE`.
  On the first day of a month there is no finished day yet (`Start` and `End` would be the same day, which holds no
  days): say so instead of asking, and offer last month (`Start=<first day of last month>,End=<first day of this month>`).
- Day by day for the last two weeks: the same with `--granularity DAILY` and that period.

`End` is not included, and `Start` and `End` are dates (YYYY-MM-DD). Show the total first, then the top services,
in US dollars rounded to cents. Point out a day that is more than a third above the days around it, and what drove
it (group that day by service).
