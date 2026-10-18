---
title: Advisories and private reporting
description: What a repository tells people about vulnerabilities in what it ships, and how people tell its maintainers about one privately. Security advisories with G1TSA ids, drafted, published and withdrawn; private vulnerability reports, accepted into draft advisories.
---

The Reporting half of a repository's Security page is for vulnerabilities in
what the repository itself ships, as opposed to the
[findings](/guides/security/) g1t makes in its code and dependencies:

- A **security advisory** is the maintainers' own account of a vulnerability:
  what is affected, what fixes it, how bad it is and who found it. It is a
  draft until they publish it, visible to anyone who can see the repository
  once they do, and can be withdrawn.
- A **vulnerability report** is how someone outside tells the maintainers
  privately, when the repository takes such reports: from its Security tab,
  without a work item anyone can read. Accepting a report makes a draft advisory
  from it.

Both live under `g1t.sh/<owner>/<project>/security/advisories`; the Security
overview's **Reporting** rows say where each stands.

## The security policy

The first row of the overview is the repository's **security policy**: a
`SECURITY.md` on the default branch (or `.github/SECURITY.md`, or
`docs/SECURITY.md`) that says how to report a vulnerability and which
versions get fixes. When there is none, **Set up a security policy** commits
a starting one on a new branch and opens it as your pull request, as **Set
up code scanning** does with its workflow. The template says how to report,
names the private reporting form when that is on, and leaves the supported
versions for you to fill in. Anyone who can see a public repository sees the
policy from its Security tab.

## Advisories

### Writing one

Admins of the repository, and the workspace's
[security managers](/guides/access-and-roles/), write advisories: **New
advisory** under Advisories. An advisory has:

| Field                 | What it is                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title and description | One line, and Markdown: what the vulnerability is, how it is exploited, what to do. The description is needed before publishing.                                                                   |
| Severity              | Critical, high, medium or low.                                                                                                                                                                     |
| Affected package      | How it is distributed (`npm`, `crates.io`, `Go`, `PyPI`, or how the project ships), the package, the versions affected and the versions that fix it, as ranges people write (`>= 1.2.0, < 1.4.1`). |
| CVSS                  | A vector string and its score, when the maintainers scored it.                                                                                                                                     |
| CVE id                | `CVE-2026-12345`, when one was issued elsewhere.                                                                                                                                                   |
| Credits               | Who found or fixed it: usernames or names, up to twenty.                                                                                                                                           |

Every advisory has an id of the form `G1TSA-2026-h7kd-3mqw`, given when it is
drafted; pages and the API take it, or the `adv_…` id behind it.

### Draft, published, withdrawn

A **draft** is seen by those who see the repository's findings (Write, or a
security manager). Nobody is told of it.

**Publish** makes it visible to anyone who can see the repository, at
`…/security/advisories/G1TSA-…`, sends `security_advisory.published` to
[webhooks](/guides/webhooks/) and tells the repository's watchers who chose
**Security alerts**. A published advisory may be edited; the change shows at
once.

**Withdraw** takes it off the list for everyone but those who see findings,
and sends `security_advisory.withdrawn`. A withdrawn advisory can be published
again.

## Private vulnerability reporting

A repository takes private reports when **Private vulnerability reporting**
is on: a switch on the [Security overview](/guides/security/#the-overview)'s
Reporting rows and on the Security section's **Settings** page, for Admins
and security managers. Off by default.

With it on, **Report a vulnerability** is on the repository's Security tab
for anyone who can see it. Someone signed in reports under their name; on a
public repository someone signed out may report too, with an email address
the maintainers can answer at. A report has a title, a description (Markdown)
and, if the reporter has a view, a severity. Only the maintainers see it: the
reporter sees their own report sent, and nothing else of the repository's
reports.

The workspace's owners and security managers are told at once, in
[Notifications](/guides/notifications/#security) ("A vulnerability was
reported privately to acme/rocket") and by email, whatever their digest
settings say: a report is something to act on.

To keep the form from being flooded, one reporter sends at most five reports
a day to one repository, a repository holds at most fifty new reports
waiting, and the site limits how fast one address can post to it.

### Reviewing reports

Under **Advisories → Reports**, those who see findings read the reports,
new ones first. An Admin or security manager settles each:

- **Accept** makes a draft advisory from it, in the reporter's words and
  crediting the reporter, for the maintainers to finish and publish. The
  report links to the advisory.
- **Decline** closes it, with an optional note for the record.

Each is written to the workspace's [audit log](/guides/audit-log/), as
advisories drafted, changed, published and withdrawn are.

## API and MCP

| Route                                                       | What it does                                                                                                                       | Scope                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `GET /repos/{owner}/{name}/security/advisories`             | Lists advisories; filter with `state`. Published ones to anyone who can see the repository; every state to those who see findings. | `security:read`           |
| `POST /repos/{owner}/{name}/security/advisories`            | Drafts an advisory: `title`, `severity`, and the fields above in `snake_case`. Admin, or a security manager.                       | `security:write`          |
| `GET /repos/{owner}/{name}/security/advisories/{id}`        | One advisory, by `adv_…` or `G1TSA-…` id.                                                                                          | `security:read`           |
| `PATCH /repos/{owner}/{name}/security/advisories/{id}`      | Changes its fields; what is left out stays.                                                                                        | `security:write`          |
| `POST /repos/{owner}/{name}/security/advisories/{id}/state` | `state` `published` or `withdrawn`.                                                                                                | `security:write`          |
| `GET /repos/{owner}/{name}/security/reports`                | The reports, new ones first; filter with `state`. Those who see findings.                                                          | `security:read`           |
| `POST /repos/{owner}/{name}/security/reports`               | Reports a vulnerability: `title`, `description`, optional `severity`, and `email` without a token on a public repository.          | `security:write`, or none |
| `PATCH /repos/{owner}/{name}/security/reports/{id}`         | `decision` `accept` or `decline`, with an optional `note`.                                                                         | `security:write`          |

The MCP server's `security` tool has the same as actions: `advisories`,
`advisory`, `create_advisory`, `update_advisory`, `set_advisory_state`,
`reports`, `report_vulnerability` and `review_report`. The
[API reference](/reference/api/) documents each route.

Webhooks get `security_advisory.published`, `security_advisory.withdrawn` and
`security_advisory.reported` (which names no reporter and carries no
description: it says to look).
