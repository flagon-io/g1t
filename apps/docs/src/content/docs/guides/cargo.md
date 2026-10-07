---
title: Cargo
description: Publish and add a workspace's Rust crates with Cargo, from a sparse registry of its own on g1t.sh, from your machine and from workflows.
---

Every workspace has a Cargo registry of its own: a sparse index, with the
web API that `cargo publish`, `cargo yank` and `cargo search` use. It
works with Cargo 1.74 or later, private crates included.

```text
sparse+https://g1t.sh/-/cargo/<workspace>/index/
```

Crates from crates.io still come from crates.io; only the crates you name
with the workspace's registry come from g1t.

## Set up `.cargo/config.toml`

Name the registry in the project's `.cargo/config.toml`, or in
`~/.cargo/config.toml` for every project. The name you give it is the one
you pass to `--registry`; these pages use the workspace's slug:

```toml
[registries.acme]
index = "sparse+https://g1t.sh/-/cargo/acme/index/"
credential-provider = "cargo:token"
```

Cargo sends a token to a registry that asks for one only through a
credential provider named for it. `cargo:token` keeps the token in
`~/.cargo/credentials.toml`, which stays out of the project. To keep it in
your system's keychain instead, name `cargo:wincred` (Windows),
`cargo:macos-keychain` (macOS) or `cargo:libsecret` (Linux).

