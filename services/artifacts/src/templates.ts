/**
 * The page templates g1t ships. A workspace saves its own beside them (the
 * `templates` table). Each is Markdown, so a template is also what an
 * agent asked to "write up a postmortem" starts from. Pure.
 */
import type { DocTemplate } from "@g1t/contracts";

const builtin = (id: string, name: string, icon: string, description: string, markdown: string): DocTemplate => ({
  id: `builtin:${id}`,
  name,
  icon,
  description,
  builtin: true,
  markdown: markdown.trim() + "\n",
  created_by: null,
});

export const BUILTIN_TEMPLATES: DocTemplate[] = [
  builtin(
    "meeting-notes",
    "Meeting notes",
    "🗓️",
    "Who was there, what was decided, and who does what next.",
    `
**Date:**
**Attendees:**

## Agenda

-

## Notes

-

## Decisions

-

## Action items

- [ ]
`,
  ),
  builtin(
    "rfc",
    "Spec / RFC",
    "📐",
    "A proposal to review: the problem, the design, and what else was considered.",
    `
> [!NOTE]
> **Status:** Draft · **Author:** · **Reviewers:**

## Summary

One paragraph: what this proposes and why.

## Problem

What is wrong or missing today, and who it hurts.

## Goals

-

## Non-goals

-

## Design

How it works. Diagrams welcome:

\`\`\`mermaid
flowchart LR
  A[Request] --> B[Service] --> C[(Store)]
\`\`\`

## Alternatives considered

-

## Rollout

-

## Open questions

-
`,
  ),
  builtin(
    "decision",
    "Decision record",
    "⚖️",
    "One decision, its context and its consequences, so nobody asks again.",
    `
> [!NOTE]
> **Status:** Proposed · **Date:** · **Deciders:**

## Context

What forces are at play.

## Decision

What we will do.

## Options

| Option | Pros | Cons |
| --- | --- | --- |
|  |  |  |

## Consequences

What becomes easier, and what becomes harder.
`,
  ),
  builtin(
    "runbook",
    "Runbook",
    "🧰",
    "Steps for when something breaks, written for whoever is on call at 3am.",
    `
> [!WARNING]
> Use this when:

## Symptoms

-

## Check

1.

## Fix

1.

## Escalate

Who to call, and when.

## Background

Dashboards, logs and the code involved.
`,
  ),
  builtin(
    "onboarding",
    "Onboarding",
    "👋",
    "A new teammate's first week: people, tools, and a first task.",
    `
Welcome! This page gets you from zero to your first change.

## Your first day

- [ ] Get access to the workspace and its channels
- [ ] Meet your onboarding buddy
- [ ] Read how we work

## Your first week

- [ ] Set up your machine
- [ ] Ship a small change

## People to know

| Who | Ask them about |
| --- | --- |
|  |  |

## Useful links

-
`,
  ),
  builtin(
    "project-brief",
    "Project brief",
    "🎯",
    "Why a project exists, what done looks like, and who is on it.",
    `
## Why

The problem, and why now.

## What done looks like

-

## Scope

**In:**

**Out:**

## Team

| Role | Who |
| --- | --- |
| Lead |  |

## Milestones

- [ ]

## Risks

-
`,
  ),
  builtin(
    "postmortem",
    "Postmortem",
    "🩹",
    "What happened, why, and what changes so it doesn't happen again. Blameless.",
    `
> [!CAUTION]
> **Severity:** · **Duration:** · **Customers affected:**

## Summary

What happened, in two sentences.

## Timeline

| Time | What happened |
| --- | --- |
|  |  |

## Root cause

## What went well

-

## What went badly

-

## Action items

- [ ]
`,
  ),
  builtin(
    "weekly-update",
    "Weekly update",
    "📬",
    "What shipped, what's next, and what's in the way.",
    `
## Shipped

-

## In progress

-

## Next week

-

## Blocked

-
`,
  ),
];

export function builtinTemplate(id: string): DocTemplate | null {
  return BUILTIN_TEMPLATES.find((t) => t.id === id) ?? null;
}
