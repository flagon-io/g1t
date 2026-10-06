# Incident runbook

For g1t staff. How to declare, run, resolve and write up an incident, and
how to schedule maintenance, in sudo (**Platform → Incidents**,
`https://sudo.g1t.sh/incidents`). Everything here is recorded in sudo's
**Audit log** with your email. The public side is described in
`apps/docs/src/content/docs/guides/status.md`.

## The short version

1. **Declare** as soon as people are affected. A wrong first guess is
   fine; silence is not.
2. **Update** publicly on the cadence the severity asks for, even when
   nothing changed ("Still working on it; next update by 15:30 UTC").
3. **Resolve** when it is fixed, with one sentence on what fixed it.
4. **Write the postmortem** within five working days for SEV1 and SEV2.

## Severity

| Severity | When | Public updates | Email subscribers | Postmortem |
| --- | --- | --- | --- | --- |
| SEV1 | g1t is down or unusable for most people, or data is at risk | Every 30 minutes at least | Yes | Required |
| SEV2 | A core part (sign-in, git, the API, agents) is broken or badly degraded for many people | Hourly at least | Yes | Required |
| SEV3 | One part is degraded or broken for some people; there is a way around it | As things change | Your call | If there is a lesson |
| SEV4 | Little or no customer impact | As things change | No | No |

When unsure, pick the higher one. Lowering it later is one change.

## Roles

- **Incident commander (IC)**: runs the response. Decides, assigns work,
  keeps the timeline honest. Not necessarily the person fixing it.
- **Communications**: writes the public updates and keeps the cadence.
  For a small incident the IC does both.

Set both on the declare form or in **Roles** on the incident page. A
change of role is written on the timeline.

## Declaring

**Declare incident** on the Incidents page:

1. **Title**: what people notice, not the internals. "Pushes over HTTPS
   failing", not "pack-receiver 502s on eu-2".
2. **Severity**: see the table.
3. **Status**: usually **Investigating**.
4. **Impact began (UTC)**: leave empty for now, or backdate to when it
   really started. The time-to-acknowledge, mitigate and resolve figures
   count from here.
5. **Parts affected**: set each affected part to Degraded performance,
   Partial outage or Major outage. The status page shows that (or worse,
   if the checks say worse) until the incident is resolved.
6. **First public update**: what is broken, for whom, and what still works.
7. **Email subscribers**: "As the severity says" emails for SEV1 and SEV2.
8. **Declare and publish**. It is on status.g1t.sh within 30 seconds.

## Detected drafts

When a part fails or is slow three checks in a row (three minutes), the
status worker makes a **draft** incident and emails `STATUS_ALERT_EMAIL`
(hey@flagon.io) with a link. A draft is not on the status page; the
part's own state already is, from the checks.

Open it from the **Drafts** tab (the sidebar's Incidents count includes
drafts) and either:

- **Publish to the status page**, with a public title (the "Detected:"
  prefix is dropped) and a first update; or
- **Dismiss draft** with a reason, if it was a blip. Dismissed drafts are
  listed under Resolved and never appear publicly.

While an incident is open on a part, more failures on it add a line to
that incident's timeline instead of a new draft, and the part answering
again adds a "answering again" line.

## Running it

The incident page has the timers at the top (open for, to acknowledge,
to mitigate, to resolve) and two columns: the timeline on the left, and
resolve, parts, roles, follow-ups and links on the right.

**Post an update** (left):

- **Public update**: shown on the status page and in the feeds; emailed
  to subscribers when the box is ticked (ticked by default for SEV1 and
  SEV2). Changing the status always needs a public update, because the
  status page shows each status with words.
- **Internal note**: staff only. Use it for findings, links to logs,
  who is doing what. Notes never reach the status page, the feeds or
  email, but the postmortem's timeline starts from them, so keep them
  factual.
- **Status**: Investigating → Identified (cause known) → Monitoring (fix
  out, watching) → Resolved. Reaching Monitoring marks it mitigated.
- **Severity** and **Change the parts' impact**: change them as you learn
  more; each change is a line on the timeline.

The timeline shows everything, newest first: public updates highlighted
in lavender with the number of subscribers emailed, notes in gray, and
one-line entries for every status, severity, impact, role and follow-up
change.

**Follow-ups**: add anything that should change so it does not happen
again, with an owner. Tick them off as they are done; they fill the
postmortem's action items.

## Resolving

**Resolve** (right column) with one or two sentences: what is fixed and,
if known, what fixed it. It posts the last public update, sets the
resolved time, and the parts stop showing the incident's impact. If it
comes back, post an update with an earlier status: that reopens it.

## Postmortem

From a resolved incident, **Write the postmortem**. The editor starts
with:

- **Impact**: the parts, how badly and for how long;
- **Timeline**: every timeline line in UTC, internal notes included;
- **Action items**: the follow-ups.

**Edit out anything internal** (hostnames, customer names, people's
names in blame) before publishing. Write the **Summary** and **Root
cause** (both required to publish), and what went well and badly. A blank
line starts a paragraph; lines starting with `- ` become a list.

**Save draft** shows the preview beside the editor. **Save and publish**
(or **Publish the saved draft**) puts it on the incident's public page,
`https://status.g1t.sh/incidents/<id>#postmortem`, and marks the incident
"Postmortem published". **Take down** removes it again.

Blameless: say what the system allowed, not who slipped.

## Scheduled maintenance

**Schedule maintenance** on the Incidents page:

1. Title, window (UTC, at most 72 hours, at most 180 days ahead), the
   parts affected, and a message saying what people will notice.
2. **Email subscribers** emails them now, when it starts and when it ends.

It is listed as upcoming at once. The minutely job starts it when the
window opens (its parts show "Under maintenance" and their checks stop
counting against uptime) and completes it when the window ends. From its
page you can post updates, **Start now**, **Complete** early, or
**Cancel**.

If the work breaks something beyond what was announced, declare an
incident: an incident's impact shows over maintenance.

## Configuration

The status worker (`apps/status/wrangler.jsonc`):

| Setting | What it does |
| --- | --- |
| `send_email` binding `EMAIL` | Cloudflare Email Sending, as identity uses. Without it nothing is emailed; the feeds still work. |
| `STATUS_SECRET` (secret) | Signs unsubscribe links. Without it, the subscribe form is off. `npx wrangler secret put STATUS_SECRET` |
| `STATUS_ALERT_EMAIL` | Who hears about detected drafts. Empty sends none. |
| `STATUS_URL`, `SUDO_URL` | Links in email and feeds, and the alert's link to sudo. |
| `STATUS_FROM` | The From address. |

sudo reaches the status worker only through its `STATUS` service binding
(`StatusAdmin` entrypoint); status.g1t.sh itself has no way to write.
