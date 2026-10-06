---
title: Status and incidents
description: Where to see whether g1t is working, what each check measures, how incidents and maintenance are posted, how to subscribe, and the JSON and feeds behind the page.
---

[status.g1t.sh](https://status.g1t.sh/) says whether each part of g1t is
working now, how each has done over the last 90 days, what g1t staff have
said about anything that went wrong, and what planned maintenance is
coming. It runs as a service of its own, apart from the site, so it stays
up when g1t.sh does not.

The account menu at the bottom of the sidebar shows the same state as a
dot beside **Status**, and so does the footer of g1t.sh's public pages.

## What is checked

Every minute, each part gets one quick request, the same one a visitor
would make, over the public internet:

| Part | What the check does |
| --- | --- |
| Website and sign-in | Loads `g1t.sh/login`, and asks the API about an access token no one holds, which the account service must refuse with `401` |
| API | Loads `api.g1t.sh/` |
| Git and repositories | Lists the branches of a public repository over HTTPS (`info/refs`), the first step of every clone |
| Page speed | Loads a public project page (`g1t.sh/flagon-io/g1t`) and `g1t.sh/explore`, timed to the first byte of each answer |
| MCP server | Loads `mcp.g1t.sh/` |
| Documentation | Loads `docs.g1t.sh/` |
| Deployments | Loads `g1t.page/`. Each deployed app is not checked one by one. |
| Agents' model proxy | Loads `models.g1t.sh/`. The model providers behind it are not checked. |
| Sandboxes | Not checked yet: starting a sandbox costs money and takes seconds. The page says so rather than showing green. |
| Billing | Reads billing's price book. Stripe itself is not checked. |

A part that answers in over 1.5 seconds counts as slow, and one that
fails or takes over 5 seconds counts as down. **Page speed** is held to
a tighter budget: slower than 800 ms on either page counts as slow.

## What each part shows

A part shows the worse of its last check and what an open incident says
about it. During planned maintenance it shows **Under maintenance**
instead, unless an incident says something worse.

| State | Meaning |
| --- | --- |
| Operational | Its check answered quickly, and no incident says otherwise |
| Degraded | Slow to answer, or an incident reports degraded performance |
| Partial outage | An incident reports that it is partly down |
| Outage | Its check failed, or an incident reports a major outage |
| Under maintenance | Planned work on it is under way |
| Not monitored | It has no check, and no incident is open on it |

The banner at the top sums them up:

| Banner | When |
| --- | --- |
| All systems normal | Every checked part answered quickly, and no incident is open |
| Under maintenance | Planned work is under way, and nothing else is wrong |
| Degraded performance | Some parts are slow, and none is down |
| Partial outage | A part other than the website, API or git is down, a part is partly down, or an incident is open |
| Major outage | The website, the API or git is down, or an open incident reports a major outage |

## Uptime bars

Each part has a bar of 90 days, one square per day in UTC, newest on the
right. Hover over a square, tap it, or focus the bar and use the arrow
keys to see that day's share of answered checks, failed and slow checks,
the average response time, and any incident. On a phone the bar shows
the last 30 days.

| Square | The day |
| --- | --- |
| Green | At least 99.9% of checks answered, so one failed check in a day stays green |
| Peach | At least 95% answered, over a quarter of answers were slow, or an incident with degraded performance or a partial outage on the part was open |
| Red | Less than 95% answered, or an incident with a major outage on the part was open |
| Gray | No checks yet |

The percentage under each bar is the share of checks that answered over
90 days, rounded down, so a single failure never shows as 100%. Checks
made while a part is under planned maintenance are not counted.

## Incidents

When something goes wrong, g1t staff post an incident: a title, the
parts it affects and how badly, and updates as it moves from
**Investigating** to **Identified**, **Monitoring** and **Resolved**.

- Open incidents are shown at the top under **Happening now**, with every
  update, newest first.
- Each incident has a page of its own at
  `https://status.g1t.sh/incidents/<id>`, with its full history. Links in
  emails and feeds go there.
- Incidents resolved in the last 14 days are listed under **Past
  incidents**; [History](https://status.g1t.sh/history) lists every
  incident and maintenance of the last 12 months, by month.
- After a significant incident, g1t publishes a **postmortem** on the
  incident's page: a summary, the impact, a timeline, the root cause, what
  went well and badly, and what will change. Incidents with one are marked
  **Postmortem** in the lists.
- Times are shown in your time zone, with its abbreviation (`PDT`,
  `CEST`); hover one to see it in UTC. The JSON, the feeds and email keep
  UTC.

### Severity

Staff give every incident a severity. It decides how fast the team
responds and how often it posts updates; it is not shown on the status
page, which shows each part's impact instead.

| Severity | Meaning | Public updates |
| --- | --- | --- |
| SEV1 | Critical: g1t is down or unusable for most people, or data is at risk | At least every 30 minutes; subscribers are emailed |
| SEV2 | Major: a core part (sign-in, git, the API, agents) is broken or badly degraded for many people | At least hourly; subscribers are emailed |
| SEV3 | Minor: one part is degraded or broken for some people, and there is a way around it | As things change |
| SEV4 | Low: little or no customer impact | As things change |

### Noticed before anyone reports it

When a part fails, or is slow, three checks in a row, g1t staff are
alerted and an incident is drafted for them. It appears on the status
page once someone confirms it, usually within minutes. The part's own
state on the page changes at once either way, because it comes from the
checks.

A brief blip does not become an incident: if the part recovers and stays
healthy for 10 minutes before anyone confirms the draft, the draft is
dismissed and never appears on the page. While g1t is deploying, and for
3 minutes after, a slow restart is not drafted unless it outlasts the
deploy.

If something is broken and the page does not show it, write to
[hey@flagon.io](mailto:hey@flagon.io) or see
[support](https://g1t.sh/support).

## Planned maintenance

Work that may interrupt a part is announced ahead of time:

1. It is listed under **Upcoming maintenance** with its window (start and
   end, shown in your time zone), the parts it affects, and what you may
   notice.
2. When the window opens, it moves to **Maintenance in progress**, and its
   parts show **Under maintenance**.
3. When the window ends, it is marked complete on its own, with an update
   saying so. Staff can also start it early, finish it early, or cancel it.

Each maintenance window has a page at
`https://status.g1t.sh/maintenance/<id>`.

## Subscribe to updates

Get an email when an incident or maintenance is posted or updated:

1. Enter your address under **Subscribe to updates** on
   [status.g1t.sh](https://status.g1t.sh/), or on
   [status.g1t.sh/subscribe](https://status.g1t.sh/subscribe) to choose
   which parts you hear about. Leave every part clear to hear about all of
   them.
2. Open the email from `noreply@g1t.sh` and follow **Confirm
   subscription**, then press the button on the page. The link works once,
   for 24 hours. Nothing is sent until you confirm.
3. To change which parts you hear about, subscribe again with the same
   address and confirm again.

Every email has an **Unsubscribe** link at the bottom, and mail apps that
support one-click unsubscribing show it too. Staff choose per update
whether to email: SEV1 and SEV2 updates are emailed, smaller ones may
not be. The feeds carry every update.

## Feeds

Every public incident update and maintenance notice, newest first, the
last 50:

| Feed | Address |
| --- | --- |
| Atom (feed readers, Slack's RSS app, and most chat tools) | `https://status.g1t.sh/feed.xml` |
| JSON Feed 1.1 | `https://status.g1t.sh/feed.json` |

Each item links to the update on its incident's or maintenance's page.

## The status as JSON

`GET https://status.g1t.sh/status.json` returns the same report, readable
from any origin and cached for 30 seconds:

```sh
curl -s https://status.g1t.sh/status.json
```

```json
{
  "checked_at": "2026-10-05T14:03:00.000Z",
  "overall": {
    "state": "up",
    "title": "All systems normal",
    "line": "Every part of g1t answered its last check."
  },
  "components": [
    {
      "key": "api",
      "name": "API",
      "address": "api.g1t.sh",
      "checks": "The API's front page.",
      "state": "up",
      "check_state": "up",
      "detail": "Answered in 84 ms",
      "latency_ms": 84,
      "uptime_90d": 99.98
    }
  ],
  "incidents": [],
  "maintenance": []
}
```

| Field | What it is |
| --- | --- |
| `overall.state` | `up`, `degraded`, `down`, `maintenance`, or `unknown` before the first check |
| `components[].state` | What the page shows: `up`, `degraded`, `partial`, `down`, `maintenance`, or `unmonitored` |
| `components[].check_state` | What the last check alone said: `up`, `degraded`, `down` or `unmonitored` |
| `components[].uptime_90d` | Share of checks answered over 90 days, 0 to 100, or `null` |
| `incidents[]` | Open incidents, and those resolved in the last 90 days, newest first |
| `incidents[].status` | `investigating`, `identified`, `monitoring` or `resolved` |
| `incidents[].impact` | `down` when any part has a major outage, otherwise `degraded` |
| `incidents[].component_impacts` | Each affected part's `key` and `impact`: `degraded`, `partial_outage` or `major_outage` |
| `incidents[].url` | The incident's page |
| `incidents[].postmortem_published_at` | When its postmortem was published, or `null` |
| `incidents[].updates` | Newest first, each with `id`, `at`, `status` and `text` |
| `maintenance[]` | Maintenance scheduled or under way, soonest first, each with `title`, `message`, `components`, `starts_at`, `ends_at`, `state` (`scheduled` or `in_progress`), `url` and `updates` |

`https://status.g1t.sh/badge.svg` is a small badge with the banner's
words, for a README or a dashboard.

The old addresses, `g1t.sh/status` and `g1t.sh/status.json`, redirect
here.
