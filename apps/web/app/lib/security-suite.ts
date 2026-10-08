/**
 * What the security pages work out from what the security service gives
 * them: filters read from the address, the starter code scanning workflow,
 * where old Security links go now, and trends scaled for drawing. Pure, so
 * it is tested on its own (security-suite.test.ts).
 */
import type {
  AlertState,
  CodeAlert,
  SecretFinding,
  Severity,
  SeverityCounts,
  TrendPoint,
  Vulnerability,
} from "@g1t/contracts";

const STATES: AlertState[] = ["open", "dismissed", "fixed"];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "unknown"];

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** Secret scanning's filters, from the page's address. */
export type SecretFilters = {
  state: AlertState;
  type: string | null;
  validity: "active" | "inactive" | "unknown" | "unsupported" | null;
  bypassed: boolean | null;
};

export function secretFilters(search: URLSearchParams): SecretFilters {
  const bypassed = search.get("bypassed");
  return {
    state: oneOf(search.get("state"), STATES) ?? "open",
    type: search.get("type") || null,
    validity: oneOf(search.get("validity"), ["active", "inactive", "unknown", "unsupported"] as const),
    bypassed: bypassed === "true" ? true : bypassed === "false" ? false : null,
  };
}

export function keepSecret(secret: SecretFinding, filters: SecretFilters): boolean {
  return (
    secret.state === filters.state &&
    (!filters.type || secret.kind === filters.type) &&
    (!filters.validity || (secret.validity ?? "unknown") === filters.validity) &&
    (filters.bypassed == null || Boolean(secret.bypass) === filters.bypassed)
  );
}

/** The kinds of secret a list holds, for its filter, as (id, label). */
export function secretTypes(secrets: SecretFinding[]): [string, string][] {
  const seen = new Map<string, string>();
  for (const secret of secrets) {
    const label = secret.kind === "custom_pattern" ? `Custom: ${secret.patternName ?? "pattern"}` : secret.label.replace(/^an? /, "");
    if (!seen.has(secret.kind)) seen.set(secret.kind, label.charAt(0).toUpperCase() + label.slice(1));
  }
  return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}

/** Code scanning's filters. */
export type CodeFilters = { state: AlertState; severity: Severity | null; tool: string | null };

export function codeFilters(search: URLSearchParams): CodeFilters {
  return {
    state: oneOf(search.get("state"), STATES) ?? "open",
    severity: oneOf(search.get("severity"), SEVERITIES),
    tool: search.get("tool") || null,
  };
}

export function keepCode(alert: CodeAlert, filters: CodeFilters): boolean {
  return (
    alert.state === filters.state &&
    (!filters.severity || alert.severity === filters.severity) &&
    (!filters.tool || alert.tool === filters.tool)
  );
}

/** How many alerts of each state, for the filter's counts. */
export function countStates<T extends { state: AlertState }>(alerts: T[]): Record<AlertState, number> {
  const counts: Record<AlertState, number> = { open: 0, dismissed: 0, fixed: 0 };
  for (const alert of alerts) counts[alert.state] += 1;
  return counts;
}

/** Open alerts by severity. */
export function severityCounts(items: { severity: Severity; state: AlertState }[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const item of items) if (item.state === "open") counts[item.severity] += 1;
  return counts;
}

export function total(counts: SeverityCounts): number {
  return counts.critical + counts.high + counts.medium + counts.low + counts.unknown;
}

/**
 * Where an old Security link goes now: `?tab=secrets&finding=sec_…` (git's
 * push refusals sent these) and `?tab=dependencies`. Null when it is the
 * overview's own address.
 */
export function legacySecurityTarget(base: string, search: URLSearchParams): string | null {
  const finding = search.get("finding");
  const tab = search.get("tab");
  if (finding?.startsWith("sec_")) return `${base}/security/secret-scanning/${finding}`;
  if (finding?.startsWith("vul_")) return `${base}/security/vulnerabilities?finding=${finding}`;
  if (tab === "secrets") return `${base}/security/secret-scanning${search.get("state") ? `?state=${search.get("state")}` : ""}`;
  if (tab === "dependencies") return `${base}/security/vulnerabilities${search.get("state") ? `?state=${search.get("state")}` : ""}`;
  return null;
}

/** A trend's points scaled to the tallest day, for drawing bars. */
export function trendMax(points: TrendPoint[]): number {
  return Math.max(1, ...points.map((point) => point.secretScanning + point.codeScanning + point.vulnerability));
}

/** Whether a vulnerability is open and at least `severity`. */
export function atLeast(severity: Severity, threshold: Severity): boolean {
  return SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(threshold);
}

