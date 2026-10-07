---
title: npm
description: Publish and install a workspace's npm packages on g1t.sh, from your machine and from workflows with G1T_TOKEN.
---

g1t.sh is an npm registry for packages scoped by workspace: `@acme/ui` is
the `ui` package of the `acme` workspace. `npm` (and any client that reads
`.npmrc`) publishes and installs them with two lines of configuration.

```text
https://g1t.sh/-/npm/
```

Packages of other scopes and unscoped ones still come from the registry
npm uses by default; only your workspace's scope is pointed at g1t.

## Set up `.npmrc`

In the project (or in `~/.npmrc` for every project), name g1t as the
registry for the workspace's scope, and give it an
[access token](https://g1t.sh/settings/tokens):

```ini
@acme:registry=https://g1t.sh/-/npm/
//g1t.sh/-/npm/:_authToken=${G1T_TOKEN}
```

npm reads `${G1T_TOKEN}` from the environment, so the token itself stays
out of the file you commit. A token with full access works; one with scopes
needs `packages:read` to install private packages and `packages:write` to
publish. Public packages install without a token.

Check it:

```sh
npm whoami --registry https://g1t.sh/-/npm/
```

`npm login --scope=@acme --auth-type=legacy` also works, with your username
and a g1t token (not your password) as the password.

## Publish

The package's `name` is scoped by its workspace:

```json
{
  "name": "@acme/ui",
  "version": "1.0.0",
  "repository": "https://g1t.sh/acme/ui"
}
```

```sh
npm publish
```

The first publish makes the package. When its `repository` is a g1t.sh
repository of the same workspace, or a repository is named like the
package, it is linked to that repository and has its visibility and roles:
publishing needs Write on it. Otherwise it is the workspace's, private,
and needs the workspace's Write base permission. See
[who can see and publish a package](/guides/packages/#who-can-see-and-publish-a-package).

A version is published once: publishing a version that is already there is
refused, so bump `version` first. `npm publish --tag next` publishes
without moving `latest`. The README of the version `latest` points to is
shown on the package's page.

## Install

```sh
npm install @acme/ui
```

Lockfiles record `https://g1t.sh/-/npm/…` tarball addresses and each
tarball's `sha512` integrity, which g1t computes when the version is
published.

## In workflows

A workflow's `G1T_TOKEN` is the workspace's own token for the run, and can
install and publish the workspace's packages:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: |
          echo "@acme:registry=https://g1t.sh/-/npm/" >> .npmrc
          echo "//g1t.sh/-/npm/:_authToken=\${G1T_TOKEN}" >> .npmrc
      - run: npm ci
      - run: npm publish
        env:
          G1T_TOKEN: ${{ secrets.G1T_TOKEN }}
```

`npm ci` needs the token too when the project depends on private packages;
set `G1T_TOKEN` for the whole job instead.

## Tags, deprecating and unpublishing

```sh
npm dist-tag add @acme/ui@1.2.0 stable
npm dist-tag ls @acme/ui
npm deprecate @acme/ui@1.0.0 "Use 1.2 or later"
npm unpublish @acme/ui@1.2.1
npm unpublish @acme/ui --force
```

Moving tags and deprecating need what publishing does. Unpublishing a
version needs it too within 72 hours of publishing; after that it needs
Admin on the linked repository (an owner, for the workspace's own
packages). Deprecate a version instead when people may depend on it.
Versions can also be deleted on the package's page.

## Size

A publish is one request with the tarball inside it, and may hold at most
100 MB. Without the [g1t plan](/guides/usage-and-billing/#the-g1t-plan), a
workspace's private packages may hold 500 MB and its public ones 10 GB, as
for [container images](/guides/containers/#storage-and-pull-limits).

## Errors

| Error | Means |
| --- | --- |
| `E401` | No token, or a wrong or expired one. Check `.npmrc` and `npm whoami`. |
| `E403` | Signed in, but your role or your token's scopes do not allow it, or the version is already published. The message says which. |
| `E404` | No such package, or one you cannot see. A private package needs a token in `.npmrc`. |
| `E413` | The publish is over 100 MB. Leave build output and fixtures out with `files` in `package.json` or `.npmignore`. |
