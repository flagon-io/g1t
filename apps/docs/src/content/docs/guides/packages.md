---
title: Packages
description: Publish and install packages beside your code, with the same people, roles and tokens.
---

A workspace can publish packages to g1t and install them from it, beside
the code they are built from: container images, npm packages, Rust
crates, Maven artifacts, NuGet packages, Ruby gems, Composer packages and
Go modules. Each registry speaks its tool's own protocol, so `docker`,
`npm`, `cargo`, `mvn` and Gradle, `dotnet`, `gem` and Bundler, `composer`
and `go` work with nothing but a login and an address. Composer packages and Go modules are
read from the workspace's repositories: there is nothing to upload.

| Registry | Address | Guide |
| --- | --- | --- |
| Container images | `g1t.sh/<workspace>/<name>` | [Container images](/guides/containers/) |
| npm | `https://g1t.sh/-/npm/`, for the scope `@<workspace>` | [npm](/guides/npm/) |
| Cargo | `sparse+https://g1t.sh/-/cargo/<workspace>/index/`, a registry per workspace | [Cargo](/guides/cargo/) |
| Maven | `https://g1t.sh/-/maven/<workspace>/`, a repository per workspace, for Maven and Gradle | [Maven](/guides/maven/) |
| NuGet | `https://g1t.sh/-/nuget/<workspace>/v3/index.json`, a feed per workspace, with a symbol server | [NuGet](/guides/nuget/) |
| RubyGems | `https://g1t.sh/-/rubygems/<workspace>/`, a registry per workspace, for `gem push`, `gem install` and Bundler | [RubyGems](/guides/rubygems/) |
| Composer | `https://g1t.sh/-/composer/<workspace>/`, from the workspace's repositories | [Composer](/guides/composer/) |
| Go | `g1t.sh/<workspace>/<repo>`, straight from git | [Go modules](/guides/go/) |

## Names

Every package's name starts with its workspace: `g1t.sh/acme/web` is the
`web` image of the `acme` workspace. A name may have more parts after it,
such as `g1t.sh/acme/web/worker`.

## Who can see and publish a package

Everyone has one role on a package, the highest of what reaches them:

