# Packages: design

Packages are registries a workspace publishes to and installs from, beside its code: container
images, npm, Composer, Cargo and Go first, then Maven, NuGet and RubyGems. They live where the
code does, take the same people and tokens, and are built and published by g1t Actions and
agents without a second account anywhere.

This is the design every phase builds to. Each ecosystem's own guide (apps/docs) says how to use
it; this says how it works.

## Status

What is built, as of 2026-10-07. Each protocol section below marks the same. "Checked" says what was run
on that day against `wrangler dev` (`services/packages/dev/`) with the tool itself, beyond unit tests.

| Registry | Built | Not built |
| --- | --- | --- |
| Containers | Pull, push (chunked, multipart, monolithic, cross-repository mount), deletes, referrers, token exchange, anonymous pull limits; `g1t push` for layers over the request limit. | |
| npm | Scoped publish and install, abbreviated packuments, dist-tags, deprecate, unpublish (72 hours, or Admin), `whoami`. | Proxying unscoped packages and other scopes from the public registry. |
| Composer | Packages from the workspace's repositories: tags and branches as versions, dist zips made and kept by commit, backfill. | A Packagist mirror. |
| Cargo | Sparse index, `config.json` with `auth-required`, publish, yank and unyank, search; owners are not kept (`cargo owner` answers why). Checked with `cargo`, including a workflow-like publish and build with only environment variables. | |
| Go | `go get` from git: `?go-get=1` answers with `go-import`. | The module proxy at `/-/go/`. |
| Maven | Standard layout, releases and SNAPSHOTs, checksums (MD5, SHA-1, SHA-256, SHA-512), generated `maven-metadata.xml` per artifact, SNAPSHOT and plugin group (`mvn <prefix>:<goal>`), Gradle Module Metadata. Checked with `mvn deploy`, `mvn <prefix>:<goal>`, and Gradle `publish` and resolution (releases, SNAPSHOTs, `--refresh-dependencies`). | |
| NuGet | v3 feed: push, flat container, registration, search, unlist and relist, symbol packages (`.snupkg`) and a symbol server, per-version download counts. Checked with `dotnet nuget push`, `dotnet restore` and `dotnet-symbol`. | |
| RubyGems | `gem push`, `gem yank`, the compact index (Bundler), the full index (`specs.4.8.gz`, `latest_`, `prerelease_`, `quick/Marshal.4.8`). Checked with `gem push`, `gem install --source`, `gem search` and `gem specification --remote`. | |
| PyPI | | Everything. |

Across registries: events, webhooks, the audit log, the billing meter and free limits, the
Packages pages and a project's packages are built. Workflows triggered by `registry_package`,
packages in site-wide search, and packages in the activity feed are not.

## Principles

- **One service.** `services/packages` (Rust Worker) owns every registry: its own D1 database
  (`g1t-packages`), its own file store, its own contract in `crates/contracts` /
  `packages/contracts`. Other services talk to it over RPC and hear from it through events.
