---
title: Code scanning
description: Static analysis results uploaded as SARIF become alerts, pull request comments and a check that can block merges; g1t fixes what they find.
---

Code scanning reads the results of static analysis tools: any tool that
writes [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html),
the standard format for them. You run the tool, in a
[workflow](/guides/actions/) or anywhere else, and upload its results.

- On the **default branch**, each problem is an **alert**, kept across
  analyses by its fingerprint, and **fixed** when a later analysis no
  longer reports it.
- On a **pull request**, the results that are new to it, on the lines it
  changes, become **review comments** and the **Code scanning** check,
  which fails at the threshold you choose. Require it in branch protection
  and it blocks merges, for people and agents alike.

Code scanning is free on public repositories and part of the
g1t plan, as [Security and quality](/guides/security/pricing/), on private
ones.

## Set it up

On a repository's Security page, open **Code scanning** and choose **Set
up code scanning**. g1t opens a pull request, as you, adding
`.g1t/workflows/code-scanning.yml`:

```yaml
name: Code scanning

on:
  push:
    branches: ["main"]
  pull_request:
  schedule:
    - cron: "27 4 * * 1"

# The job's token reads the code and uploads the results.
permissions:
  contents: read
  security-events: write

jobs:
  scan:
    name: Code scanning
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      G1T_TOKEN: ${{ secrets.G1T_TOKEN }}
    steps:
      - uses: actions/checkout@v4

      - name: Find the languages to scan
        id: languages
        run: |
          found() { [ -n "$(git ls-files -- "$@" | head -n 1)" ]; }
          if found '*.py'; then echo "python=true" >> "$GITHUB_OUTPUT"; fi
          if found 'go.mod' '*/go.mod'; then echo "go=true" >> "$GITHUB_OUTPUT"; fi
          if found '*.js' '*.jsx' '*.mjs' '*.cjs' '*.ts' '*.tsx' '*.mts' '*.cts'; then echo "javascript=true" >> "$GITHUB_OUTPUT"; fi
          if found 'Cargo.toml' '*/Cargo.toml'; then echo "rust=true" >> "$GITHUB_OUTPUT"; fi
          mkdir -p /tmp/sarif
          # Uploads one SARIF file: upload-sarif <file> <category> [<directory its paths are relative to>]
          cat > /tmp/upload-sarif <<'SCRIPT'
          #!/bin/sh
          set -eu
          file="$1"; category="$2"; dir="${3:-.}"
          if [ "$dir" != "." ]; then
            jq --arg prefix "$dir/" '(.runs[]?.results[]?.locations[]?.physicalLocation.artifactLocation
              | select(.uri != null and (.uri | test("^(/|[A-Za-z][A-Za-z0-9+.-]*:)") | not)) | .uri) |= $prefix + .' \
              "$file" > "$file.tmp" && mv "$file.tmp" "$file"
          fi
          ref="$GITHUB_REF"
          sha="$GITHUB_SHA"
          if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
            ref="refs/pull/$(jq -r .number "$GITHUB_EVENT_PATH")/head"
            sha="$(jq -r '.pull_request.head.sha // env.GITHUB_SHA' "$GITHUB_EVENT_PATH")"
          fi
          gzip -c "$file" | base64 -w0 > "$file.b64"
          jq -n --arg sha "$sha" --arg ref "$ref" --arg checkout "file://$GITHUB_WORKSPACE" --arg category "$category" --rawfile sarif "$file.b64" \
            '{commit_sha: $sha, ref: $ref, sarif: $sarif, checkout_uri: $checkout, category: $category}' > "$file.json"
          curl --fail-with-body -sS -X POST "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/code-scanning/sarifs" \
            -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" --data @"$file.json"
          echo
          SCRIPT
          chmod +x /tmp/upload-sarif

      - name: Python (Bandit)
        if: steps.languages.outputs.python == 'true'
        run: |
          python3 -m venv /tmp/bandit && /tmp/bandit/bin/pip install --quiet "bandit[sarif]"
          /tmp/bandit/bin/bandit --recursive . --exclude ./.git,./node_modules,./.venv,./venv \
            --format sarif --output /tmp/sarif/python.sarif --exit-zero --quiet
          /tmp/upload-sarif /tmp/sarif/python.sarif python

      - name: Go (gosec)
        if: steps.languages.outputs.go == 'true'
        run: |
          go install github.com/securego/gosec/v2/cmd/gosec@latest
          gosec="$(go env GOPATH)/bin/gosec"
          # Each module on its own, its results under its own category.
          for dir in $(git ls-files -- 'go.mod' '*/go.mod' | xargs -n1 dirname); do
            out="/tmp/sarif/go-$(echo "$dir" | tr '/.' '__').sarif"
            (cd "$dir" && "$gosec" -quiet -no-fail -fmt sarif -out "$out" ./...)
            if [ "$dir" = "." ]; then category="go"; else category="go:$dir"; fi
            /tmp/upload-sarif "$out" "$category" "$dir"
          done

      - name: JavaScript and TypeScript (ESLint)
        if: steps.languages.outputs.javascript == 'true'
        run: |
          mkdir -p /tmp/eslint
          npm install --prefix /tmp/eslint --no-audit --no-fund --silent \
            eslint@9 eslint-plugin-security typescript-eslint typescript @microsoft/eslint-formatter-sarif
          cat > /tmp/eslint/eslint.config.mjs <<'CONFIG'
          import security from "eslint-plugin-security";
          import tseslint from "typescript-eslint";

          const files = ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];

          export default [
            { ignores: ["**/node_modules/", "**/dist/", "**/build/", "**/coverage/", "**/vendor/", "**/*.min.js"] },
            { files, languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } } },
            { ...security.configs.recommended, files },
          ];
          CONFIG
          formatter="$(node -p "require.resolve('@microsoft/eslint-formatter-sarif', { paths: ['/tmp/eslint'] })")"
          # 1 is findings; 2 is ESLint failing to run.
          /tmp/eslint/node_modules/.bin/eslint --config /tmp/eslint/eslint.config.mjs --no-warn-ignored \
            --format "$formatter" --output-file /tmp/sarif/javascript.sarif . || [ $? -eq 1 ]
          /tmp/upload-sarif /tmp/sarif/javascript.sarif javascript

      - name: Rust (Clippy)
        if: steps.languages.outputs.rust == 'true'
        run: |
          cargo install --locked --quiet clippy-sarif
          # The workspace at the top, or else each outermost crate.
          if [ -f Cargo.toml ]; then
            roots="."
          else
            roots="$(git ls-files -- '*/Cargo.toml' | xargs -n1 dirname | sort | awk 'NR == 1 || index($0 "/", last "/") != 1 { print; last = $0 }')"
          fi
          for dir in $roots; do
            out="/tmp/sarif/rust-$(echo "$dir" | tr '/.' '__').sarif"
            (cd "$dir" && cargo clippy --all-targets --message-format=json > /tmp/clippy.json) || true
            clippy-sarif < /tmp/clippy.json > "$out"
            if [ "$dir" = "." ]; then category="rust"; else category="rust:$dir"; fi
            /tmp/upload-sarif "$out" "$category" "$dir"
          done
```

