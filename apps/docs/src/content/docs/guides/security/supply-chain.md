---
title: Supply chain
description: The dependency graph, an SPDX SBOM of it, dependency review on pull requests, and vulnerability alerts.
---

g1t reads every lockfile on your default branch, on every push to it and
daily: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`,
`go.mod`, `go.sum`, `requirements.txt` and `poetry.lock`, up to four
directories deep and outside `node_modules`, `vendor`, `target`, `dist`
and the like. From them come the dependency graph, its SBOM, vulnerability
alerts and [security updates](/guides/security/#security-updates).

| Feature | Public repositories | Private repositories |
| --- | --- | --- |
| Dependency graph and SBOM | Free | Free |
| Vulnerability alerts and security updates | Free | Free |
| Dependency review | Free | With the g1t plan |

## The dependency graph

`g1t.sh/<owner>/<project>/security/dependency-graph` lists every package the
lockfiles resolve, per lockfile, with:

| Column | |
| --- | --- |
| Relationship | **Direct** (the project asks for it) or **transitive** (another package does), where the lockfile says; **not said** where it does not. |
| Development | Whether it is for development or tests only, where the lockfile says. |
| License | The license the lockfile records (npm's lockfiles do; most others do not). |
| Vulnerabilities | Open vulnerability alerts on that version. |

What each lockfile says:

| Lockfile | Direct or transitive | Development | License |
| --- | --- | --- | --- |
| `package-lock.json` (v2, v3) | From the project's and its workspaces' own `dependencies` | Yes | Yes |
| `pnpm-lock.yaml` | From `importers` (or the top-level lists in older files) | Yes | No |
| `Cargo.lock` | From the dependencies of the workspace's own crates | No | No |
| `go.mod` | `// indirect` marks transitive | No | No |
| `requirements.txt` | Every line is direct, unless pip-compile wrote it: then its `# via` notes say | No | No |
| `yarn.lock`, `go.sum`, `poetry.lock`, `package-lock.json` v1 | Not said | v1 only | No |

## Exporting an SBOM

**Export SBOM (SPDX)** downloads the graph as an
[SPDX 2.3](https://spdx.github.io/spdx-spec/v2.3/) JSON document,
`<owner>-<project>.spdx.json`:

- The repository is the document's one described package, versioned by the
  commit the lockfiles were read at.
- Every dependency is a package named by its
  [package URL](https://github.com/package-url/purl-spec)
  (`pkg:npm/%40babel/core@7.24.0`), with its license when the lockfile
  records one as an SPDX expression, and `NOASSERTION` otherwise.
- The repository `DEPENDS_ON` each runtime dependency; each development
  dependency is a `DEV_DEPENDENCY_OF` it.

Over the API, `GET /repos/{owner}/{name}/dependency-graph/sbom` returns it in
`sbom`, as SPDX spells it:

```sh
curl -s -H "Authorization: Bearer $G1T_TOKEN" \
  https://api.g1t.sh/repos/acme/rocket/dependency-graph/sbom | jq .sbom > rocket.spdx.json
```

## Dependency review

On every pull request that opens, or whose head moves, g1t compares the
dependencies at the point it left the default branch with those at its
head. A pull request that changes no lockfile passes at once. Otherwise
each package it adds (or moves to another version) is checked against
[OSV](https://osv.dev), and the **Dependency review** check fails when it
adds:

- a package with a known vulnerability at or above the severity you
  choose, or
- a package with a license you do not allow.

The review's summary is commented on the pull request, a table per
lockfile of what was added and removed, and the check links to
`g1t.sh/<owner>/<project>/security/pulls/<number>`. Require **Dependency
review** under **Settings → Branches** to block merges on it.

In the repository's **Security settings**:

| Setting | Default | |
| --- | --- | --- |
| Dependency review | On | Whether pull requests get the check. |
| Fail on vulnerabilities of | High severity or higher | Critical, high, medium, any severity, or never. |
| Licenses not allowed | None | SPDX ids, such as `GPL-3.0-only, AGPL-3.0-only`. An `OR` expression passes when any side is allowed. |
| Comment the summary | On | Whether the review comments on the pull request. |

Licenses come from the lockfile, so only npm's packages can be refused for
one today.

`GET /repos/{owner}/{name}/dependency-graph/compare/{basehead}` makes the
same comparison between any two commits, branches or tags, as
`base...head`:

```sh
curl -s -H "Authorization: Bearer $G1T_TOKEN" \
  "https://api.g1t.sh/repos/acme/rocket/dependency-graph/compare/main...upgrade-deps"
```

## Vulnerability alerts

Vulnerability alerts are at `g1t.sh/<owner>/<project>/security/vulnerabilities`.
How they are found, dismissed and fixed by security updates is in
[Security](/guides/security/#dependencies). Like the other alerts, each can
be dismissed with a reason, reopened, and put to g1t with **Fix with g1t**
over the API (`POST /repos/{owner}/{name}/security/alerts/{id}/fix`), which
opens an issue to upgrade the package and change the code that needs it.

## API and MCP

| Route | What it does | Scope |
| --- | --- | --- |
| `GET /repos/{owner}/{name}/dependency-graph` | The graph, per lockfile. | `security:read` |
| `GET /repos/{owner}/{name}/dependency-graph/sbom` | The SPDX document, in `sbom`. | `security:read` |
| `GET /repos/{owner}/{name}/dependency-graph/compare/{basehead}` | What changed between two commits, and whether it passes review. | `security:read` |
| `GET /repos/{owner}/{name}/vulnerability-alerts` | Lists alerts; filter with `state`, `severity`, `ecosystem`, `package`. | `security:read` |
| `GET /workspaces/{workspace}/vulnerability-alerts` | The same across a workspace. | `security:read` |
| `GET /repos/{owner}/{name}/vulnerability-alerts/{id}` | One alert. | `security:read` |
| `PATCH /repos/{owner}/{name}/vulnerability-alerts/{id}` | `state` `dismissed` with `reason` and `comment`, or `open`. | `security:write` |

Over MCP, the [`security` tool](/reference/mcp/#security) has
`dependency_graph`, `sbom`, `compare_dependencies`, `vulnerability_alerts`,
`vulnerability_alert` and `update_vulnerability_alert`. Webhooks:
`vulnerability_alert.created`, `.fixed`, `.dismissed` and `.reopened`.