- **Cloudflare in production, anything in a self-hosted install.** Files go through a
  `BlobStore` port. In production its adapter is R2; self-hosted it is S3-compatible storage
  (RustFS in the compose file) or a local directory. Upload URLs (`presign`) are part of the port:
  R2 and S3 sign them, the disk adapter answers with a path back through the service.
  Metadata is D1, which self-hosting already runs (workerd's D1 over SQLite).
- **Content-addressed.** Every file is stored once by its SHA-256 (`blobs/sha256/<hex>`). A
  version is a list of files by digest. Pushing a layer two images share stores it once.
- **The registry speaks each tool's own protocol**, unchanged. `docker`, `npm`, `composer`,
  `cargo`, `go`, `mvn` and Gradle, `dotnet` and `gem` and Bundler work with only a login and an
  address.
- **Same access as the code.** A package can be linked to a repository and then has its
  visibility and roles. Unlinked, it is the workspace's: members by the base permission.
- **Same front door.** Everything is on `g1t.sh`. `apps/web/workers/app.ts` hands registry paths
  to the `PACKAGES` binding the way it hands git paths to repos.

## Model

| Table | What it holds |
| --- | --- |
| `packages` | `id`, `workspace`, `ecosystem` (`container`, `npm`, `composer`, `cargo`, `go`, `maven`, `nuget`, `rubygems`), `name` (normalized per ecosystem), `repo_id` (linked repository, or null), `visibility` (`public`, `private`; linked packages follow their repository), `description`, `readme_digest`, `created_by`, `created_at`, `updated_at`, `downloads` |
| `versions` | `id`, `package_id`, `version` (tag, semver or digest), `digest` (the manifest's or the archive's), `size` (sum of its files), `metadata` (JSON the ecosystem needs: npm's packument entry, a crate's index line, composer.json), `published_by`, `published_at`, `yanked`, `deprecated` |
| `version_files` | `version_id`, `name`, `digest`, `size`, `media_type` |
| `blobs` | `digest`, `size`, `media_type`, `created_at` |
| `workspace_blobs` | `workspace`, `digest`, `public` (any public package uses it): what a workspace stores, counted once each, for billing |
| `uploads` | `id`, `workspace`, `package`, `multipart_id`, `parts` (JSON), `offset`, `hash_state`, `expires_at`: uploads in progress |
| `tags` | `package_id`, `tag`, `version_id`: container tags and npm dist-tags |
| `checksums` | `digest`, `md5`, `sha1`, `sha512`: a file's other checksums, worked out on upload (Maven asks for them) |

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

Built.

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

Built, except the proxy of unscoped packages.

- Registry `https://g1t.sh/-/npm/`; scope = workspace: `@<workspace>/<name>`.
  `.npmrc`: `@acme:registry=https://g1t.sh/-/npm/` and `//g1t.sh/-/npm/:_authToken=<token>`.
- `GET /@scope/name` (packument, abbreviated with `Accept: application/vnd.npm.install-v1+json`),
  `GET` tarballs, `PUT /@scope/name` (publish: JSON with the tarball attached), dist-tags,
  deprecate, unpublish (within 72 hours or with Admin), `GET /-/whoami`.
- Unscoped and other scopes: optionally proxied from the public registry and kept, so one
  `.npmrc` line serves everything (later phase; not built).

### Composer

Built, except the Packagist mirror.

- Per workspace: `https://g1t.sh/-/composer/<workspace>/` with `packages.json` naming
  `metadata-url` `/p2/%package%.json` and `available-packages`.
- Versions come from **the workspace's repositories themselves**: a repository with a
  `composer.json` at its root is a package (its `name` from that file); each tag is a version and
  each branch a `dev-` version. Dist archives are zips of the commit, made on first request and
  kept by commit. Pushing a tag publishes; nothing to upload.
- Auth: `composer config --auth http-basic.g1t.sh <you> <token>` (`auth.json`).
- A mirror of the public Packagist (metadata and dists kept, so installs survive its outages) is
  a later phase (not built).

### Cargo

Built.

- Sparse registry per workspace: `sparse+https://g1t.sh/-/cargo/<workspace>/index/`. `config.json`
  (`dl`, `api`, `auth-required` for private), index files at the standard prefix paths, crate
  downloads, `PUT /api/v1/crates/new` (publish), yank and unyank, search. Owners are not kept:
  who publishes is decided by the repository's or workspace's roles, and `cargo owner` answers
  with an error saying so.
- Auth: a g1t token, given to the registry's credential provider (`cargo:token`), named in
  `.cargo/config.toml` as `[registries.<workspace>]`: `cargo login --registry <workspace>`, or
  in workflows `CARGO_REGISTRIES_<WORKSPACE>_TOKEN` (with `CARGO_REGISTRIES_<WORKSPACE>_INDEX`
  and `CARGO_REGISTRIES_<WORKSPACE>_CREDENTIAL_PROVIDER=cargo:token` when no config names the
  registry). Without a provider Cargo refuses a registry with private crates.

### Go

Built from git; the module proxy is not built.

- `go get g1t.sh/<workspace>/<repo>` works from git: repository pages answer `?go-get=1` with the
  `go-import` meta tag. Private modules need `GOPRIVATE=g1t.sh/<workspace>` and a token in
  `.netrc` (as for git).
- A module proxy at `https://g1t.sh/-/go/` (`@v/list`, `.info`, `.mod`, `.zip`) built from tags,
  for faster and repeatable private installs (later phase; not built).

### Maven

Built, for Maven and Gradle.

- Per workspace: `https://g1t.sh/-/maven/<workspace>/`, the standard layout
  (`com/acme/web/1.0.0/web-1.0.0.jar`). A package is an artifact, named
  `groupId:artifactId`; a version holds every file uploaded into its
  directory, by file name (`version_files`), added one `PUT` at a time.
- `mvn deploy` and Gradle's `publish`: Basic auth (any username, a token as
  the password) or `Bearer`. A release's files are written once (`409` for
  other content, the same content again is accepted); a SNAPSHOT's builds
  arrive as timestamped files beside each other.
- Checksums: each file's MD5, SHA-1 and SHA-512 are worked out on upload
  and kept by digest (`checksums`); `.md5`, `.sha1`, `.sha256`, `.sha512`
  are answered from them, and uploaded ones are checked, not kept.
