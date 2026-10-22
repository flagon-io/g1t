---
title: Single sign-on
description: Connect a workspace to your identity provider over SAML 2.0, OpenID Connect or OAuth 2.0, let its people join, and require it of members. On every paid plan.
---

A workspace can connect to its own identity provider, such as Okta,
Microsoft Entra ID, Google Workspace, Auth0, OneLogin or JumpCloud, over
**OpenID Connect**, **SAML 2.0** or plain **OAuth 2.0**. It comes with
every paid plan at no extra price. A free workspace sees the page with
everything turned off until an owner starts the plan.

Single sign-on never signs anyone in to g1t. People sign in to g1t as
themselves, with their password, GitHub and two-factor authentication as
usual, then sign in through your provider to use the workspace. The
first time they do, g1t links who they are at your provider to their g1t
account. Their personal repositories and other workspaces are never your
provider's to open.

## Set it up

Owners only, at **Workspace → Security → Authentication security → Single sign-on**,
`g1t.sh/<workspace>/-/settings/sso`.

1. Choose the protocol. Use **OpenID Connect** when your provider offers
   it; **SAML 2.0** for providers set up for SAML apps; **OAuth 2.0** for
   one with neither.
2. In your provider, create an app with the addresses the page shows:

   |                                                  |                                                   |
   | ------------------------------------------------ | ------------------------------------------------- |
   | Redirect URI (OpenID Connect, OAuth 2.0)         | `https://g1t.sh/auth/sso/<workspace-id>/callback` |
   | Entity id, audience (SAML)                       | `https://g1t.sh/auth/sso/<workspace-id>/metadata` |
   | Assertion consumer service URL, HTTP-POST (SAML) | `https://g1t.sh/auth/sso/<workspace-id>/saml`     |
   | Metadata (SAML)                                  | `https://g1t.sh/auth/sso/<workspace-id>/metadata` |

   They name the workspace by its id (`wsp_…`), which never changes, so
   renaming the workspace leaves your provider's setup as it is. The page
   shows them with the id filled in.

3. Copy what the provider gives you back into the page:
   - **OpenID Connect**: the issuer (where its
     `/.well-known/openid-configuration` lives), the client id and the
     client secret. Scopes default to `openid email profile`.
   - **SAML 2.0**: the provider's entity id (its issuer), its single
     sign-on URL, and its signing certificate (PEM). Paste more than one
     while you rotate certificates.
   - **OAuth 2.0**: the authorization, token and userinfo URLs, the client
     id and secret, the scopes, and which claims of the userinfo answer
     are the person's stable id (`sub`, then `id`, by default) and their
     address (`email`).

4. Choose **Set up single sign-on**. For OpenID Connect g1t reads the
   issuer's discovery document first, and says so if it cannot.

The client secret is kept encrypted and never shown again; leave it empty
when you save other changes to keep it.

## Test it

Choose **Test sign-in**. g1t sends you to your provider and back, links
your account, and marks the connection **Tested** with your name. You
must have signed in through it yourself before you can require it of
everyone.

## Let people join