| Role | Lets them |
| --- | --- |
| Read | Pull and install it. Anyone, signed in or not, may on a public package. |
| Write | Also publish new versions and tags. |
| Admin | Also delete and restore it and its versions, and change its [settings](#package-settings). |

A package is linked to a repository, or belongs to its workspace, and that
decides where its roles come from:

- **Linked.** The first push of an image whose name starts with a
  repository's name (`acme/web`, `acme/web/worker` for the repository
  `acme/web`) links it to that repository, unless its
  [source label](/guides/containers/#link-an-image-with-its-source-label)
  names another; so does the first publish of an npm package whose
  `package.json` `repository` is a g1t.sh repository of the workspace, or
  which is named like one (`@acme/web`), and of a crate whose `Cargo.toml`
  `repository` is one, or which is named like one. Maven artifacts (by
  artifactId, or the POM's `<scm><url>`), NuGet packages (by
  `RepositoryUrl`, or their id) and gems (by `source_code_uri`, or their
  name) are linked the same way. It has the repository's visibility and,
  while it **inherits access** (the default), its
  [roles](/guides/access-and-roles/): Read and Triage pull, Write and
  Maintain publish, Admin administers.
- **Unlinked.** A package whose name matches no repository is the
  workspace's. It is private: members pull and push it by the workspace's
  [base permission](/guides/access-and-roles/#the-base-permission) (Read pulls,
  Write pushes), and an Admin base permission still only pushes. An admin
  can make it public, and then anyone can pull it.

On top of that:

- **The workspace's owners** are admins of every package.
- **People and teams given a role on the package itself**, under
  [Manage access](#manage-access), have that role, or the one their
  repository or base permission gives them if it is higher. A team's role
  reaches its child teams' people too.
- **Turning off inheriting** on a linked package leaves only the roles
  given on the package itself, and the workspace's owners: the
  repository's roles no longer reach it. Its visibility is still the
  repository's.

Private packages look exactly like ones that do not exist to anyone who may
not pull them.

## Package settings

A package's admins see a **Settings** tab on its page, at
`g1t.sh/<workspace>/-/packages/<type>/<name>?tab=settings`:

| Setting | What it does |
| --- | --- |
| Inherit access from the linked repository | On (the default), the repository's roles reach the package. Off, only the roles below and the workspace's owners do. Linked packages only. |
| Manage access | People (by username) and teams of the workspace (by slug), each with the Read, Write or Admin role on the package. |
| Manage Actions access | The repositories whose workflows may use the package, each with Read or Write. See [below](#manage-actions-access). |
| Visibility | Public or private, for an unlinked package. A linked one has its repository's. |
| Repository | Link it to a repository of its workspace (Admin on that repository is needed too), or unlink it: it is then the workspace's, and private. |
| Deleted versions | Versions deleted in the last 30 days, each with **Restore**. |
| Delete this package | Delete it, with every version. See [deleting and restoring](#delete-and-restore). |

### Manage access

Add a person by username, or a team of the workspace by its slug, with a
role; change a role from its row, or remove it. What a repository or the
workspace gives someone stays when the package's own role is removed.

### Manage Actions access

A workflow job's [`G1T_TOKEN`](/guides/actions/#the-jobs-token) reaches a
package only from these repositories:

| Repository | Its workflows may |
| --- | --- |
| The one the package is linked to | Pull and publish it, always. It is listed, and cannot be removed: unlink the package instead. |
| One added with Read | Pull it |
| One added with Write | Pull and publish it |
| Any other | Nothing: the job is refused, with a message naming the package and saying to add its repository here. A public package still pulls. |

A package a workflow job makes that is not linked to the job's repository
(a workspace package, say `g1t.sh/acme/tools` pushed from `acme/web`) is
given its repository with Write, so the workflow that made it keeps
publishing it. The job's token is still held to the job's own
`permissions:`, never deletes a package and never changes its settings.

## Delete and restore

Deleting a package, or one version, hides it from every registry at once:
pulls and installs get "not found", as for one that never existed. It is
kept for **30 days**, and until then:

- An admin of the package can restore it: a version from the package's
  **Settings → Deleted versions**, a package from **Deleted packages** on
  the workspace's Packages page (`g1t.sh/<workspace>/-/packages?view=deleted`),
  listed for whoever administers it. A restored version comes back with
  the tags that still pointed to it.
- A deleted package's name stays taken: nobody can publish a package of
  that name in the workspace. A deleted version's version (for a container
  image, its digest) cannot be published again.
- Its files are kept, and do not count toward the workspace's storage.

After 30 days it is purged for good, and files nothing else uses are
removed a day later. Composer versions follow their repository's tags and
branches, so they are deleted there, not here.

Deleting through a registry's own protocol (`docker` and the OCI `DELETE`,
`npm unpublish`) works the same way.

## Tokens

Sign in to a registry with your username and an
[access token](/guides/authentication/#access-tokens) as the password.
A token with scopes needs the package ones:

| Scope | Lets a token |
| --- | --- |
| `packages:read` | Pull private packages. Public ones need no scope. |
| `packages:write` | Push and publish. Includes `packages:read`. |
| `packages:delete` | Delete and restore versions and packages |

Tokens with full access, and tokens made before scopes, have all three.
Changing a package's settings needs `packages:write` and the Admin role on
it. A token never does more than its owner could: `packages:delete` alone
does not let a member delete an owner's package.

| Token | Reaches |
| --- | --- |
| A personal access token for all your workspaces | What its owner may do, limited by its permissions. |
| A personal access token for one workspace | Packages linked to a repository in its selection, and the unlinked packages of its workspace. Elsewhere it pulls public packages only. |
| A workspace's own token | The workspace's packages, as a member with Write; with Admin when it has Repositories: admin. With selected repositories, linked packages of those only. |
| A workflow job's `G1T_TOKEN` | Its own repository's packages, and those that list its repository under [Manage Actions access](#manage-actions-access), as the job's `permissions:` allow. |
| A deploy key | No packages. |

In [workflows](/guides/actions/#the-jobs-token), `G1T_TOKEN` is the job's
own token: it pushes and pulls its repository's packages with no setup, and
any other package once its admins add the repository under Manage Actions
access. A g1t agent at work on a repository may push the packages of that
repository, as it may push its code, and never deletes them or changes their
settings.

## Storage

Every file is kept once, by its content: two images that share a layer
store it once, and a layer pushed again is not stored again. A workspace's
storage counts each file once, as public when any public package uses it.

Files no version uses any more are deleted a day after the last version
that used them goes.

Without the [g1t plan](/guides/usage-and-billing/#the-g1t-plan), public
packages may hold 10 GB and private ones 500 MB per workspace; a push past
either is refused, with a message saying how much is used. On the plan,
nothing is refused and storage past those amounts is charged instead:

- What the workspace's packages hold is measured each day, public and
  private apart, each past its own free amount.
- A month's GB-months are those days added up, divided by 30, charged at
  $0.018 a GB-month as **Package storage** on the
  [bill](/guides/usage-and-billing/).
- Deleted packages and versions, kept for 30 days, do not count.
- Downloads and pulls cost nothing. Anonymous pulls are rate limited; see
  [storage and pull limits](/guides/containers/#storage-and-pull-limits).

## Downloads

Each package's page shows its pulls or downloads, and each version's own,
counted approximately: an image's manifest fetched by tag or digest, an npm
tarball, a crate, a Maven artifact (not its POM or signatures), a NuGet
`.nupkg`, a gem, and a Composer zip.

A package's files are its publisher's, so the registries never let a
browser run them. Every registry answer carries
`X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; sandbox`, and a file a
browser would open as a page, such as a POM, a `.nuspec` or anything else
in XML, HTML or SVG, comes with `Content-Disposition: attachment`, so it
downloads instead. Package managers ignore these headers.

## The API

The [REST API](/reference/api/) and the `package` tool of the
[MCP server](/reference/mcp/) manage packages. A package is named by its
type (`container`, `npm`, `cargo`, `maven`, `nuget`, `rubygems` or
`composer`) and its name, URL-encoded where it holds a slash
(`web%2Fworker`):

| Route | Operation | Scope |
| --- | --- | --- |
| `GET /workspaces/{workspace}/packages` | `list_packages` (`state=deleted` for deleted ones) | `packages:read` |
| `GET /workspaces/{workspace}/packages/{package_type}/{package_name}` | `get_package` | `packages:read` |
| `PATCH …/{package_name}` | `update_package`: `visibility`, `inherit_access` | `packages:write` |
| `DELETE …/{package_name}` | `delete_package` | `packages:delete` |
| `POST …/{package_name}/restore` | `restore_package` | `packages:delete` |
| `GET …/{package_name}/versions` | `list_package_versions` (`state=deleted` for deleted ones) | `packages:read` |
| `GET …/versions/{version_id}` | `get_package_version` | `packages:read` |
| `DELETE …/versions/{version_id}` | `delete_package_version` | `packages:delete` |
| `POST …/versions/{version_id}/restore` | `restore_package_version` | `packages:delete` |
| `PUT …/{package_name}/repository` | `link_package` | `packages:write` |
| `DELETE …/{package_name}/repository` | `unlink_package` | `packages:write` |
| `GET …/{package_name}/access` | `list_package_access` | `packages:read` |
| `PUT …/{package_name}/access` | `set_package_access`: `username` or `team`, and `role` | `packages:write` |
| `DELETE …/{package_name}/access?username=…` or `?team=…` | `remove_package_access` | `packages:write` |
| `GET …/{package_name}/actions-access` | `list_package_actions_access` | `packages:read` |
| `PUT …/{package_name}/actions-access` | `set_package_actions_access`: `repository` and `role` | `packages:write` |
| `DELETE …/{package_name}/actions-access/{repository}` | `remove_package_actions_access` | `packages:write` |

`version_id` is a version's id (`ver_…`), its version, its digest, or a tag
that points to it. Reading access and deleted versions, and every change,
also needs the Admin role on the package. Bodies and answers are
snake_case.

## Events and the audit log

Publishing a version, deleting a version and deleting a package are
[audit log](/guides/audit-log/) entries (so are deprecating an npm version,
yanking or unyanking a crate version, unlisting or listing a NuGet version,
pushing a NuGet version's symbols and yanking a gem version), as are
restoring them, purging them after 30 days, every change to who has access
and to Manage Actions access, changing the visibility, and linking and
unlinking (see the [audit log's list](/guides/audit-log/)).

[Webhooks](/guides/webhooks/) can subscribe to these events. A linked
package's go to its repository's webhooks and its workspace's; an
unlinked package's go to its workspace's webhooks.

| Event | Sent when |
| --- | --- |
| `package.published` | A version is published. `data.tags` names the tags that now point to it. |
| `package.version_deleted` | A version is deleted. |
| `package.deleted` | A package is deleted. |
| `package.visibility_changed` | A package is made public or private. `data.visibility` is the new one. |

Each one's `data` has `package_id`, `workspace`, `ecosystem`, `name` and
`repo_id` (null for an unlinked package); a version's event also has its
`version` and `digest` (for a container image, the manifest's), and
`package.published` its `size`, except for a Composer package.

## Not supported yet

- PyPI packages.
- Installing unscoped npm packages, or other scopes, through g1t.sh, and
  a copy of Packagist for Composer: those still come from their public
  registries.
- A Go module proxy: Go modules are fetched with git.
- Workflows that run when a package is published.
- Packages in site-wide search.
