# Packages: design

Packages are registries a workspace publishes to and installs from, beside its code: container
images, npm, Composer, Cargo and Go first, then Maven, NuGet and RubyGems. They live where the
code does, take the same people and tokens, and are built and published by g1t Actions and
agents without a second account anywhere.

This is the design every phase builds to. Each ecosystem's own guide (apps/docs) says how to use
it; this says how it works.

## Principles

- **One service.** `services/packages` (Rust Worker) owns every registry: its own D1 database
  (`g1t-packages`), its own file store, its own contract in `crates/contracts` /
  `packages/contracts`. Other services talk to it over RPC and hear from it through events.
- **Cloudflare in production, anything in a self-hosted install.** Files go through a
  `BlobStore` port. In production its adapter is R2; self-hosted it is S3-compatible storage
  (MinIO in the compose file) or a local directory. Upload URLs (`presign`) are part of the port:
  R2 and S3 sign them, the disk adapter answers with a path back through the service.
  Metadata is D1, which self-hosting already runs (workerd's D1 over SQLite).
- **Content-addressed.** Every file is stored once by its SHA-256 (`blobs/sha256/<hex>`). A
  version is a list of files by digest. Pushing a layer two images share stores it once.
- **The registry speaks each tool's own protocol**, unchanged. `docker`, `npm`, `composer`,
  `cargo` and `go` work with only a login and an address.
- **Same access as the code.** A package can be linked to a repository and then has its
  visibility and roles. Unlinked, it is the workspace's: members by the base permission.
- **Same front door.** Everything is on `g1t.sh`. `apps/web/workers/app.ts` hands registry paths
  to the `PACKAGES` binding the way it hands git paths to repos.

## Model

| Table | What it holds |
| --- | --- |
| `packages` | `id`, `workspace`, `ecosystem` (`container`, `npm`, `composer`, `cargo`, `go`, ...), `name` (normalized per ecosystem), `repo_id` (linked repository, or null), `visibility` (`public`, `private`; linked packages follow their repository), `description`, `readme_digest`, `created_by`, `created_at`, `updated_at`, `downloads` |
| `versions` | `id`, `package_id`, `version` (tag, semver or digest), `digest` (the manifest's or the archive's), `size` (sum of its files), `metadata` (JSON the ecosystem needs: npm's packument entry, a crate's index line, composer.json), `published_by`, `published_at`, `yanked`, `deprecated` |
| `version_files` | `version_id`, `name`, `digest`, `size`, `media_type` |
| `blobs` | `digest`, `size`, `media_type`, `created_at` |
| `workspace_blobs` | `workspace`, `digest`, `public` (any public package uses it): what a workspace stores, counted once each, for billing |
| `uploads` | `id`, `workspace`, `package`, `multipart_id`, `parts` (JSON), `offset`, `hash_state`, `expires_at`: uploads in progress |
| `tags` | `package_id`, `tag`, `version_id`: container tags and npm dist-tags |

Deleting a version removes its rows; a daily sweep deletes blobs no version references, after a
day's grace (a push in flight may reference a blob before its manifest lands).

## Access

- **Who:** people (session or personal token), workspace tokens, `G1T_TOKEN` in workflows,
  agents' run tokens. Scopes `packages:read` and `packages:write` (and `packages:delete`), per the
  MCP and token scope design.
- **What:** linked package: the repository's roles (Read pulls, Write publishes, Admin deletes and
  changes settings). Unlinked: workspace members by base permission; owners delete.
- **Public packages** pull anonymously. Anonymous pulls are rate limited per address.
- **Workflows** may publish the packages of their own repository, and new ones linked to it, with
  `G1T_TOKEN`, as code they push does.
- Every publish and delete is an audit entry and an event.

## Protocols

All under `g1t.sh`. A name always starts with the workspace.

### Containers (OCI Distribution 1.1)

- Image names: `g1t.sh/<workspace>/<name>[:tag]`, `<name>` may contain `/`. Usually the
  repository's name, and then linked to it.
- `GET /v2/` answers 401 with `WWW-Authenticate: Bearer realm="https://g1t.sh/v2/token",
  service="g1t.sh"`. `GET /v2/token` takes Basic auth (any username, a g1t token as the
  password) or none (anonymous, public pulls) and returns a short-lived signed token naming the
  scopes granted. `docker login g1t.sh -u <you> --password-stdin` stores it.
- Pull: `HEAD/GET /v2/<name>/manifests/<ref>`, `HEAD/GET /v2/<name>/blobs/<digest>` (a
  redirect to a signed R2 URL for large blobs, so downloads never pass through the Worker),
  `GET /v2/<name>/tags/list`, `GET /v2/<name>/referrers/<digest>`.
- Push: `POST /v2/<name>/blobs/uploads/` (`?mount=&from=` cross-repository mount within a
  workspace; `?digest=` monolithic), `PATCH` chunks, `PUT ?digest=` to finish,
  `PUT /v2/<name>/manifests/<ref>` (image manifests, indexes, OCI artifacts, `subject` for
  referrers). `DELETE` manifests and blobs.