Then give Cargo an [access token](https://g1t.sh/settings/tokens):

```sh
cargo login --registry acme
```

Cargo asks for the token and hands it to the provider. A token with full
access works; one with scopes needs `packages:read` to add private crates
and `packages:write` to publish and yank them.

The token can also come from the environment instead of `cargo login`,
as `CARGO_REGISTRIES_ACME_TOKEN` for a registry named `acme` (the name in
capitals, with `-` written `_`). The `cargo:token` provider reads it from
there, which is how [workflows](#in-workflows) give it.

## Publish

Say in `Cargo.toml` where the crate is published and which repository it
comes from:

```toml
[package]
name = "http-client"
version = "0.3.1"
edition = "2021"
description = "Our HTTP client"
license = "MIT"
readme = "README.md"
repository = "https://g1t.sh/acme/http-client"
publish = ["acme"]
```

```sh
cargo publish --registry acme
```

The first publish makes the crate. When its `repository` is a g1t.sh
repository of the same workspace, or a repository is named like the crate
(a crate `http_client` is also matched to a repository `http-client`), it
is linked to that repository and has its visibility and roles: publishing needs Write on it.
Otherwise it is the workspace's, private, and needs the workspace's Write
base permission. See
[who can see and publish a package](/guides/packages/#who-can-see-and-publish-a-package).

`publish = ["acme"]` keeps the crate from being published to crates.io by
mistake, and lets `cargo publish` leave out `--registry` when it is the
only registry named.

A crate may depend on crates.io crates and on other crates of the
workspace's registry. The crate's page on g1t.sh shows the README and
description of its highest stable version.

## Add a crate

```sh
cargo add http-client --registry acme
```

That writes the dependency with its registry into `Cargo.toml`:

```toml
[dependencies]
http-client = { version = "0.3.1", registry = "acme" }
```

`Cargo.lock` records each crate's registry and the SHA-256 of its
`.crate` file, which g1t computes when the version is published.

`cargo search --registry acme http` lists the workspace's crates you can
see whose names match.

## Names and versions

A crate's name follows the crates.io rules: ASCII letters, digits, `-` and
`_`, starting with a letter, at most 64 characters. In a workspace, names
that differ only in case or in `-` against `_` are one name: once
`http-client` is published, `HTTP_Client` is refused.

A version is published once. Publishing a version that is already there is
refused, as is one that differs from it only in build metadata (`1.0.0+a`
and `1.0.0+b`), so bump `version` first.

## Yank

```sh
cargo yank --registry acme http-client@0.3.1
cargo yank --registry acme http-client@0.3.1 --undo
```

A yanked version stays in the registry: projects whose `Cargo.lock`
names it still build, but Cargo no longer picks it for new lockfiles or
`cargo update`. Yanking needs what publishing does. The crate's page marks
yanked versions, and someone with Admin on the linked repository (an
owner, for the workspace's own crates) can delete a version there for
good.

Crate owners are not kept: who may publish a crate is decided by its
repository's roles, or the workspace's, so `cargo owner` answers with an
error that says so.

## Private and public crates

A crate linked to a repository has the repository's visibility; one of
the workspace's own is private until an owner makes it public on its page.

| The workspace's crates | Without a token | With a token |
| --- | --- | --- |
| All public | Cargo reads the index and downloads them. | The same; the token is sent to publish and yank. |
| Some private | The registry answers `401`: Cargo needs a token for every crate in it, public ones too. | Cargo sends the token with every request, and sees the crates the token's owner may see. |

Cargo first asks for the registry's `config.json` without a token. When
the registry answers `401`, Cargo asks again with its token, and the
answer says `"auth-required": true`, so Cargo sends the token from then on.
A private crate you cannot see looks exactly like one that does not exist.

## In workflows

A workflow's `G1T_TOKEN` is the workspace's own token for the run, and can
add and publish the workspace's crates. A workflow runs no `cargo login`:
give Cargo the registry, its credential provider and the token in the
environment, each named for the registry:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    env:
      CARGO_REGISTRIES_ACME_INDEX: sparse+https://g1t.sh/-/cargo/acme/index/
      CARGO_REGISTRIES_ACME_CREDENTIAL_PROVIDER: cargo:token
      CARGO_REGISTRIES_ACME_TOKEN: ${{ secrets.G1T_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - run: cargo test
      - run: cargo publish --registry acme
```

| Variable | Is | Needed |
| --- | --- | --- |
| `CARGO_REGISTRIES_ACME_INDEX` | The registry's index, as `index` in `.cargo/config.toml`. | When no `.cargo/config.toml` names the registry. |
| `CARGO_REGISTRIES_ACME_CREDENTIAL_PROVIDER` | `cargo:token`, as `credential-provider` in `.cargo/config.toml`. | When no `.cargo/config.toml` names the provider. Without one, Cargo refuses a registry with private crates, even with the token in the environment. |
| `CARGO_REGISTRIES_ACME_TOKEN` | The token, for `cargo:token` to hand to the registry. | Always: `cargo publish` sends it, and Cargo sends it to read a registry with private crates. |

With the project's `.cargo/config.toml` from [above](#set-up-cargoconfigtoml)
checked in, `CARGO_REGISTRIES_ACME_TOKEN` is all a workflow sets. The same
variables let `cargo build` and `cargo test` download the workspace's
private crates.

## Size

A publish is one request with the `.crate` file inside it, and may hold at
most 100 MB. Without the [g1t plan](/guides/usage-and-billing/#the-g1t-plan),
a workspace's private packages may hold 500 MB and its public ones 10 GB,
as for [container images](/guides/containers/#storage-and-pull-limits).
A `.crate` file is stored once, by its content.

## Errors

| Error | Means |
| --- | --- |
| `401` | No token, or a wrong or expired one. Run `cargo login --registry acme` with a g1t access token, or set `CARGO_REGISTRIES_ACME_TOKEN`. |
| `authenticated registries require a credential-provider to be configured` | The workspace has private crates, and Cargo has no provider for its token. Add `credential-provider = "cargo:token"` to the registry in `.cargo/config.toml`, or set `CARGO_REGISTRIES_ACME_CREDENTIAL_PROVIDER=cargo:token`. |
| `403` | Signed in, but your role or your token's scopes do not allow it, or the workspace is out of free package storage. The message says which. |
| `404` | No such crate or version, or a private one you cannot see. |
| `400` | The publish was refused: a name that is not valid or is taken, a version already published, or metadata Cargo did not send in full. The message says which. |
| `413` | The publish is over 100 MB. Leave large files out with `exclude` or `include` in `Cargo.toml`, and check with `cargo package --list`. |
