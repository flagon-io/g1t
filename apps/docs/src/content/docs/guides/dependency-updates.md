---
title: Dependency updates
description: Keep a repository's dependencies current with a dependabot.yml file. g1t opens pull requests that raise them on the schedule you set, and lands them through your required checks.
---

g1t keeps your dependencies current from one file in your repository,
written in `dependabot.yml` version 2 syntax. On the schedule you set, g1t
checks each dependency's registry for newer versions and opens pull
requests that raise them. They land through your branch's required checks
like any other change.

The same file also shapes the [security updates](/guides/security/#security-updates)
g1t opens for vulnerable dependencies. See
[Security updates follow the same file](#security-updates-follow-the-same-file).

## Turn on version updates

1. Add `.g1t/dependabot.yml` to your default branch:

   ```yaml
   version: 2
   updates:
     - package-ecosystem: npm
       directory: /
       schedule:
         interval: weekly
   ```

2. Push it. g1t reads the file on every push to the default branch, and
   checks each entry it can update once, straight away.
3. Open the project's **Security** page and choose **Dependency updates**.
   It lists each entry, when it runs next, and what its last run found.

A repository you bring to g1t keeps its existing file. You don't need to
move or change it.

## Where g1t reads the file

g1t reads the file from the default branch, at the first of these paths
that exists:

| Order | Path |
| --- | --- |
| 1 | `.g1t/dependabot.yml` |
| 2 | `.g1t/dependabot.yaml` |
| 3 | `.github/dependabot.yml` |
| 4 | `.github/dependabot.yaml` |

When a file exists under both `.g1t/` and `.github/`, g1t reads the one
under `.g1t/`, and the Security page says the other is ignored.

g1t reads the file on every push to the default branch, and at least once
a day, with the daily [dependency scan](/guides/security/#dependencies).

## Checking the file

g1t checks the whole file each time it reads it. Every problem is reported
with its line and the key it is on:

```text
line 6, updates[0].schedule.interval: `hourly` is not an interval. Use `daily`, `weekly`, `monthly`, `quarterly`, `semiannually`, `yearly` or `cron`.
```

- A key g1t does not know is a problem, so a misspelled option is never
  passed over in silence.
- A file with any problem is not acted on: g1t opens nothing from it until
  it is fixed. The Security page lists each problem.
- `version` must be `2` (or `"2"`).
- The file holds at most 200 entries and 100 registries. Each ecosystem,
  directory and target branch is listed once; a second entry for the same
  ones is a problem.
- YAML anchors, aliases and `<<` merge keys work.

### Checking a pull request that changes the file

A pull request that changes the file gets a status named
`g1t / dependabot.yml` on its head commit:

| Status | Description |
| --- | --- |
| Success | `.g1t/dependabot.yml is valid: 3 entries.` |
| Failure | The first problem, and how many more there are, such as `line 6, updates[0].schedule.interval: … (and 2 more)` |

Make it a [required status check](/guides/pull-requests/#required-status-checks)
to stop a broken file from reaching the default branch.

## Ecosystems

g1t accepts every `package-ecosystem` value the format names, and opens
version update pull requests for four of them:

| `package-ecosystem` | Lockfiles | Manifests |
| --- | --- | --- |
| `npm` | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` | `package.json` |
| `cargo` | `Cargo.lock` | `Cargo.toml` |
| `gomod` | `go.mod`, `go.sum` | `go.mod` |
| `pip` | Pins in `requirements.txt`, `poetry.lock` | `requirements.txt`, `pyproject.toml` |

A directory is updated only when it has a lockfile: its own, or the
nearest one above it, as in a workspace.

These values are read and checked, and the Security page lists their
entries as not updated yet: `bazel`, `bun`, `bundler`, `composer`, `conda`,
`deno`, `devcontainers`, `docker`, `docker-compose`, `dotnet-sdk`, `elm`,
`github-actions`, `gitsubmodule`, `gradle`, `helm`, `julia`, `maven`, `mix`,
`nix`, `nuget`, `opentofu`, `pre-commit`, `pub`, `rust-toolchain`, `sbt`,
`swift`, `terraform`, `uv` and `vcpkg`.

With `enable-beta-ecosystems: true` at the top of the file, any other
`package-ecosystem` name is accepted too.

## When updates run

Each entry g1t updates runs once as soon as g1t first reads the file with
it, and then on its `schedule`. g1t picks up due entries every five
minutes.

| `interval` | Runs |
| --- | --- |
| `daily` | Monday to Friday. |
| `weekly` | Once a week, on `day` (`monday` unless you set it). |
| `monthly` | On the 1st of each month. |
| `quarterly` | On 1 January, 1 April, 1 July and 1 October. |
| `semiannually` | On 1 January and 1 July. |
| `yearly` | On 1 January. |
| `cron` | When `cronjob` says. |

The other `schedule` keys:

| Key | Value | Default |
| --- | --- | --- |
| `day` | A day of the week, such as `friday`. Used by `weekly`. | `monday` |
| `time` | The time of day, as `hh:mm`, such as `"09:00"`. | A time g1t picks |
| `timezone` | An IANA time zone, such as `America/New_York`. Daylight saving is followed. | `UTC` |
| `cronjob` | A five-field cron expression, such as `"0 9 * * 1"`, or a phrase such as `every weekday at 9:30am`. Required with, and only read for, `interval: cron`. | |

`cronjob` also takes these phrases: `every day at 5pm`,
`every weekday at 9:30am`, `every monday at 09:00`, `every hour` and
`every 6 hours`.

Without `time`, g1t picks a time of day for each entry of each repository
and keeps it, so your repositories don't all update at once. The Security
page shows it as "a time picked for this repository".

To run an entry now, choose **Check for updates** next to it on the
Security page. You need the Write [role](/guides/access-and-roles/).

## What a run does

1. g1t reads the manifests and lockfiles in the entry's directories.
2. It asks each dependency's registry which versions exist: the npm
   registry, crates.io, the Go module proxy or PyPI, or a
   [private registry](#private-registries) you name.
3. It picks each dependency's target version, following `allow`, `ignore`,
   `cooldown` and `versioning-strategy`.
4. It gathers the updates into pull requests, by `groups`, and opens up to
   `open-pull-requests-limit` of them.

What g1t updates and skips:

- Only dependencies your manifests name (direct dependencies) are updated,
  unless an [`allow`](#allow) rule says otherwise.
- Pre-releases are skipped, unless the current version is one.
- Yanked and deprecated versions are skipped.
- A run looks at up to 200 dependencies. When there are more, its summary
  says how many were skipped.

The Security page shows when each entry was last checked and what the run
found:

```text
Checked 42 dependencies: 38 up to date, 1 ignored, 3 pull requests asked for, 1 waiting for open-pull-requests-limit.
```

Version updates run in the same sandbox as security updates, and are
metered the same way. g1t never runs a manifest's code while updating
it.

## The pull requests

Version update pull requests are opened by g1t, and show
[@g1t](/guides/security/#the-g1t-identity) as their author.

| What it updates | Title |
| --- | --- |
| One dependency | `Bump lodash from 4.17.20 to 4.17.21` |
| One dependency, not in the root directory | `Bump lodash from 4.17.20 to 4.17.21 in /web` |
| A group | `Bump the lint group with 3 updates` |
| A group in one directory | `Bump the lint group in /web with 2 updates` |
| A group across directories | `Bump the lint group across 2 directories with 4 updates` |
| A `group-by: dependency-name` group | `Bump eslint to 9.0.0 across 2 directories` |

The body says what changes and links, when they are known, the
dependency's changelog (when its registry names one), its release notes
(for source on github.com, gitlab.com or g1t.sh), its source and its
package page. A group's body has a table of each package, its old and new
version, and its directory. Every body lists the
[commands](#comment-commands) the pull request takes, and its footer names
the file it came from and the entry's `name`, if it has one.

The commit message is the title, a line for each update, and an
`updated-dependencies` record:

```text
Bump lodash from 4.17.20 to 4.17.21

Bumps lodash from 4.17.20 to 4.17.21.

---
updated-dependencies:
- dependency-name: lodash
  dependency-version: 4.17.21
  dependency-type: direct:production
  update-type: version-update:semver-patch
...
```

`dependency-type` is `direct:production`, `direct:development` or
`indirect`. A grouped update adds `dependency-group: <name>` to each
dependency.

### Superseded pull requests

When a newer version comes out for a dependency (or group) that already
has an open pull request, g1t opens a new pull request and closes the
older one with the comment "Superseded by #N.".

### Landing them

Version update pull requests land through the branch's
[required checks](/guides/pull-requests/#required-status-checks) and the
[merge queue](/guides/merge-queue/) like any other change.

When a required check fails on g1t's own commit (or, on a branch with no
required checks, a workflow's status fails), raising the version was not
enough. g1t closes the pull request and opens an issue titled
`<pull request title>: needs code changes`, assigned to
[g1t](/guides/working-with-g1t/), to make the changes the update needs.
Security updates are handled
[the same way](/guides/security/#when-code-has-to-change).

If the sandbox has not pushed a branch 45 minutes after an update started,
the update is marked failed, and the entry's next run tries again.

## Comment commands

Comment on a pull request g1t opened for a version or security update,
with a command on the comment's first line:

| Command | What it does |
| --- | --- |
| `@g1t rebase` | Brings the branch up to date with the default branch. Refused if someone else has pushed to it; use `@g1t recreate`. |
| `@g1t recreate` | Makes the pull request again from scratch, dropping anything pushed to it. |
| `@g1t merge` | Merges it once its required checks pass. |
| `@g1t squash and merge` | The same as `@g1t merge`: g1t merges pull requests one way. |
| `@g1t cancel merge` | Cancels an earlier `@g1t merge`. |
| `@g1t close` | Closes it. g1t does not open one for these versions again, but does for a newer version. |
| `@g1t reopen` | Makes it again, as a new pull request on the same branch. |
| `@g1t ignore this dependency` | Closes it, and stops updating the dependency. |
| `@g1t ignore this major version` | Closes it, and skips this major version. Also `minor` and `patch`. |
| `@g1t ignore <dependency>` | On a grouped pull request, stops updating one dependency. |
| `@g1t ignore <dependency> major version` | On a grouped pull request, skips that dependency's major version. Also `minor` and `patch`. |
| `@g1t unignore <dependency>` | Removes the dependency's ignore conditions. |
| `@g1t unignore <dependency> major version` | Removes one ignore condition. Also `minor` and `patch`. |
| `@g1t unignore *` | Removes the ignore conditions set by comments. |
| `@g1t show <dependency> ignore conditions` | Lists what is skipped for a dependency. |
| `@g1t show ignore conditions` | Lists the ignore conditions set by comments. |

Commands need the Write [role](/guides/access-and-roles/). `@g1t merge`,
`@g1t squash and merge` and `@g1t cancel merge` need the role that may
merge pull requests.

Ignoring a version records an ignore condition. On a pull request that
raises a dependency to 5.0.0, `@g1t ignore this major version` records
`>= 5.a, < 6`. Ignore conditions set by comments apply to version and
security updates, and the Security page lists them.

These commands are not mentions: they never start an agent.

## Security updates follow the same file

[Security updates](/guides/security/#security-updates) are still turned on
and off with the **Security updates** switch. When the file has an entry
for a vulnerable package's ecosystem, in a directory that holds the
package's lockfile, that entry shapes the security update:

| Option | Effect on security updates |
| --- | --- |
| `ignore` | A rule naming the package, or `versions` that cover the fix, skips it. So do ignore conditions set by comments. |
| `allow` | `dependency-name` rules limit which packages are updated. |
| `groups` with `applies-to: security-updates` | The group's vulnerable packages are fixed in one pull request, `Bump the <group> group with 2 security updates`, on the branch `g1t/security/<group>-<hash>`. |
| `commit-message` | Its prefix starts the title. |
| `assignees`, `reviewers` | Applied when the pull request opens. |
| `labels`, `milestone` | Applied when the pull request opens, as for version updates. Without `labels`, it carries `dependencies` and the ecosystem's label. |
| `open-pull-requests-limit`, `cooldown` | Do not apply. Security updates are never held back. |

Security updates always merge into the default branch, so an entry whose
`target-branch` is another branch does not apply to them.

## The Security page

Open the project's **Security** page and choose the **Dependency updates**
tab, at `g1t.sh/<owner>/<project>/security/dependency-updates`. It shows:

- the file g1t read, and any file it ignored;
- each problem in the file, with its line;
- each entry: its ecosystem and directories, its schedule in words, its
  next run, when it was last checked and what that run found, whether g1t
  updates it, and the options it reads but does not act on;
- the [registries](#private-registries), with the secrets each one names;
- the open version update pull requests;
- the ignore conditions set by comments;
- **Check for updates** next to each entry, to run it now.

## Examples

### A monorepo

Every package under `packages/` and the app in `/web`, checked each
weekday morning in New York, with lint tools in one pull request and
everything else in one pull request per dependency:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directories:
      - /web
      - /packages/*
    exclude-paths:
      - "fixtures/**"
    schedule:
      interval: daily
      time: "08:00"
      timezone: America/New_York
    open-pull-requests-limit: 10
    groups:
      lint:
        patterns:
          - "eslint*"
          - "@typescript-eslint/*"
          - prettier
      types:
        dependency-type: development
        patterns:
          - "@types/*"
  - package-ecosystem: cargo
    directory: /
    schedule:
      interval: weekly
      day: tuesday
```

A group across several directories opens one pull request, such as
`Bump the lint group across 3 directories with 6 updates`.

### Waiting, and leaving some versions alone

Wait a week before taking a new major version and two days for anything
else, never take React 19, and never update `left-pad`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 2
      semver-major-days: 7
      exclude:
        - "@acme/*"
    ignore:
      - dependency-name: react
        versions: [">=19"]
      - dependency-name: react-dom
        versions: [">=19"]
      - dependency-name: left-pad
```

Your own `@acme/*` packages are taken as soon as they are published.

### A private npm registry

Store the token as a secret named `NPM_TOKEN` in **Settings → Secrets**
(see [Secrets and variables](/guides/secrets-and-variables/)), then name
it in the file:

```yaml
version: 2
registries:
  acme-npm:
    type: npm-registry
    url: https://npm.acme.dev
    token: ${{secrets.NPM_TOKEN}}
    scope: "@acme"
updates:
  - package-ecosystem: npm
    directory: /
    registries:
      - acme-npm
    schedule:
      interval: daily
```

Packages under `@acme` come from `npm.acme.dev`, and every other package
from the public npm registry.

### Commit messages and branch names

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /web
    schedule:
      interval: weekly
    commit-message:
      prefix: build
      prefix-development: chore
      include: scope
    pull-request-branch-name:
      prefix: deps
      separator: "-"
```

An update to `lodash`, a production dependency, opens:

```text
build(deps): bump lodash from 4.17.20 to 4.17.21 in /web
```

on the branch `deps-npm_and_yarn-web-lodash-4.17.21`. An update that
only touches development dependencies is titled
`chore(deps-dev): bump …`.

### Security updates in one pull request

Fix every vulnerable npm package in one pull request, and keep version
updates one per dependency:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      security:
        applies-to: security-updates
        patterns:
          - "*"
    reviewers:
      - alice
```

To use the file only for security updates, set
`open-pull-requests-limit: 0` on the entry.

## Options

Each entry under `updates` takes the options below. `package-ecosystem`,
`directory` (or `directories`) and `schedule` are required. Unless a row
says otherwise, g1t acts on every option.

| Option | What g1t does | Default |
| --- | --- | --- |
| `package-ecosystem` | The [ecosystem](#ecosystems). | Required |
| `directory` | Where the manifest is, from the repository's root, such as `/` or `/web`. No wildcards. | Required, or `directories` |
| `directories` | A list of directories, with globs: `*`, `**` and `?`. | |
| `exclude-paths` | Globs, relative to each directory, of manifests to leave out. | |
| `schedule` | [When updates run](#when-updates-run). | Required |
| `allow` | [Which dependencies are updated](#allow). | Direct dependencies |
| `ignore` | [Dependencies and versions to skip](#ignore). | |
| `cooldown` | [How long a release waits](#cooldown). | 3 days |
| `groups` | [Updates gathered into one pull request](#groups). | One pull request per dependency and directory |
| `versioning-strategy` | [How a requirement is raised](#versioning-strategy). | `increase` |
| `open-pull-requests-limit` | How many of this entry's version update pull requests can be open at once. A group counts as one, and a newer version replacing an open pull request does not add one. `0` turns version updates off for the entry. Security updates are not limited by it. | `5` |
| `commit-message` | [The title and commit message's prefix](#commit-message). | |
| `pull-request-branch-name` | [The branch name](#pull-request-branch-name). | |
| `rebase-strategy` | `auto`: an open pull request whose branch conflicts with the default branch is made again from the default branch, unless someone else pushed to it. `disabled`: never. | `auto` |
| `assignees` | Usernames assigned when the pull request opens. Also applies to security updates. | |
| `reviewers` | Usernames whose review is asked for when the pull request opens. A team (`org/team`) is skipped. Also applies to security updates. | |
| `registries` | The [registries](#private-registries) the entry uses: a list of names, or `"*"` for all of them. | |
| `target-branch` | The branch updates start from and merge into. Its manifests are read, each update is made from it, and its pull request's [base](/guides/base-branches/) is that branch. The default branch's protection does not cover it. | The default branch |
| `labels` | The [labels](/guides/labels/) put on each pull request. A label the repository lacks is created. `labels: []` puts none on. | `dependencies` and the ecosystem's label |
| `milestone` | The number of a [milestone](/guides/milestones/) to put each pull request in. A number the repository has no milestone for is skipped. | |
| `vendor` | Read. Vendored copies of dependencies are not updated. | `false` |
| `insecure-external-code-execution` | Read. g1t never runs a manifest's code while updating it. | |
| `name` | A name for the entry, 3 to 100 characters, shown in the footer of its pull requests. | |
| `multi-ecosystem-group` | The [multi-ecosystem group](#multi-ecosystem-groups) the entry belongs to. | |
| `patterns` | Only read for an entry in a multi-ecosystem group, where it is required. | |

At the top of the file, beside `version` and `updates`:

| Option | What g1t does |
| --- | --- |
| `registries` | The [private registries](#private-registries) entries can use. |
| `enable-beta-ecosystems` | `true` accepts any `package-ecosystem` name. |
| `multi-ecosystem-groups` | [Groups across ecosystems](#multi-ecosystem-groups). |

### `allow`

A list of rules. With rules, a dependency is updated only when it matches
one. Without, direct dependencies are.

| Key | Value |
| --- | --- |
| `dependency-name` | A name. `*` matches any run of characters, and case is ignored. |
| `dependency-type` | `direct`, `indirect`, `all`, `production` or `development`. For `cargo`, `gomod` and `pip`, `indirect` and `all` add the lockfile's other packages. |
| `update-types` | How far a matching dependency may move: a list of `version-update:semver-major`, `version-update:semver-minor` and `version-update:semver-patch`. |

A rule needs `dependency-name` or `dependency-type`.

### `ignore`

A list of rules. A dependency that matches both an `allow` rule and an
`ignore` rule is ignored.

| Key | Value |
| --- | --- |
| `dependency-name` | A name. `*` matches any run of characters. Without it, the rule applies to every dependency. |
| `versions` | A requirement, or a list of them, in the ecosystem's own syntax. Versions they match are skipped. |
| `update-types` | Kinds of update to skip: `version-update:semver-major`, `version-update:semver-minor`, `version-update:semver-patch`. |

A rule with only `dependency-name` skips the dependency entirely. A rule
needs at least one key. `versions` takes each ecosystem's own syntax:

| Syntax | Examples |
| --- | --- |
| npm | `^1.0.0`, `1.x`, `>=19` |
| pip | `~=1.4`, `==1.*`, `!=1.5.0` |
| Bundler | `~> 2.0` |
| NuGet | `7.*` |
| Maven | `[1.4,)` |

### `cooldown`

A release newer than its cooldown is passed over for the newest version
that is past it. Without `cooldown`, every version waits 3 days.

| Key | Value |
| --- | --- |
| `default-days` | Days to wait for any update, 1 to 90. |
| `semver-major-days` | Days to wait for a major update, 1 to 90. |
| `semver-minor-days` | Days to wait for a minor update, 1 to 90. |
| `semver-patch-days` | Days to wait for a patch update, 0 to 90. |
| `include` | Dependency names (with `*`) the cooldown applies to, up to 150. |
| `exclude` | Dependency names (with `*`) it does not apply to, up to 150. `exclude` wins over `include`. |

A registry that does not say when a version was published, such as a
private Cargo index without `pubtime` or most private Go proxies, has no
cooldown applied. Cooldown never applies to security updates.

### `groups`

A mapping of group names to rules. A name starts and ends with a letter or
digit, and holds only letters, digits, `|`, `_` and `-`.

| Key | Value | Default |
| --- | --- | --- |
| `applies-to` | `version-updates` or `security-updates`. | `version-updates` |
| `patterns` | Dependency names (with `*`) in the group. | Every dependency |
| `exclude-patterns` | Dependency names (with `*`) left out. | |
| `dependency-type` | `production` or `development`. | Both |
| `update-types` | A list of `major`, `minor` and `patch`. | All |
| `group-by` | `dependency-name`: one pull request per dependency, across all the entry's directories. Version updates only. | |

A dependency joins the first group that takes it. Dependencies no group
takes open one pull request per dependency and directory. A group across
several directories opens one pull request.

### `versioning-strategy`

| Value | What g1t does |
| --- | --- |
| `increase` | Raises the manifest's requirement, keeping its style: `^`, `~` or exact. |
| `auto` | The same as `increase`. |
| `increase-if-necessary` | Updates the lockfile within the requirement when it allows the new version, and raises the requirement when it does not. |
| `widen` | For npm, adds the new range: `^1.2.0 \|\| ^2.0.0`. |
| `lockfile-only` | Updates only lockfiles, and only to versions the requirement already allows. |

For `gomod`, every strategy runs `go get` and then `go mod tidy`. Pins in
`requirements.txt` are rewritten.

### `commit-message`

| Key | Value |
| --- | --- |
| `prefix` | Starts the title and commit message. At most 50 characters. |
| `prefix-development` | Used instead of `prefix` for an update that only touches development dependencies. At most 50 characters. |
| `include` | `scope` adds `(deps)`, or `(deps-dev)` for development dependencies, after the prefix. |

How the prefix joins the title:

- A prefix that ends with a letter, a digit, `)` or `]` is followed by a
  colon and a space: `build: bump …`.
- A prefix that ends with a space is used as it is: `deps bump …`.
- Any other prefix is followed by a space.
- With `include: scope` and no prefix, the prefix is `chore`:
  `chore(deps): bump …`.

With a prefix, `Bump` becomes `bump`:
`build(deps): bump lodash from 4.17.20 to 4.17.21`.

### `pull-request-branch-name`

| Key | Value | Default |
| --- | --- | --- |
| `prefix` | What every branch name starts with. At most 50 characters. | `g1t` |
| `separator` | `/`, `-` or `_`, between the parts of the name. | `/` |
| `max-length` | 20 to 244. A longer name is cut, and ends with a hash. | `100` |
| `word-separator` | Replaces `_` after the prefix: `-`, `_`, `/` or `.`. | |
| `branch-name-case` | `lowercase` or `uppercase`, after the prefix. | |
| `template` | The whole name, at most 200 characters, from the placeholders below. | |

Template placeholders: `{prefix}`, `{package_manager}`, `{directory}`,
`{target_branch}`, `{dependency}`, `{version}`, `{group_name}` and
`{name}`.

Default branch names:

| Update | Branch |
| --- | --- |
| `lodash` in `/` | `g1t/npm_and_yarn/lodash-4.17.21` |
| `lodash` in `/web` | `g1t/npm_and_yarn/web/lodash-4.17.21` |
| The `lint` group | `g1t/npm_and_yarn/lint-<10-character hash>` |

The package manager part is `npm_and_yarn` for npm, `cargo` for Cargo,
`go_modules` for Go and `pip` for pip.

### Private registries

Name registries at the top of the file, under `registries`, and list the
ones each entry uses in its own `registries`.

| Key | Value |
| --- | --- |
| `type` | The registry's type. Required. |
| `url` | The registry's address, over `https`. |
| `username`, `password` | Credentials for basic sign-in. |
| `token` | A token. |
| `key` | A key. |
| `replaces-base` | `true` to use this registry for every package, not only those it is scoped to. |
| `scope` | For `npm-registry`: an npm scope such as `@acme`, or a list of them. |

The format's other keys (`organization`, `repo`, `auth-key`,
`public-key-fingerprint`, `registry`, `tenant-id`, `client-id`,
`jfrog-oidc-provider-name`, `identity-mapping-name`, `audience`,
`aws-region`, `account-id`, `role-name`, `domain` and `domain-owner`) are
read and checked.

`type` is one of `cargo-registry`, `composer-repository`,
`docker-registry`, `git`, `goproxy-server`, `helm-registry`,
`hex-organization`, `hex-repository`, `maven-repository`, `npm-registry`,
`nuget-feed`, `pub-repository`, `python-index`, `rubygems-server` and
`terraform-registry`. g1t uses four of them, for version lookups and in
the update sandbox:

| Type | Used for |
| --- | --- |
| `npm-registry` | With a `scope`, that scope's packages. With `replaces-base: true`, every package. |
| `cargo-registry` | Every crate, with `replaces-base: true`. |
| `goproxy-server` | Every module, with `replaces-base: true`. |
| `python-index` | Every package, with `replaces-base: true`. |

A registry that signs in with OIDC is not used.

Put credentials in [secrets](/guides/secrets-and-variables/) and name
them as `${{secrets.NAME}}`. g1t fills them from the repository's and the
workspace's secrets that are available to workflows. When a secret is
missing, that registry is not used, and the run says which secret it
needed. g1t never stores or shows the credentials; the Security page lists
each registry with the secrets it names.

### Multi-ecosystem groups

`multi-ecosystem-groups` at the top of the file names groups, each with a
`schedule`. An entry joins one with `multi-ecosystem-group: <name>`, and
then needs `patterns` (`["*"]` for every dependency). The entry runs on the
group's schedule. Its updates still open one pull request per ecosystem,
not one for the whole group.