- **Upload size.** On Cloudflare a request body is limited by the zone's plan (Free: 100 MB).
  Uploads are written to R2 as multipart parts, so a layer may be any size if it arrives in
  chunks under the limit. `docker push` sends a layer in one request, so on Cloudflare a layer
  over the limit is refused with a message naming the limit and the way around it: `g1t push`
  (the CLI, `crates/g1t`), which reads the image with `docker save` (OCI layout or classic,
  gzipping uncompressed layers and writing a matching manifest) and sends every blob as OCI
  chunks of 90 MiB (at most 95 MiB), resuming from the upload's `Range` after a `429`/`5xx`.
  Self-hosted, there is no such limit.

### npm

- Registry `https://g1t.sh/-/npm/`; scope = workspace: `@<workspace>/<name>`.
  `.npmrc`: `@acme:registry=https://g1t.sh/-/npm/` and `//g1t.sh/-/npm/:_authToken=<token>`.
- `GET /@scope/name` (packument, abbreviated with `Accept: application/vnd.npm.install-v1+json`),
  `GET` tarballs, `PUT /@scope/name` (publish: JSON with the tarball attached), dist-tags,
  deprecate, unpublish (within 72 hours or with Admin), `GET /-/whoami`.
- Unscoped and other scopes: optionally proxied from the public registry and kept, so one
  `.npmrc` line serves everything (later phase).

### Composer

- Per workspace: `https://g1t.sh/-/composer/<workspace>/` with `packages.json` naming
  `metadata-url` `/p2/%package%.json` and `available-packages`.
- Versions come from **the workspace's repositories themselves**: a repository with a
  `composer.json` at its root is a package (its `name` from that file); each tag is a version and
  each branch a `dev-` version. Dist archives are zips of the commit, made on first request and
  kept by commit. Pushing a tag publishes; nothing to upload.
- Auth: `composer config --auth http-basic.g1t.sh <you> <token>` (`auth.json`).
- A mirror of the public Packagist (metadata and dists kept, so installs survive its outages) is
  a later phase.

### Cargo

- Sparse registry per workspace: `sparse+https://g1t.sh/-/cargo/<workspace>/`. `config.json`
  (`dl`, `api`, `auth-required` for private), index files at the standard prefix paths, crate
  downloads, `PUT /api/v1/crates/new` (publish), yank and unyank, owners.
- Auth: a g1t token through `cargo login --registry g1t`.

### Go

- `go get g1t.sh/<workspace>/<repo>` works from git: repository pages answer `?go-get=1` with the
  `go-import` meta tag. Private modules need `GOPRIVATE=g1t.sh/<workspace>` and a token in
  `.netrc` (as for git).
- A module proxy at `https://g1t.sh/-/go/` (`@v/list`, `.info`, `.mod`, `.zip`) built from tags,
  for faster and repeatable private installs (later phase).

### Later

Maven (`/-/maven/<workspace>/`), NuGet (v3), RubyGems; PyPI.

## Billing

Storage is what costs: R2 is about $0.015 per GB-month, with no charge for downloads (no egress
fees) and fractions of a cent per thousand requests. Defaults, all `services/billing` variables:

| | Free workspace | g1t plan |
| --- | --- | --- |
| Public packages | Free up to `PUBLIC_PACKAGES_FREE_BYTES` (10 GB) per workspace; pushes past it are refused | The same 10 GB free, then storage at cost plus the margin |
| Private packages | `PRIVATE_PACKAGES_FREE_BYTES` (500 MB) free; pushes past it are refused | Storage at cost plus the margin from the first byte past 500 MB |
| Downloads | Free; anonymous pulls rate limited | Free |

- A workspace's package storage is measured daily from `workspace_blobs` (a blob counts once per
  workspace, and as public when any public package uses it), on the same meter run as private
  repository storage, and charged as `package_storage` GB-months.
- Pushes check the free limits before accepting a blob, with a message naming the limit.

## Events

`package.published`, `package.version_deleted`, `package.deleted`, `package.visibility_changed`.
Webhooks deliver them (`package` and `registry_package` shapes); workflows can run on
`registry_package`; the activity feed and search index them; the audit log records them.

## UI

- Workspace **Packages** (`/<workspace>/-/packages`): every package, by ecosystem, with search.
- A project's packages on its overview, and a Packages tab when it has any.
- Package page: install and log-in commands for its tool, versions and tags, README, size,
  downloads, linked repository, who published; settings (visibility, link, delete) for Admins.
- Site-wide search finds public packages.

## Build order

1. **Core and containers.** The service, file store port (R2, S3, disk), access, token exchange,
   OCI pull and push (chunked and multipart, mounts, deletes, referrers), the sweep, events,
   billing meter and limits, Packages pages, docs. Then the runner's image moves here from Docker
   Hub, and `g1t push` for large layers.
2. **npm.**
3. **Composer and Go** (both from the repositories themselves).
4. **Cargo.**
5. **Mirrors** (Packagist, npm), **Maven, NuGet, RubyGems.**