- `maven-metadata.xml` is made on every read: per artifact (versions in
  Maven's order, `latest`, `release`), per SNAPSHOT version (the newest
  build of each classifier and extension), and per group (`<plugins>`: each
  `maven-plugin` artifact's prefix, artifactId and name, which is how
  `mvn <prefix>:<goal>` finds a plugin in its `<pluginGroups>`). The prefix
  is the `goalPrefix` of the jar's `META-INF/maven/plugin.xml`, read when
  the jar arrives, else Maven's from the artifactId. A path that is both an
  artifact's and a group's answers both. Uploaded ones are accepted and let
  go, a plugin group's included.
- Gradle: its `.module` files are kept and served like any other file, and
  its `HEAD` requests and SHA-256 and SHA-512 checksum uploads are
  answered as Maven's are.
- The POM is the version's record: its coordinates must
  match its path, its description becomes the package's for the highest
  release, and on a new artifact its `<scm><url>` may link the repository.
- The artifact's own `maven-metadata.xml`, uploaded last by Maven and Gradle,
  publishes (event, audit entry) each version or SNAPSHOT build whose POM
  arrived since, marked in its metadata so it is published once.

### NuGet

Built.

- Per workspace: `https://g1t.sh/-/nuget/<workspace>/v3/index.json` naming
  `PackageBaseAddress/3.0.0` (flat container), `RegistrationsBaseUrl`
  (one inlined page), `SearchQueryService`, `PackagePublish/2.0.0` and
  `SymbolPackagePublish/4.9.0`.
- `dotnet nuget push`: a `PUT` of a multipart body with the `.nupkg`,
  `X-NuGet-ApiKey` a g1t token. The `.nuspec` (read from the zip) gives the
  id, version (normalized as NuGet does), description, dependency groups and
  README; the `.nupkg` and `.nuspec` are the version's files.
- Ids are one whatever their case; a version is pushed once (`409`).
- `DELETE api/v2/package/<id>/<version>` unlists (the `yanked` column), as
  nuget.org does; `POST` lists again. Unlisted versions stay in the flat
  container and registration (`listed: false`), not in search.
- Restores use Basic auth from `nuget.config`, after a `401`.
- Downloads: each `.nupkg` download counts for its version (`versions.downloads`) and its
  package; the registration's catalog entries and search's versions name them.
- Symbols: `dotnet nuget push` sends the `.snupkg` beside a `.nupkg` to
  `api/v2/symbolpackage` after it. It must be for a version already pushed, say
  `SymbolsPackage` as its package type, and hold portable PDBs. The `.snupkg` is the version's
  file `snupkg` (also in the flat container), and each PDB its file `pdb:<file>:<key>`, the key
  being the PDB id's GUID (as `Guid.ToString("N")`) and `ffffffff`. The symbol server,
  `symbols/<file>.pdb/<key>/<file>.pdb` (the Simple Symbol Query Protocol), finds it by that
  name across the workspace's packages the viewer may read (`version_files_name` index). A
  version's symbols are pushed once (`409`). The package page marks versions with symbols.

### RubyGems

Built.

- Per workspace: `https://g1t.sh/-/rubygems/<workspace>/`. `gem push`
  (`POST /api/v1/gems`, the token as the whole `Authorization` header),
  `gem yank` (`DELETE /api/v1/gems/yank`), downloads at
  `/gems/<name>-<version>[-<platform>].gem`.
- The compact index Bundler reads: `versions`, `info/<gem>`, `names`, made
  on every read, each with the quoted MD5 of its body as its `ETag` (Bundler
  checks it, and `versions` names each info file's MD5). Yanked versions
  leave the index; their files stay.
- The gem's `metadata.gz` (YAML, in the `.gem` tar) gives the name,
  version, platform and runtime dependencies. A version is keyed as the
  index writes it (`1.0.0`, `1.0.0-x86_64-linux`) and pushed once.
- The full index `gem install --source` and `gem search` read:
  `specs.4.8.gz` (released versions), `latest_specs.4.8.gz` (the highest of
  each gem and platform) and `prerelease_specs.4.8.gz`, each a gzipped
  Ruby Marshal 4.8 array of `[name, Gem::Version, platform]`, and
  `quick/Marshal.4.8/<name>-<version>[-<platform>].gemspec.rz`, the
  deflated Marshal of a `Gem::Specification` as its `_dump` writes it. All
  are made on each read from what each version keeps (`src/marshal.rs` is
  the writer), and read by RubyGems' `SafeMarshal`.
- Bundler authenticates with Basic auth from `bundle config`; `gem` with
  credentials in the source's address.

### Later

PyPI (not built).

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
5. **Maven, NuGet, RubyGems.**
6. **Mirrors** (Packagist, npm).

Phases 1 to 5 are built (see [Status](#status)); 6 is not.
