---
title: Secret protection
description: Custom secret patterns, pushing past push protection with a reason, delegated bypass, validity checks, and every place a secret was found.
---

Secret scanning finds keys and tokens in what you push and in your
history; [Security](/guides/security/#secret-scanning) covers the
built-in formats, push protection and dismissing alerts. This page covers
what goes further: patterns of your own, getting a blocked push through
with a reason, having owners approve that, and asking a secret's issuer
whether it still works.

| Feature | Public repositories | Private repositories |
| --- | --- | --- |
| Secret scanning and push protection | Free | Free |
| Bypass with a reason | Free | Free |
| Custom patterns | Free | Security and quality activation |
| Delegated bypass | Free | Security and quality activation |
| Validity checks | Free | Security and quality activation |

See [What's free and what's paid](/guides/security/pricing/).

## The Secret scanning page

`g1t.sh/<owner>/<project>/security/secret-scanning` lists the
repository's secret alerts. Filter them by:

| Filter | Values |
| --- | --- |
| State | Open (in the history, or blocked at a push), Dismissed, Fixed |
| Type | Each kind of secret found, custom patterns by name |
| Validity | Active, Inactive, Unknown, No check |
| Bypassed | Bypassed, Not bypassed |

Each alert has its own page with every place the secret was found (file,
line and commit), what happened to it, its bypass requests, and its
actions: **Dismiss** or **Reopen** (Admin), **Check with its issuer**,
**Fix with g1t** and, for a blocked push, **Bypass**.

A secret is one alert however many places hold it: the same value found
in another file or another commit adds a location, not an alert.

## Custom patterns

A custom pattern is a secret format of your own, such as your company's
internal API keys. Published, push protection refuses pushes that add a
match and the default branch's history is scanned again for it, exactly as
for the built-in formats.

A repository's patterns are under **Custom patterns** on its Secret
scanning page; a workspace's, which cover every repository in it, are at
`g1t.sh/<owner>/-/security/patterns`. A repository is scanned with its own
patterns and its workspace's, up to 100 in all.

To add one:

1. Open **New pattern**.
2. Give it a **Name**, such as `Acme API key`.
3. Write the **Secret format** as a regular expression: `acme_[a-z0-9]{32}`.
4. Optionally, say what must come right **before** and **after** the
   secret, also as regular expressions. Without them, the secret must start
   at the beginning of a line or after a character that is not a letter or
   digit, and end the same way.
5. Add **test strings**, one a line, and **Save as draft**: each test
   string shows where the pattern matched.
6. **Dry run** it: the pattern runs over the default branch (up to 2,000
   files and 20 MB) and lists what it would find, the matches masked.
   Nothing is recorded. A workspace's dry run reads up to ten of its
   repositories.
7. **Publish** it.

Patterns use the [Rust regex syntax](https://docs.rs/regex/latest/regex/#syntax).
Every pattern runs in time linear in the text it reads, so no pattern can
stall a push: there is no look-around and there are no back-references,
which are what make other engines slow on some inputs. A pattern is
refused, with the reason, when it:

- is longer than 1,000 characters,
- does not compile, or compiles to more than 1 MB,
- matches an empty string.

Matching is per line: a secret that spans lines is not found. Lines longer
than 4,000 characters (minified code) and lockfiles are skipped, as for the
built-in formats. A line with `g1t:allow-secret` on it is never reported.

Changing a pattern's format while it is published scans the history again
too. Deleting one keeps the alerts it found. Repository patterns take the
Admin role; workspace patterns, an owner.

## Pushing past push protection

When push protection refuses a push, git's message has a link for each
secret, to its alert:

```text
remote: If it is not a real secret (a test fixture), or you will rotate it later:
remote:   - add g1t:allow-secret in a comment on its line, or
remote:   - bypass it with a reason at https://g1t.sh/acme/rocket/security/secret-scanning/sec_…
remote:     A bypass is recorded with your name and reason (or goes to an owner
remote:     to approve, if your workspace asks), then the same push goes through.
```

On the alert, choose **Bypass push protection** with a reason:

| Reason | API value | The alert |
| --- | --- | --- |
| It's a false positive | `false_positive` | Closed as a false positive |
| It's used in tests | `used_in_tests` | Closed as used in tests |
| I'll fix it later | `will_fix_later` | Stays open, to be rotated; it counts as critical once it lands |

Then push again, unchanged. Anyone with Write may bypass. The bypass is
recorded on the alert (who, when, the reason and your comment) and in the
workspace's [audit log](/guides/audit-log/) as
`secret_scanning.bypass`.

### Delegated bypass

With **Delegated bypass** on, in the workspace's Security settings
(`g1t.sh/<owner>/-/security/settings`), someone who pushed a blocked
secret asks instead: **Ask to bypass** records a request, and the
workspace's owners are told in their [notifications](/guides/notifications/). The
workspace's owners and the repository's admins review requests at
`g1t.sh/<owner>/-/security/bypass-requests`:

1. Open the request.
2. **Approve** or **Deny**, with a comment if you like.
3. An approved request bypasses push protection as its requester asked; they
   are told and push again.

Nobody reviews their own request. Owners and admins bypass directly, as
without delegation. Requesters can **Cancel request**. Each step is in the
alert's activity and the audit log (`secret_scanning.bypass_requested`,
`secret_scanning.bypass_reviewed`).

## Validity checks

With **Validity checks** on in the workspace's Security settings, g1t asks
a secret's issuer whether it still works, and marks the alert:

| Validity | Meaning |
| --- | --- |
| Active | The issuer accepted it. Rotate it. |
| Inactive | The issuer refused it: revoked, expired or never real. |
| Unknown | The issuer could not say (an error, a rate limit), or the secret never landed, so it cannot be read again. |
| No check | There is no safe way to ask about this kind of secret. |

Each check is the issuer's own read-only identity call, made over HTTPS by
the service that read the secret from your repository. The secret goes
nowhere else, and is never stored:

| Secret | Check |
| --- | --- |
| GitHub token | `GET https://api.github.com/user` |
| GitLab personal access token | `GET https://gitlab.com/api/v4/personal_access_tokens/self` |
| Stripe live key | `GET https://api.stripe.com/v1/balance` (a restricted key without access to it is still active) |
| Slack token | `POST https://slack.com/api/auth.test` |
| npm token | `GET https://registry.npmjs.org/-/whoami` |
| OpenAI API key | `GET https://api.openai.com/v1/models` |
| Anthropic API key | `GET https://api.anthropic.com/v1/models` |
| SendGrid key | `GET https://api.sendgrid.com/v3/scopes` |

Other formats have no check: an AWS access key cannot be checked without
its secret key, a Slack webhook address would post a message, and the rest
have no read-only identity call. Custom pattern matches are never checked.

Open alerts are checked again weekly, and on request with **Check with its
issuer** on the alert.

## Fix with g1t

**Fix with g1t** on a secret alert opens an issue for g1t to take the
secret out of the code and read it from configuration instead (an
environment variable, or the repository's
[Actions secrets](/guides/secrets-and-variables/)). Its pull request lands
through your required checks. Taking a secret out of the code does not make
it safe: it is in the history, so whoever owns it still rotates it with its
issuer and marks the alert **Revoked**. The agent's run is charged as
[agent usage](/guides/usage-and-billing/).

## API and MCP

| Route | What it does | Scope |
| --- | --- | --- |
| `GET /repos/{owner}/{name}/secret-scanning/alerts` | Lists alerts; filter with `state`, `secret_type`, `validity`, `bypassed`. | `security:read` |
| `GET /workspaces/{workspace}/secret-scanning/alerts` | The same across a workspace. | `security:read` |
| `GET /repos/{owner}/{name}/secret-scanning/alerts/{id}` | One alert with its locations, activity and requests. | `security:read` |
| `PATCH /repos/{owner}/{name}/secret-scanning/alerts/{id}` | Dismisses (`state` `dismissed`, `reason`, `comment`) or reopens (`state` `open`). Admin. | `security:write` |
| `GET /repos/{owner}/{name}/secret-scanning/alerts/{id}/locations` | Where the secret was found. | `security:read` |
| `POST /repos/{owner}/{name}/secret-scanning/alerts/{id}/bypass` | Bypasses push protection with `reason`, or asks to. | `security:write` |
| `POST /repos/{owner}/{name}/secret-scanning/alerts/{id}/validity` | Checks with the issuer. | `security:write` |
| `GET /workspaces/{workspace}/secret-scanning/bypass-requests` | Bypass requests; filter with `state`, `repo`. | `security:read` |
| `PATCH /workspaces/{workspace}/secret-scanning/bypass-requests/{id}` | `decision` `approve`, `deny` or `cancel`. | `security:write` |
| `GET`, `POST /repos/{owner}/{name}/secret-scanning/custom-patterns` | Lists or creates patterns (also under `/workspaces/{workspace}`). | `security:read`, `security:write` |
| `PATCH`, `DELETE …/custom-patterns/{id}` | Changes, publishes or deletes one. | `security:write` |
| `POST …/custom-patterns/dry-run` | Runs a pattern over the default branch without saving it. | `security:write` |

Over MCP, the [`security` tool](/reference/mcp/#security) has the actions
`secret_alerts`, `secret_alert`, `update_secret_alert`, `secret_locations`,
`bypass`, `check_validity`, `bypass_requests`, `review_bypass`, `patterns`,
`create_pattern`, `update_pattern`, `delete_pattern` and
`dry_run_pattern`. g1t's own agents never bypass, dismiss or change
patterns. Webhooks: `secret_scanning_alert.created`, `.fixed`,
`.dismissed`, `.reopened`, and `secret_scanning.bypass_requested`,
`secret_scanning.bypass_reviewed`; see [Webhooks](/guides/webhooks/).
