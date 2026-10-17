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

Owners only, at **Workspace → Access → Single sign-on**,
`g1t.sh/<workspace>/-/sso`.

1. Choose the protocol. Use **OpenID Connect** when your provider offers
   it; **SAML 2.0** for providers set up for SAML apps; **OAuth 2.0** for
   one with neither.
2. In your provider, create an app with the addresses the page shows:

   | | |
   | --- | --- |
   | Redirect URI (OpenID Connect, OAuth 2.0) | `https://g1t.sh/auth/sso/<workspace>/callback` |
   | Entity id, audience (SAML) | `https://g1t.sh/auth/sso/<workspace>/metadata` |
   | Assertion consumer service URL, HTTP-POST (SAML) | `https://g1t.sh/auth/sso/<workspace>/saml` |
   | Metadata (SAML) | `https://g1t.sh/auth/sso/<workspace>/metadata` |

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

With **Let people from your provider join** on (the default), anyone your
provider signs in becomes a member of the workspace when they first sign
in through it, with no invitation: send them to
`g1t.sh/auth/sso/<workspace>`. They need a g1t account with a confirmed
email address first, and the workspace's other rules still apply, such as
[requiring two-factor authentication](/guides/workspaces/#require-two-factor-authentication).
Turn it off and only people who are already members can sign in through
it.

## Require it

Turn on **Require single sign-on** under **Test and require**. From then
on a member uses the workspace only:

- **On the site**, from a session that signed in through your provider in
  the last day. After a day they go through it again, which is usually
  instant: your provider remembers them.
- **With an access token, SSH key or git credentials**, once they have
  linked their account.

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
  your client id, unexpired, and answer this sign-in's nonce. g1t receives
  it straight from your provider's token endpoint over TLS.
- **SAML** responses must be signed, the assertion or the whole response,
  with RSA and SHA-256, SHA-384 or SHA-512, by one of the certificates you
  saved. The response must answer the request g1t sent (sign-ins started
  at your provider are refused), be addressed to the workspace's assertion
  consumer service, name g1t's entity id as the audience, come from your
  provider's entity id, and be in its validity window. Leave the assertion
  unencrypted: it reaches g1t over HTTPS.

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

## Not yet

Provisioning and deprovisioning with SCIM is not available yet. Until it
is, someone you remove at your provider keeps their g1t session for up to
a day and their tokens until an owner removes them from the workspace or
unlinks them.