Turn on **Let people from your provider join** (it starts off) and anyone
your provider signs in becomes a member of the workspace when they first
sign in through it, with no invitation: send them to
`g1t.sh/auth/sso/<workspace>`. g1t asks them to confirm first, so a link
alone never makes anyone a member. They need a g1t account with a
confirmed email address, and the workspace's other rules still apply, such
as [requiring two-factor authentication](/guides/workspaces/#require-two-factor-authentication).

**Only addresses at** limits who may join to people whose address your
provider vouches for (OpenID Connect's `email_verified`, or a signed SAML
assertion) at your domains, such as `acme.com`. Set it, or leave joining
off, whenever your provider lets anyone sign in: a personal Google or
GitHub account would otherwise let in anyone. With joining off, only
people who are already members can sign in through it.

## Require it

Turn on **Require single sign-on** under **Test and require**. From then
on a member uses the workspace only:

- **On the site**, from a session that signed in through your provider in
  the last day. After a day they go through it again, which is usually
  instant: your provider remembers them.
- **With an access token or SSH key**, once they have linked their account
  (and, with [SCIM](#scim), while your provider still has them assigned).
- **Never with their g1t password** for git over HTTPS: use a token.

A member who has not keeps their place but cannot use the workspace: its
private repositories, pages and API answer as if they were not a member,
including repositories they have a role on directly, and every page shows
a notice with a link to sign in through your provider.

**Owners are never held out**, so a provider that breaks or a certificate
that expires never locks you out of your own workspace. Outside
collaborators are not asked: they are not your provider's people.

## Linked people

The page lists everyone who has signed in through your provider, who they
are there, and when they last did. **Unlink** someone to let them link
another account at your provider; their sessions go through it again.
Each account at your provider links to one g1t account, and each g1t
account to one account at your provider.

Changing the provider itself (the protocol, the issuer, or the SAML entity
id) unlinks everyone and stops requiring it, until someone has signed in
through the new one. Changing the client, the scopes or the certificate
keeps everyone linked.

## What g1t checks

- **OpenID Connect and OAuth 2.0** use the authorization code flow with
  PKCE. For OpenID Connect, the ID token must be issued by your issuer, for
  your client id, unexpired, and answer this sign-in's nonce, and its
  signature must verify with a key your provider publishes (its
  `jwks_uri`): RS256, RS384, RS512, PS256, PS384, PS512 or ES256. Tokens
  signed with a shared secret (HS256) or not at all are refused.
- **SAML** responses must be signed, the assertion or the whole response,
  with RSA and SHA-256, SHA-384 or SHA-512, by one of the certificates you
  saved. The response must answer the request g1t sent (sign-ins started
  at your provider are refused), be addressed to the workspace's assertion
  consumer service, name g1t's entity id as the audience, come from your
  provider's entity id, and be in its validity window. When only the
  assertion is signed, its own subject confirmation must name g1t's
  request. Responses with comments or processing instructions are refused.
  Leave the assertion unencrypted: it reaches g1t over HTTPS.

## If the plan ends

The settings stay. Members cannot sign in through your provider until the
plan starts again, so a workspace that requires it holds its members out
meanwhile; owners can still turn the requirement off. Turning it off and
removing it never need a plan.

## Remove it

**Danger zone → Remove** forgets your provider and who everyone is there,
and stops requiring it. Members keep their place in the workspace.

## Audit log

Recorded in the workspace's [audit log](/guides/audit-log/):
`sso.created`, `sso.updated`, `sso.deleted`, `sso.required`,
`sso.not_required`, `sso.identity_linked`, `sso.identity_unlinked`, and
`member.joined_by_sso`.

## API and MCP

Owners can do all of it with an access token, through the REST API or the
`workspace` tool's actions on the MCP server:

|                                           | REST                                                       | MCP action            | Scope             |
| ----------------------------------------- | ---------------------------------------------------------- | --------------------- | ----------------- |
| Read it, with where to point the provider | `GET /workspaces/{workspace}/sso`                          | `get_sso`             | `workspace:read`  |
| Set it up or change it                    | `PUT /workspaces/{workspace}/sso`                          | `configure_sso`       | `workspace:admin` |
| Require it, or stop                       | `PUT /workspaces/{workspace}/sso/required`                 | `set_sso_required`    | `workspace:admin` |
| Remove it                                 | `DELETE /workspaces/{workspace}/sso`                       | `delete_sso`          | `workspace:admin` |
| The linked people                         | `GET /workspaces/{workspace}/sso/identities`               | `list_sso_identities` | `access:read`     |
| Unlink someone                            | `DELETE /workspaces/{workspace}/sso/identities/{username}` | `unlink_sso_identity` | `access:admin`    |

`configure_sso` takes `protocol` (`oidc`, `oauth2` or `saml`) and the
protocol's fields as the page names them: `issuer`, `client_id`,
`client_secret`, `scopes`; `authorization_url`, `token_url`,
`userinfo_url`, `subject_claim`, `email_claim`; `idp_entity_id`,
`idp_sso_url`, `certificate` (PEM). Its answer, like `get_sso`'s, has
`service_provider`: the `redirect_uri`, `entity_id`, `acs_url`,
`metadata_url` and `sign_in_url` to give your provider and your people.
The client secret is never returned.

```sh
curl -X PUT https://api.g1t.sh/workspaces/acme/sso   -H "Authorization: Bearer $G1T_TOKEN"   -d '{"protocol": "oidc", "issuer": "https://acme.okta.com", "client_id": "0oa1b2c3", "client_secret": "…"}'
```

Signing in through the provider is a trip in the browser, so it has no
API: send people to `sign_in_url`.

## SCIM

With SCIM, your provider tells g1t who is assigned to the workspace, and
who is not any more:

- Only people your provider has assigned, and not deactivated, can sign in
  through it. Someone else is told to ask whoever runs your provider.
- Someone it unassigns, deactivates or deletes leaves the workspace at
  once: their membership, their roles on its repositories and teams, their
  link, and their sessions through it. Their g1t account is theirs and
  stays. **Owners are never removed this way**; the audit log says so, and
  you remove one by hand if they should go.
- People, not groups. Assign a group to the app in your provider and its
  members are provisioned one by one. Groups your provider pushes are
  accepted and not kept, so pushing them never fails.

To turn it on, open **Single sign-on → SCIM provisioning** and choose
**Turn on SCIM**. Give your provider:

|                            |                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| SCIM base URL (tenant URL) | `https://api.g1t.sh/scim/v2/<workspace-id>`                                                                                |
| Authentication             | Bearer token: the SCIM token, shown once                                                                                   |
| Unique identifier          | `userName`                                                                                                                 |
| Supported                  | Create, update (PUT and PATCH), deactivate and delete users; filtering by `userName`, `externalId`, `id` or `emails.value` |

Whoever signs in through your provider is matched to the person it
assigned by a stable id it gave (the SAML NameID, OpenID's `sub`, and for
Microsoft Entra ID the object id and a member's user principal name) as
their `userName` or `externalId`, or by an address your provider vouches
for as their `userName` or primary address. If more than one assigned
person matches, nobody is chosen and they are told so. **Make a new
token** replaces the old one at once; **Turn off SCIM** forgets who was
assigned and removes nobody.

Through the API: `POST /workspaces/{workspace}/sso/scim` (`enable_scim`)
answers with the token and `scim_url`; `DELETE` turns it off
(`disable_scim`). `get_sso` lists who is assigned under `scim`. Recorded as
`sso.scim_enabled`, `sso.scim_token_rotated`, `sso.scim_disabled`,
`sso.scim_user_provisioned`, `sso.scim_user_activated`,
`sso.scim_user_deactivated`, `sso.scim_user_deleted`,
`member.removed_by_scim` and `sso.scim_owner_kept`, with `scim` as the
actor.