It looks at which languages the repository has, and scans each one with a
scanner made for it:

| Language | Scanner | Category |
| --- | --- | --- |
| Python | [Bandit](https://bandit.readthedocs.io) | `python` |
| Go | [gosec](https://securego.io), each module on its own | `go`, or `go:<directory>` for a module below the top |
| JavaScript and TypeScript | [ESLint](https://eslint.org) with [eslint-plugin-security](https://www.npmjs.com/package/eslint-plugin-security), written as SARIF by `@microsoft/eslint-formatter-sarif` | `javascript` |
| Rust | [Clippy](https://doc.rust-lang.org/clippy/), written as SARIF by `clippy-sarif` | `rust`, or `rust:<directory>` for a crate below the top |

A language the repository does not have is skipped. Each scanner installs
from its language's own registry (PyPI, the Go module proxy, npm or
crates.io) when the job runs. Every pull request, every push to the
default branch and a weekly run are scanned, and each language's results
are uploaded on their own, under their own category, so an alert is fixed
only by a later analysis of the same language. Merge the pull request to
start. Setting it up takes the Maintain role, as other workflows do.

To change what is scanned, edit the workflow: pass a scanner its own
options or rules, or add another tool that writes SARIF with
`/tmp/upload-sarif <file> <category>`. Give each tool, or each run of one
tool, its own `category`.

A pull request from a fork runs without the workspace's token, so its
upload is refused and its results are not shown. Its workflow fails at the
upload step.

## Uploading SARIF

`POST /repos/{owner}/{name}/code-scanning/sarifs`, with a token that has
`security:write` (a workflow's `G1T_TOKEN` does, with `security-events: write`
in its [`permissions:`](/guides/actions/#the-jobs-token), as the workflow
g1t writes has):

| Field | |
| --- | --- |
| `commit_sha` | The full hash of the commit analysed. |
| `ref` | `refs/heads/<branch>`, or `refs/pull/<number>/head` (or `/merge`) for a pull request. |
| `sarif` | The SARIF file gzipped, then base64-encoded: `gzip -c results.sarif \| base64 -w0`. At most 10 MB encoded and 40 MB unzipped. |
| `tool_name` | Optional: another name for the tool, when the file has one run. |
| `category` | Optional: which analysis this is. Default: the run's `automationDetails.id` up to its last `/`, or the tool's name. |
| `checkout_uri` | Optional: where the files were checked out (`file:///home/runner/work/repo`), so absolute paths become repository paths. |

The upload is read at once. The answer's `processing_status` is
`complete` or `failed`, with `errors` saying why; `GET
/repos/{owner}/{name}/code-scanning/sarifs/{id}` returns it again. Up to 20
runs and 5,000 results are read from one upload; results past that are
counted in the analysis's `dropped` and listed in `errors`.

### How results become alerts

Each result is fingerprinted, so the same problem found by the next
analysis is the same alert:

- A tool's own fingerprint (`partialFingerprints`, such as
  `primaryLocationLineHash`) is used when it gives one: it survives the
  line moving.
- Otherwise, the rule, the file and the code the result points at (its
  snippet, or its message), so editing elsewhere in the file does not make
  it a new alert. Identical results in one file are told apart by their
  order.

For each tool and category, an analysis of the default branch:

| The result | The alert |
| --- | --- |
| Not seen before | Opens, numbered in the repository |
| Seen before | Refreshed: its message, severity and location |
| Fixed before, found again | Opens again |
| Dismissed, found again | Stays dismissed |
| Not reported any more | Fixed |

Suppressed results (a tool's in-source suppressions) are not alerts.

### Severity

An alert's **severity** is its rule's **security severity** when the rule
has a `security-severity` score (9.0 and up critical, 7.0 high, 4.0 medium,
above 0 low); otherwise it comes from the result's level: `error` high,
`warning` medium, `note` low.

## On pull requests

An upload for `refs/pull/<number>/head` is compared with the default
branch:

- A result whose fingerprint is open on the default branch is not the pull
  request's own.
- A result new to the pull request, on a line it adds, is left as a
  **review comment** on that line, once.
- The **Code scanning** check is set on the pull request's head commit:
  it fails when a new result on a changed line reaches the threshold in the
  repository's **Security settings**:

| Code scanning results | Fails on |
| --- | --- |
| Never | Nothing |
| Errors only | Results the tool calls errors |
| Critical, and errors | Errors, and security results of critical severity |
| High or higher, and errors (the default) | Errors, and security results of high or critical severity |
| Medium or higher, and errors | Errors, and security results of medium severity or worse |
| Any security result, and errors | Errors, and any security result |

The check links to `g1t.sh/<owner>/<project>/security/pulls/<number>`,
which lists what it found. To block merges on it, require **Code
scanning** under **Settings → Branches** once it has reported on a pull
request, as for any [required check](/guides/pull-requests/). The merge
queue waits for it the same way.

## Alerts

`g1t.sh/<owner>/<project>/security/code-scanning` lists alerts, open
first and worst first, with recent analyses below. Filter by state,
severity and tool. Each alert's page has its rule's help, its location,
the analyses that reported it and its actions:

| Action | Needs | What happens |
| --- | --- | --- |
| **Dismiss** | Write | With a reason: **False positive** (`false_positive`), **Won't fix** (`wont_fix`) or **Used in tests** (`used_in_tests`), and an optional comment. |
| **Reopen** | Write | A dismissed alert opens again. |
| **Fix with g1t** | Write, and agents allowed to run | Opens an issue assigned to g1t. |

### Fix with g1t

**Fix with g1t** opens an issue with the alert's rule, message, location
and help, and a definition of done: the tool no longer reports the rule
there, and the tests still pass. g1t takes it as you, writes the fix in a
pull request and lands it through your required checks (including Code
scanning) and merge queue, like any agent's work. Asking again while the
issue is open goes to it. The run is charged as
[agent usage](/guides/usage-and-billing/).

## API and MCP

| Route | What it does | Scope |
| --- | --- | --- |
| `GET /repos/{owner}/{name}/code-scanning/alerts` | Lists alerts; filter with `state`, `severity`, `tool`, `rule_id`. | `security:read` |
| `GET /workspaces/{workspace}/code-scanning/alerts` | The same across a workspace. | `security:read` |
| `GET /repos/{owner}/{name}/code-scanning/alerts/{number}` | One alert, with its activity and analyses. | `security:read` |
| `PATCH /repos/{owner}/{name}/code-scanning/alerts/{number}` | `state` `dismissed` with `dismissed_reason` and `dismissed_comment`, or `open`. | `security:write` |
| `GET /repos/{owner}/{name}/code-scanning/analyses` | Analyses, newest first. | `security:read` |
| `POST /repos/{owner}/{name}/code-scanning/sarifs` | Uploads SARIF. | `security:write` |
| `GET /repos/{owner}/{name}/code-scanning/sarifs/{id}` | One upload. | `security:read` |
| `POST /repos/{owner}/{name}/security/alerts/{id}/fix` | Fix with g1t, for a code scanning, vulnerability or secret alert. | `security:write`, with `issues:write` and `agents:run` |

Over MCP, the [`security` tool](/reference/mcp/#security) has
`code_alerts`, `code_alert`, `update_code_alert`, `analyses`,
`upload_sarif`, `sarif_upload` and `fix`. Webhooks:
`code_scanning_alert.created`, `.fixed`, `.dismissed` and `.reopened`.
