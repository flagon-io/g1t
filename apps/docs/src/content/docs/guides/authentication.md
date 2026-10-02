---
title: Accounts and authentication
description: Accounts, email confirmation, access tokens and password reset.
---

## Creating an account

Register at [g1t.sh/register](https://g1t.sh/register), or through the API:

```sh
curl -X POST https://api.g1t.sh/v1/register \
  -H "Content-Type: application/json" \
  -d '{"username": "you", "email": "you@example.com", "password": "at least ten characters"}'
```

Usernames are lowercase letters, digits and single hyphens, up to 39
characters. Your username is your namespace: `g1t.sh/<username>`.

## Confirming your email

g1t sends a confirmation link from `noreply@g1t.sh`. It works for 24 hours.

Until you follow it you can sign in and look around, but you cannot create
repositories, push, or open intents. Those requests fail with `403` and a
message telling you to confirm your address. To get a new link, sign in and
use the banner at the top of the site.

## Access tokens

A token stands in for your password everywhere outside the website:

| Where | How to send it |
| --- | --- |
| git | As the password, with your username. |
| API | `Authorization: Bearer g1t_…` |
| MCP | The same header, set when you add the server. |

Create one in [Settings](https://g1t.sh/settings), or with your password:

```sh
curl -X POST https://api.g1t.sh/v1/tokens \
  -H "Content-Type: application/json" \
  -d '{"username": "you", "password": "…", "name": "laptop"}'
```

A token is shown once, when it is created. g1t stores only a hash of it. If
you lose one, delete it and create another. Delete a token the moment you
think someone else has seen it.

A token has the full rights of your account. Scoped tokens are planned.

## Resetting your password

Use [g1t.sh/forgot](https://g1t.sh/forgot). The emailed link works for one
hour. Setting a new password signs you out everywhere.

## What g1t stores

Passwords are stored as salted PBKDF2-SHA256 hashes. Sessions and tokens are
stored as SHA-256 hashes. Neither can be read back.
