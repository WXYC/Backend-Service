# EC2 → CloudWatch metric push: IAM grant (BS#965)

The CloudWatch agent on `wxyc-ec2` was running and pushing 1-min host metrics,
but every `PutMetricData` call was returning `AccessDenied`. As a result, the
intended memory and swap alarms sat in `INSUFFICIENT_DATA` permanently — the
post-mortem on the 2026-05-17 15-hour outage (#937) flagged this as the
second-leg detection gap.

This doc captures the IAM change to grant the EC2 instance role the
metric-push permission, plus the verification steps the acceptance bullets
on #965 require.

## What to attach

AWS-managed policy `CloudWatchAgentServerPolicy` (ARN
`arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy`) covers exactly the
agent's surface: `cloudwatch:PutMetricData`, `ec2:DescribeTags`,
`logs:CreateLogGroup` / `CreateLogStream` / `PutLogEvents` /
`DescribeLogStreams`, and `ssm:GetParameter` (for agent-config retrieval).

Prefer the AWS-managed policy over a hand-rolled inline JSON: it's the
official least-privilege surface for the agent and gets updated by AWS when
the agent itself adds new APIs.

If a custom inline policy is preferred (e.g. to drop `ssm:GetParameter`
because the agent config is in `/opt/aws/...` on disk rather than SSM), this
is the minimum:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudWatchAgentMetrics",
      "Effect": "Allow",
      "Action": ["cloudwatch:PutMetricData"],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "cloudwatch:namespace": "CWAgent"
        }
      }
    },
    {
      "Sid": "CloudWatchAgentTags",
      "Effect": "Allow",
      "Action": ["ec2:DescribeTags"],
      "Resource": "*"
    }
  ]
}
```

The namespace condition pins the grant to the `CWAgent` namespace the agent
publishes under — application-level pushes (Backend-Service publishing to a
custom namespace) are unaffected. Drop the condition if Backend-Service ends
up publishing host metrics from a different namespace.

## Applying it

Needs WXYC production AWS account creds (account `203767826763`, region
`us-east-1`) — `wxyc-ec2` and its instance role live there, NOT in the
`503977661500` infra account. The 2026-05-17 outage RCA on #965 listed the
infra account, but cross-references in this repo (`scripts/provision-dryrun-aws.mjs`,
`.env.example` SES topic ARN) confirm production is `203767826763`.

```sh
# Identify the role attached to the wxyc-ec2 instance:
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters 'Name=tag:Name,Values=wxyc-ec2' \
  --query 'Reservations[].Instances[].InstanceId' --output text)

PROFILE_ARN=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[].Instances[].IamInstanceProfile.Arn' --output text)

PROFILE_NAME="${PROFILE_ARN##*/}"

ROLE_NAME=$(aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" \
  --query 'InstanceProfile.Roles[].RoleName' --output text)

# Attach the managed policy:
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy

# Verify:
aws iam list-attached-role-policies --role-name "$ROLE_NAME"
```

IAM policy attachments take effect on the EC2 instance within seconds (the
agent caches credentials via IMDSv2 and refreshes on each `PutMetricData`
batch).

## Verification

The acceptance bullets on #965:

1. **Agent log clears `AccessDenied`** — within ~5 min of the attach:

   ```sh
   ssh wxyc-ec2 -- sudo journalctl -u amazon-cloudwatch-agent --since '5 min ago' \
     | grep -E 'AccessDenied|PutMetricData' | tail -20
   ```

   Expect zero `AccessDenied` hits; expect periodic successful `PutMetricData`
   calls (the agent logs both successes and failures at info level).

2. **Alarms transition out of `INSUFFICIENT_DATA`**:

   ```sh
   aws cloudwatch describe-alarms \
     --alarm-names <memory-alarm-name> <swap-alarm-name> \
     --query 'MetricAlarms[].[AlarmName,StateValue,StateReason]'
   ```

   Expect `StateValue=OK` (or `ALARM` if the host is already over the
   threshold). Should happen within one full evaluation period after the
   metrics start landing — for a 1-min metric with a 1-period evaluation,
   that's ~1 min after the first successful push.

3. **End-to-end alarm fire**: stress the host so the memory alarm trips and
   the SNS subscriber receives a page.

   ```sh
   ssh wxyc-ec2 -- 'stress-ng --vm 1 --vm-bytes 1G --timeout 120s'
   ```

   Expect the memory alarm to transition `OK → ALARM` within the alarm's
   evaluation period (1 min for the existing 1-period config; check before
   running so the period is what you expect) and the SNS subscriber to
   receive the alarm notification.

   Tear down isn't needed — `stress-ng` exits cleanly after the timeout.

## Why an attached policy, not an inline one

The repo's IAM convention for EC2 hosts isn't documented yet — this is the
first explicit grant for `wxyc-ec2`'s role. Going with the AWS-managed
policy because:

- The agent's surface is exactly what AWS publishes under the managed
  policy. Inlining duplicates that without adding constraints we actually
  need.
- The post-mortem #937 trail-of-evidence is cleaner when the diff is
  `+CloudWatchAgentServerPolicy` than `+30 lines of JSON`.
- If future agent versions add APIs (e.g. cross-region tag lookup), the
  managed policy gets updated by AWS without us tracking it.

If a different convention emerges from other hosts in the WXYC infra
account, switch then; the namespace-pinned inline JSON above is the smallest
correct replacement.

## Related

- **Parent**: #937 — 2026-05-17 EC2 wedge RCA. The semantic-index half of
  that ticket closed via `semantic-index#318`. This issue closes the
  Backend-Service half.
- **Account note**: production EC2 (`wxyc-ec2`) lives in account
  `203767826763`. Cross-references: `scripts/provision-dryrun-aws.mjs`,
  the `SES_EVENTS_SNS_TOPIC_ARN` default in `.env.example`. The infra
  account `503977661500` named in the #965 issue body is a documentation
  drift, not where the EC2 role actually lives.
