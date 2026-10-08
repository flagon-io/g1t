---
title: Go modules
description: go get a workspace's Go modules straight from its repositories on g1t.sh, public and private.
---

A repository on g1t.sh is a Go module at its own address. `go get` finds
its code from the address, and fetches it with git:

```sh
go get g1t.sh/acme/tools
go get g1t.sh/acme/tools/cmd/lint@v1.4.0
```

The repository's `go.mod` names the module:

```text
module g1t.sh/acme/tools
```

Versions are its tags (`v1.4.0`); a pseudo-version names any other commit.
Packages in subdirectories are imported by their path, as above.

## Public modules

Public repositories need nothing: `go get` works as is, and the public Go
module proxy and checksum database serve them like any other public module.

## Private modules

Tell Go which modules are private, so it fetches them from g1t.sh directly
and does not ask the public proxy or checksum database about them:

```sh
go env -w GOPRIVATE=g1t.sh/acme
```

Then give git credentials for g1t.sh: your username and an
[access token](https://g1t.sh/settings/tokens) (full access, or with
`code:read`) in `~/.netrc` (`_netrc` on Windows):

```text
machine g1t.sh
login <you>
password <token>
```

or with a git credential helper, as for any clone (see
[Git](/guides/git/#authentication)). Reading a private module needs the
Read role on its repository.

Keep `GOINSECURE` and `GOFLAGS=-insecure` unset: g1t.sh is served over
HTTPS, and neither is ever needed.

## In workflows

A job's own `G1T_TOKEN` reaches [its repository only](/guides/actions/#the-jobs-token).
To fetch private modules from the workspace's other repositories, keep an
[access token](/guides/authentication/) with `code:read` as a secret, and
use it in place of `G1T_TOKEN` below.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      GOPRIVATE: g1t.sh/acme
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: stable
      - run: git config --global url."https://g1t:${G1T_TOKEN}@g1t.sh/".insteadOf "https://g1t.sh/"
        env:
          G1T_TOKEN: ${{ secrets.G1T_TOKEN }}
      - run: go build ./...
```

## How it works

Go asks `https://g1t.sh/<workspace>/<repo>?go-get=1` and reads a
`go-import` tag pointing at `https://g1t.sh/<workspace>/<repo>.git`. Every
repository address answers, private ones included, and the answer names
nothing but that address; whether anything can be fetched is up to git and
your credentials.
