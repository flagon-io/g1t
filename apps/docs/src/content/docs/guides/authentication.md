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
the first thing you do is create a workspace, and repositories go in it.
You can belong to up to ten.

Usernames and workspaces share one set of names, so a name means the same
thing wherever it appears. Your username is reserved for you: only you can
create a workspace with that name, and nobody can register a username that
is already a workspace.

| Role | Can |
| --- | --- |
| Member | Create repositories, push, manage issues, merge pull requests. |
| Owner | Everything a member can, and manage members, the workspace's access tokens and its details. |

A workspace's page, `g1t.sh/<workspace>`, shows its repositories and the
pull requests in progress across them. Members also see **People** and
**Access tokens** there, and owners **Settings**.

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

### Workspace access tokens

A workspace has access tokens of its own, for CI, integrations and agents
that work for a team. They replace the shared "service account" other
forges need: there is no extra account to create, pay for or lose the
password to.

| | Personal token | Workspace token |
| --- | --- | --- |
| Belongs to | You | The workspace |
| Acts as | You | The workspace: its name is the author of what it does |
| Can reach | Every workspace you belong to | That workspace only |
| Can do | Everything you can | What a member can; it cannot manage people, tokens or workspaces |
| When its creator leaves | Stops working | Keeps working |
| Created by | You, in Settings | An owner, under **Access tokens** on the workspace's page |

They are the same kind of token and are sent the same way. With git, any
username works; the token is the password. `GET /user` answers with
`"kind": "workspace"` for one, and `"kind": "user"` for a personal token.

Every member can see a workspace's tokens: the name, who created each and
when it was last used. Only owners can create or delete them.

## Signing in with OAuth

Applications that can open your browser, such as an agent connecting to the
[MCP server](/guides/bring-your-own-agent/), sign you in with OAuth 2.1.
You see a page on g1t naming the application and where it will send you
back, and you approve or deny. The application never sees your password and
there is no token to copy.

Applications you have approved are listed under **Connected applications**
in [Settings](https://g1t.sh/settings). Signing one out ends its access at
once.

For people building a client:

| | |
| --- | --- |
| Metadata | `https://api.g1t.sh/.well-known/oauth-authorization-server` |
| Authorization | `https://g1t.sh/oauth/authorize` |
| Token | `https://api.g1t.sh/oauth/token` |
| Registration | `https://api.g1t.sh/oauth/register` |

- The flow is authorization code with PKCE. `S256` is required.
- Clients are public: there are no client secrets.
- Register with `client_name` and `redirect_uris`. A redirect address is an
  `https` URL, `http` on `localhost`, or the application's own scheme. A
  client on `localhost` may use any port.
- Registration stores nothing. The client id it returns encodes what was
  registered, so it cannot be used to fill g1t with junk.
- An access token lasts 30 days. The refresh token returned with it works
  once and returns the next pair; the previous access token stops working.
- An authorization code lasts five minutes and works once.

## Signing in from a tool

A tool that cannot receive a redirect, such as a script on a remote machine,
gets a token without ever handling your password, the same way
`gh auth login` works:

1. The tool asks g1t for a code and shows you a link and a short code such
   as `WDJB-MJHT`.
2. You open the link, sign in (or create an account), check that the code
   matches, and approve.
3. The tool collects its token.

```sh
# 1. The tool starts a sign-in.
curl -X POST https://api.g1t.sh/device/code   -H "Content-Type: application/json"   -d '{"client_name": "my-tool"}'

# 2. You open verification_uri_complete from the response and approve.

# 3. The tool polls, no faster than "interval" seconds, until it is approved.
curl -X POST https://api.g1t.sh/device/token   -H "Content-Type: application/json"   -d '{"device_code": "…"}'
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
