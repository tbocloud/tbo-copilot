---
name: AWS server health
description: Use when someone asks how TBO's AWS servers are doing (EC2 instances, status checks, CPU, CPU credits, a server that seems down or slow). Reads only, with the tbo_aws tool.
---

# AWS server health

Report every EC2 instance in the region, healthy or not, with the tbo_aws tool's `read` action. Change nothing.

1. `tbo_aws` `status` first. If uv or the server is missing, say what the status says and stop.
2. The instances: `aws ec2 describe-instances`. For each one note the Name tag (that is how people know it: the
   Press control box, the workload, TBO Chat, the Copilot worker, the watcher, and so on), the instance id, type,
   state and availability zone.
3. The status checks: `aws ec2 describe-instance-status --include-all-instances`. A failed system check is AWS's
   hardware or network; a failed instance check is the machine itself (out of memory, a full disk, a kernel problem).
4. CPU for each running instance, the last hour:
   `aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<id> --start-time <one hour ago, ISO 8601 UTC> --end-time <now, ISO 8601 UTC> --period 300 --statistics Average Maximum`.
   For a t-family instance (t3, t4g), first its credit mode:
   `aws ec2 describe-instance-credit-specifications --instance-ids <id>`.
   - **standard:** also `--metric-name CPUCreditBalance`; a balance near zero means it is being slowed down.
   - **unlimited:** a zero balance does not slow it down. Look at `CPUSurplusCreditBalance` and
     `CPUSurplusCreditsCharged` instead: surplus credits being charged means it is running above its baseline at
     extra cost, not that it is throttled.
5. Disk and memory are not in EC2's numbers. For the Press boxes, point to the "TBO status" board in Grafana; for
   the others say they are not measured here.

Answer with one table: name, id, type, state, system check, instance check, CPU average and peak (1 h), CPU credits
(t-family), and a short note. Put anything not healthy first, and say plainly what looks wrong.

Never stop, start or reboot from this skill. A restart is a `change`, which asks an approver in Teams. Never suggest
stopping the Press control or workload boxes: the workload runs every customer site and TBO Support itself; that is
DevOps' call.