/** Open vulnerabilities by package, worst first: for the overview's list. */
export function worstVulnerabilities(vulns: Vulnerability[], limit = 5): Vulnerability[] {
  return vulns
    .filter((vuln) => vuln.state === "open")
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.package.localeCompare(b.package))
    .slice(0, limit);
}

/** The branch "Set up code scanning" commits on: the first free name. */
export function codeScanningBranch(taken: string[]): string {
  const names = new Set(taken);
  if (!names.has("add-code-scanning")) return "add-code-scanning";
  for (let n = 2; ; n += 1) if (!names.has(`add-code-scanning-${n}`)) return `add-code-scanning-${n}`;
}

/**
 * The starter code scanning workflow: a scanner for each language the
 * repository has (Bandit for Python, gosec for Go, ESLint with
 * eslint-plugin-security for JavaScript and TypeScript, Clippy for Rust),
 * on every pull request, every push to the default branch and weekly. Each
 * language's SARIF is uploaded with its own category, with the job's own
 * token. Each scanner installs from its language's registry, which the
 * runner's egress allows.
 */
export function codeScanningWorkflow(defaultBranch: string): string {
  return `# Code scanning: a scanner for each language the repository has, with each
# one's results uploaded to g1t as SARIF under its own category. Alerts open
# on ${defaultBranch}; on a pull request, new results on the lines it changes become
# review comments and the Code scanning check.
# https://docs.g1t.sh/guides/security/code-scanning/
name: Code scanning

on:
  push:
    branches: [${JSON.stringify(defaultBranch)}]
  pull_request:
  schedule:
    - cron: "27 4 * * 1"

jobs:
  scan:
    name: Code scanning
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      G1T_TOKEN: \${{ secrets.G1T_TOKEN }}
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
          file="$1"; category="$2"; dir="\${3:-.}"
          if [ "$dir" != "." ]; then
            jq --arg prefix "$dir/" '(.runs[]?.results[]?.locations[]?.physicalLocation.artifactLocation
              | select(.uri != null and (.uri | test("^(/|[A-Za-z][A-Za-z0-9+.-]*:)") | not)) | .uri) |= $prefix + .' \\
              "$file" > "$file.tmp" && mv "$file.tmp" "$file"
          fi
          ref="$GITHUB_REF"
          sha="$GITHUB_SHA"
          if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
            ref="refs/pull/$(jq -r .number "$GITHUB_EVENT_PATH")/head"
            sha="$(jq -r '.pull_request.head.sha // env.GITHUB_SHA' "$GITHUB_EVENT_PATH")"
          fi
          gzip -c "$file" | base64 -w0 > "$file.b64"
          jq -n --arg sha "$sha" --arg ref "$ref" --arg checkout "file://$GITHUB_WORKSPACE" --arg category "$category" --rawfile sarif "$file.b64" \\
            '{commit_sha: $sha, ref: $ref, sarif: $sarif, checkout_uri: $checkout, category: $category}' > "$file.json"
          curl --fail-with-body -sS -X POST "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/code-scanning/sarifs" \\
            -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" --data @"$file.json"
          echo
          SCRIPT
          chmod +x /tmp/upload-sarif

      - name: Python (Bandit)
        if: steps.languages.outputs.python == 'true'
        run: |
          python3 -m venv /tmp/bandit && /tmp/bandit/bin/pip install --quiet "bandit[sarif]"
          /tmp/bandit/bin/bandit --recursive . --exclude ./.git,./node_modules,./.venv,./venv \\
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
          npm install --prefix /tmp/eslint --no-audit --no-fund --silent \\
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
          /tmp/eslint/node_modules/.bin/eslint --config /tmp/eslint/eslint.config.mjs --no-warn-ignored \\
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
`;
}

/** The pull request that adds it. */
export function codeScanningPullBody(defaultBranch: string): string {
  return [
    `This adds \`.g1t/workflows/code-scanning.yml\`, which scans each language the repository has, on every pull request, every push to \`${defaultBranch}\` and weekly: [Bandit](https://bandit.readthedocs.io) for Python, [gosec](https://securego.io) for Go, [ESLint](https://eslint.org) with [eslint-plugin-security](https://www.npmjs.com/package/eslint-plugin-security) for JavaScript and TypeScript, and [Clippy](https://doc.rust-lang.org/clippy/) for Rust. Each language's results are uploaded to g1t as SARIF under their own category.`,
    "",
    `- On \`${defaultBranch}\`, each result opens a code scanning alert on the Security page; one no longer reported is fixed.`,
    "- On a pull request, results new to it on the lines it changes are left as review comments, and the **Code scanning** check fails at the threshold set in the repository's Security settings. Require that check in branch protection to block merges on it.",
    "",
    "Change the rules, or add another tool that writes SARIF with its own category, in the workflow. Merge this to start.",
  ].join("\n");
}
