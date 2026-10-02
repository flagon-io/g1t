---
title: Accounts and authentication
description: Accounts, email confirmation, access tokens and password reset.
---

## Creating an account

Register at [g1t.sh/register](https://g1t.sh/register). Usernames are
lowercase letters, digits and single hyphens, up to 39 characters.

Accounts can only be created in a browser. There is no API for it, by
design: it keeps passwords out of scripts and agents, and lets g1t protect
the one place accounts are made.

## Confirming your email

g1t sends a confirmation link from `noreply@g1t.sh`. It works for 24 hours.

Until you follow it you can sign in and look around, but you cannot create
repositories, push, or open issues and pull requests. Those requests fail with `403` and a
message telling you to confirm your address. To get a new link, sign in and
use the banner at the top of the site.

## Workspaces

A workspace owns repositories and is the first part of their address:
`g1t.sh/<workspace>/<repo>`. There is one kind. A workspace for just you and
one for a company are the same thing with a different number of members, so
there is no separate notion of an organization.

Your account does not own repositories itself. After confirming your email
you create a workspace, which can have the same name as your username, and
repositories go in it. You can belong to up to ten.

| Role | Can |
| --- | --- |
| Member | Create repositories, push, manage issues, merge pull requests. |
| Owner | Everything a member can, and add or remove members. |

Manage members on the workspace's page, `g1t.sh/<workspace>`.

## Access tokens

A token stands in for your password everywhere outside the website:

| Where | How to send it |
| --- | --- |
| git | As the password, with your username. |
| API | `Authorization: Bearer g1t_…` |
| MCP | The same header, set when you add the server. |

Create one in [Settings](https://g1t.sh/settings). A token is shown once,
when it is created; g1t stores only a hash of it. If you lose one, delete it
and create another. Delete a token the moment you think someone else has
seen it.

A token has the full rights of your account. Scoped tokens are planned.

## Signing in from a tool

An agent or command-line tool gets a token without ever handling your
password, the same way `gh auth login` works:

1. The tool asks g1t for a code and shows you a link and a short code such
   as `WDJB-MJHT`.
2. You open the link, sign in (or create an account), check that the code
   matches, and approve.
3. The tool collects its token.

```sh
# 1. The tool starts a sign-in.
curl -X POST https://api.g1t.sh/v1/device/code   -H "Content-Type: application/json"   -d '{"client_name": "my-tool"}'

# 2. You open verification_uri_complete from the response and approve.

# 3. The tool polls, no faster than "interval" seconds, until it is approved.
curl -X POST https://api.g1t.sh/v1/device/token   -H "Content-Type: application/json"   -d '{"device_code": "…"}'
```

The poll answers with a `status` of `pending`, `approved`, `denied` or
`expired`. An approved answer carries the token, once. Codes expire after 15
minutes. The token appears in your settings under the tool's name, where you
can delete it.

Only approve a code you asked for. Approving gives the tool the full rights
of your account.

## Resetting your password

Use [g1t.sh/forgot](https://g1t.sh/forgot). The emailed link works for one
hour. Setting a new password signs you out everywhere.

## What g1t stores

Passwords are stored as salted PBKDF2-SHA256 hashes. Sessions and tokens are
stored as SHA-256 hashes. Neither can be read back.
