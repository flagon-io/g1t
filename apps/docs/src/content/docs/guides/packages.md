---
title: Packages
description: Publish and install packages beside your code, with the same people, roles and tokens.
---

A workspace can publish packages to g1t and install them from it, beside
the code they are built from: container images and npm packages, with
Composer, Cargo and Go to follow. Each registry speaks its tool's own
protocol, so `docker` and `npm` work with nothing but a login and an
address.

| Registry | Address | Guide |
| --- | --- | --- |
| Container images | `g1t.sh/<workspace>/<name>` | [Container images](/guides/containers/) |
| npm | `https://g1t.sh/-/npm/`, for the scope `@<workspace>` | [npm](/guides/npm/) |

## Names

Every package's name starts with its workspace: `g1t.sh/acme/web` is the
`web` image of the `acme` workspace. A name may have more parts after it,
such as `g1t.sh/acme/web/worker`.

## Who can see and publish a package

A package is linked to a repository, or belongs to its workspace.

- **Linked.** The first push of an image whose name starts with a
  repository's name (`acme/web`, `acme/web/worker` for the repository
  `acme/web`) links it to that repository; so does the first publish of
  an npm package whose `package.json` `repository` is a g1t.sh repository
  of the workspace, or which is named like one (`@acme/web`). It then has
  the repository's visibility and [roles](/guides/access-and-roles/):

  | | Needs |
  | --- | --- |
  | Pull | Read: on a public repository, anyone, signed in or not |
  | Push a new version or tag | Write |
  | Delete versions and the package, change its settings | Admin |

- **Unlinked.** A package whose name matches no repository is the
  workspace's. It is private: members pull and push it by the workspace's
  [base permission](/guides/access-and-roles/#the-base-permission) (Read pulls,
  Write pushes), and only owners delete it or change its settings. An owner
  can make it public, and then anyone can pull it.

A linked package can be unlinked, and an unlinked one linked to a
repository of its workspace by someone with Admin on that repository.

Private packages look exactly like ones that do not exist to anyone who may
not pull them.

## Tokens

Sign in to a registry with your username and an
[access token](/guides/authentication/#access-tokens) as the password.
A token with scopes needs the package ones:

| Scope | Lets a token |
| --- | --- |
| `packages:read` | Pull private packages. Public ones need no scope. |
| `packages:write` | Push and publish. Includes `packages:read`. |
| `packages:delete` | Delete versions and packages |

Tokens with full access, and tokens made before scopes, have all three. A
token never does more than its owner could: `packages:delete` alone does not
let a member delete an owner's package.

In [workflows](/guides/actions/#secrets-and-variables), `G1T_TOKEN` is the
workspace's own token for the run: it pushes and pulls the workspace's
packages with no setup. A g1t agent at work on a repository may push the
packages of that repository, as it may push its code, and never deletes
them.

## Storage

Every file is kept once, by its content: two images that share a layer
store it once, and a layer pushed again is not stored again. A workspace's
storage counts each file once, as public when any public package uses it.

Files no version uses any more are deleted a day after the last version
that used them goes.

Without the [g1t plan](/guides/usage-and-billing/#the-g1t-plan), public
packages may hold 10 GB and private ones 500 MB per workspace; a push past
either is refused, with a message saying how much is used. On the plan,
storage past those amounts is charged instead. See
[storage and pull limits](/guides/containers/#storage-and-pull-limits).

## Events and the audit log

Publishing a version, deleting a version and deleting a package are
[audit log](/guides/audit-log/) entries, and the events
`package.published`, `package.version_deleted`, `package.deleted` and
`package.visibility_changed`, which [webhooks](/guides/webhooks/) can be
sent: a linked package's go to its repository's webhooks and its
workspace's, an unlinked package's to its workspace's webhooks.
