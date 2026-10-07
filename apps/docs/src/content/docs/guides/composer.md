---
title: Composer
description: Install a workspace's PHP packages with Composer, straight from its repositories on g1t.sh. Push a tag and it is released.
---

Every workspace has a Composer repository of its own, made from its
repositories: one with a `composer.json` at its root is a package. There
is nothing to upload and nothing to keep in step. Push a tag and Composer
can install it; push to a branch and its `dev-` version follows.

```text
https://g1t.sh/-/composer/<workspace>/
```

## Make a repository a package

Give the repository a `composer.json` at its root with a `name`:

```json
{
  "name": "acme/http-client",
  "description": "Our HTTP client",
  "type": "library",
  "require": { "php": ">=8.1" },
  "autoload": { "psr-4": { "Acme\Http\\": "src/" } }
}
```

Push it to the default branch, and the package appears in the workspace's
**Packages**, linked to the repository, with its README. Any vendor name
works; each name is one package in a workspace.

## Versions

| In git | Version |
| --- | --- |
| A tag that reads as a version: `v1.2.0`, `1.2.0`, `2.0.0-RC1`, `1.0.0-beta.2` | That version (`v1.2.0`) |
| A branch | `dev-<branch>`; a branch named like a version, `1.x`, is `1.x-dev` |
| The default branch | Its `dev-` version, marked as the default branch |

Each version's requirements, autoloading and the rest are read from the
`composer.json` at that tag or branch, so a version installs exactly what
it was tagged with. Tags that do not read as versions, such as `nightly`,
are left out. `extra.branch-alias` in the default branch's `composer.json`
aliases it as usual (`"dev-main": "1.x-dev"`).

To release, tag and push:

```sh
git tag v1.3.0
git push origin v1.3.0
```

Deleting a tag or branch takes its version away.

## Install

Add the workspace's repository to your project, then require the package:

```sh
composer config repositories.acme composer https://g1t.sh/-/composer/acme/
composer require acme/http-client
```

Packages install from a zip of the tag's commit, made the first time
anyone asks for it and kept from then on. Files the repository's
`.gitattributes` marks `export-ignore`, such as tests, are left out of it,
as `git archive` leaves them out. `--prefer-source` clones from g1t.sh
instead.

## Private packages

A package has its repository's visibility and
[roles](/guides/access-and-roles/): Read installs it. For a private one,
give Composer your username and an
[access token](https://g1t.sh/settings/tokens) (one with full access, or
with `packages:read` and `code:read`, so that `--prefer-source` can clone
too):

```sh
composer config --global --auth http-basic.g1t.sh <you> <token>
```

That writes `~/.composer/auth.json`, which stays out of the project. A
`Bearer` token works as well (`bearer.g1t.sh`). Without credentials, a
workspace's repository lists only its public packages.

## In workflows

A workflow's `G1T_TOKEN` can install the workspace's private packages:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: composer config --global --auth http-basic.g1t.sh g1t "$G1T_TOKEN"
        env:
          G1T_TOKEN: ${{ secrets.G1T_TOKEN }}
      - run: composer install --no-interaction
```

## Limits

A zip is made of at most 10,000 files and 64 MB; a larger commit installs
from source (`composer install --prefer-source`). A package lists its
newest 300 version tags and 50 branches. Zips count toward the workspace's
package storage, as other packages do (see
[storage and pull limits](/guides/containers/#storage-and-pull-limits)).
