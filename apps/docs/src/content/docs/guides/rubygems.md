---
title: RubyGems
description: Push a workspace's Ruby gems with gem push and install them with Bundler, from a gem registry of its own on g1t.sh, from your machine and from workflows.
---

Every workspace has a gem registry of its own. `gem push` publishes to it,
and Bundler and `gem install` install from it, private gems included.
It serves both indexes RubyGems reads: the compact index Bundler uses
(`versions`, `info/<gem>`), and the full index (`specs.4.8.gz` and each
version's specification) that `gem install --source` and `gem search`
read.

```text
https://g1t.sh/-/rubygems/<workspace>/
```

Gems from rubygems.org still come from rubygems.org; only the gems you
name with the workspace's source come from g1t.

## Push

Say in the gemspec which repository the gem comes from:

```ruby
Gem::Specification.new do |spec|
  spec.name     = "http-client"
  spec.version  = "0.3.1"
  spec.summary  = "Our HTTP client"
  spec.authors  = ["Ada"]
  spec.files    = Dir["lib/**/*.rb"]
  spec.homepage = "https://g1t.sh/acme/http-client"
  spec.metadata["source_code_uri"] = "https://g1t.sh/acme/http-client"
  spec.metadata["allowed_push_host"] = "https://g1t.sh/-/rubygems/acme"
end
```

Build it and push it with an [access token](https://g1t.sh/settings/tokens)
as the API key:

```sh
gem build http-client.gemspec
GEM_HOST_API_KEY=<token> gem push http-client-0.3.1.gem --host https://g1t.sh/-/rubygems/acme
```

To keep the key instead of passing it each time, add it to
`~/.gem/credentials`, under the registry's address:

```yaml
---
:https://g1t.sh/-/rubygems/acme: g1t_...
```

`allowed_push_host` keeps the gem from being pushed to rubygems.org by
mistake. A token with full access works; one with scopes needs
`packages:write` to push and yank, and `packages:read` to install private
gems.

The first push makes the gem. When its `source_code_uri` (or `homepage`)
is a g1t.sh repository of the same workspace, or a repository is named
like the gem (a gem `http_client` is also matched to a repository
`http-client`), it is linked to that repository and has its visibility and
roles: pushing needs Write on it. Otherwise it is the workspace's,
private, and needs the workspace's Write base permission. See
[who can see and publish a package](/guides/packages/#who-can-see-and-publish-a-package).

The gem's page on g1t.sh shows the summary of its highest stable version.

## Install with Bundler

Name the workspace's source for the gems that come from it:

```ruby
source "https://rubygems.org"

source "https://g1t.sh/-/rubygems/acme/" do
  gem "http-client", "~> 0.3"
end
```

or let Bundler write that for you:

```sh
bundle add http-client --source https://g1t.sh/-/rubygems/acme/
```

For private gems, give Bundler a username (any works) and a token, for
the source's address:

```sh
bundle config set --global https://g1t.sh/-/rubygems/acme/ ada:<token>
```

Or set them once for every workspace on g1t.sh, by host:
`bundle config set --global g1t.sh ada:<token>`, which can also come from
the environment as `BUNDLE_G1T__SH`, as [workflows](#in-workflows) give it.

`bundle install` then reads the compact index and downloads each `.gem`,
which it checks against the SHA-256 the index names.

## Install with gem

To install a gem and what it depends on without a `Gemfile`, name the
workspace's source. For private gems, put a username (any works) and a
token in its address:

```sh
gem install http-client --source https://ada:<token>@g1t.sh/-/rubygems/acme/
```

Gems it depends on from rubygems.org need that source too: add
`--source https://rubygems.org/` after the workspace's. To keep the
source, add it once with `gem sources --add <address>`.

`gem search http --remote --source <address>` lists the workspace's gems,
and `gem specification http-client --remote --source <address>` shows one.
`--prerelease` includes pre-releases. Yanked versions are in neither.

## Names and versions

A gem's name is letters, digits, `.`, `-` and `_`, with at least one
letter. In a workspace, names that differ only in case are one name: once
`http-client` is pushed, `HTTP-Client` is refused.

A version is pushed once, for each platform: pushing `0.3.1` again is
refused with `409`, even after it is yanked, so bump `version` first. A
gem built for a platform (`0.3.1-x86_64-linux`) is its own version beside
the `ruby` one. A version with a letter in it (`0.4.0.rc1`) is a
pre-release, which Bundler picks only when asked for.

## Yank

```sh
GEM_HOST_API_KEY=<token> gem yank http-client --version 0.3.1 --host https://g1t.sh/-/rubygems/acme
```

A yanked version leaves both indexes, so Bundler and `gem install` no
longer resolve to it,
but its `.gem` is still downloaded for a `Gemfile.lock` that names it.
Yanking needs what pushing does. The gem's page marks yanked versions, and
someone with Admin on the linked repository (an owner, for the
workspace's own gems) can delete a version there for good.

## Private and public gems

A gem linked to a repository has the repository's visibility; one of the
workspace's own is private until an owner makes it public on its page.

| The workspace's gems | Without credentials | With credentials |
| --- | --- | --- |
| All public | Bundler and `gem` read the index and download them. | The same; the key is sent to push and yank. |
| Some private | The registry answers `401`: Bundler asks for credentials for the source, and `gem` needs them in the source's address. | Each gem the credentials' owner may see. |

A private gem you cannot see looks exactly like one that does not exist.

## In workflows

A workflow's `G1T_TOKEN` is the workspace's own token for the run, and can
install and push the workspace's gems:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    env:
      GEM_HOST_API_KEY: ${{ secrets.G1T_TOKEN }}
      BUNDLE_G1T__SH: g1t:${{ secrets.G1T_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - run: bundle install && bundle exec rake test
      - run: gem build http-client.gemspec
      - run: gem push http-client-*.gem --host https://g1t.sh/-/rubygems/acme
```

## Size

A push is one request with the `.gem` as its body, and may hold at most
100 MB. Without the [g1t plan](/guides/usage-and-billing/#the-g1t-plan), a
workspace's private packages may hold 500 MB and its public ones 10 GB, as
for [container images](/guides/containers/#storage-and-pull-limits). A
`.gem` is stored once, by its content.

## Errors

| Error | Means |
| --- | --- |
| `401` | No credentials or key, or a wrong or expired token. For Bundler, set the source's credentials with `bundle config set`; for `gem install`, put them in the source's address; for `gem push`, give `GEM_HOST_API_KEY`. |
| `403` | Signed in, but your role or your token's scopes do not allow it, or the workspace is out of free package storage. The response says which. |
| `404` | No such gem or version, or a private one you cannot see. |
| `409` | That version is already pushed, or its name is taken by a gem named in another case. |
| `422` | The push was refused: not a `.gem`, or a name or version RubyGems would not take. The response says which. |
| `413` | The `.gem` is over 100 MB. |
