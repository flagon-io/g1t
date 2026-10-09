/**
 * Which hosts a sandbox may reach, and what its guardrails come to inside
 * it. Pure, so it can be tested on its own; guard.ts applies it.
 *
 * A guarded sandbox starts with no internet. Every HTTP and HTTPS request
 * it makes is handed to the runner Worker (Cloudflare Containers' outbound
 * interception), which asks `allows` here and either forwards the request
 * or refuses it with `refusal`. Other protocols and ports have no route
 * out at all.
 */

import type { Guardrails, WorkflowDomain } from "@g1t/contracts";

/** A host name as it is compared: lower case, no port, no trailing dot. */
export function normalizeHost(host: string): string {
  let name = host.trim().toLowerCase();
  // An IPv6 literal keeps its colons.
  if (name.startsWith("[")) return name.slice(0, name.indexOf("]") + 1);
  const colon = name.indexOf(":");
  if (colon >= 0) name = name.slice(0, colon);
  return name.replace(/\.+$/, "");
}

/**
 * Whether `host` is on the list. `example.com` allows exactly that host;
 * `*.example.com` allows its subdomains, at any depth, but not
 * `example.com` itself.
 */
export function allows(patterns: readonly string[], host: string): boolean {
  const name = normalizeHost(host);
  if (!name) return false;
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return name.length > suffix.length && name.endsWith(suffix);
    }
    return pattern === name;
  });
}

/** The host of a URL, or null if it is not one. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return normalizeHost(new URL(url).host);
  } catch {
    return null;
  }
}

/** Where the runner sends model traffic, which the sandbox must reach. */
export type ModelHosts = {
  MODELS_URL?: string;
  AI_GATEWAY_ID?: string;
  ANTHROPIC_API_KEY?: string;
};

/**
 * Every host a guarded sandbox may reach: the guardrails' list, plus where
 * this deployment sends model traffic and g1t's tools, which no setting
 * can take away.
 */
export function sandboxHosts(policy: readonly string[], env: ModelHosts, sandboxEnv: Record<string, string>): string[] {
  const hosts = new Set(policy.map((host) => host.trim().toLowerCase()).filter(Boolean));
  for (const url of [env.MODELS_URL, sandboxEnv.ANTHROPIC_BASE_URL, sandboxEnv.G1T_API, sandboxEnv.G1T_MCP, sandboxEnv.GIT_REMOTE]) {
    const host = hostOf(url);
    if (host) hosts.add(host);
  }
  // A deployment without the model proxy sends model traffic to the
  // gateway, or straight to the provider.
  if (!env.MODELS_URL && env.AI_GATEWAY_ID) hosts.add("gateway.ai.cloudflare.com");
  if (!env.MODELS_URL && !env.AI_GATEWAY_ID && env.ANTHROPIC_API_KEY) hosts.add("api.anthropic.com");
  return [...hosts];
}

/** What a refused request gets back, so the agent knows why. */
export function refusal(host: string): Response {
  const name = normalizeHost(host);
  return new Response(
    `g1t guardrails: ${name} is not on this project's allowed domains, so this sandbox cannot reach it. ` +
      "A member can allow it under the project's Settings, Guardrails.\n",
    { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "x-g1t-guardrails": "blocked" } },
  );
}

/** A refused host as a step of the run. */
export function blockedStep(host: string): string {
  return `Blocked: ${normalizeHost(host)} (not an allowed domain)`;
}

/**
 * The variables a guarded sandbox needs so that its programs trust the
 * certificate HTTPS is re-signed with as it passes through the Worker.
 * The runner adds that certificate to the system's store when it starts;
 * these point the tools that keep their own list at it.
 */
export const EGRESS_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
export const EGRESS_ENV: Record<string, string> = {
  G1T_EGRESS_CA: EGRESS_CA,
  NODE_EXTRA_CA_CERTS: EGRESS_CA,
  SSL_CERT_FILE: SYSTEM_BUNDLE,
  REQUESTS_CA_BUNDLE: SYSTEM_BUNDLE,
  PIP_CERT: SYSTEM_BUNDLE,
  CURL_CA_BUNDLE: SYSTEM_BUNDLE,
  CARGO_HTTP_CAINFO: SYSTEM_BUNDLE,
  GIT_SSL_CAINFO: SYSTEM_BUNDLE,
};

/**
 * Tools that report usage home by default, told not to: in a guarded
 * sandbox the report would only be refused, and a refused host is noted on
 * the run. `DO_NOT_TRACK` is the convention many tools follow; the rest are
 * the tools' own switches.
 */
export const QUIET_ENV: Record<string, string> = {
  DO_NOT_TRACK: "1",
  WRANGLER_SEND_METRICS: "false",
  NEXT_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  NUXT_TELEMETRY_DISABLED: "1",
  GATSBY_TELEMETRY_DISABLED: "1",
  STORYBOOK_DISABLE_TELEMETRY: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  HOMEBREW_NO_ANALYTICS: "1",
  CHECKPOINT_DISABLE: "1",
};

/** What a sandbox's guardrails come to for one run. */
export type RunGuard = {
  policy: Guardrails;
  /** The time cap of this kind of run, in minutes. */
  minutes: number;
};

/** The most refused hosts reported as steps of one run. */
const MAX_BLOCKED_REPORTED = 25;

/** What the harness is told about the run's guardrails. */
export function harnessEnv(guard: RunGuard, sandboxEnv: Record<string, string>, restricted: boolean): Record<string, string> {
  const vars: Record<string, string> = {
    GUARDRAILS: JSON.stringify({
      rules: guard.policy.rules,
      deny: guard.policy.deny,
      budgetUsd: guard.policy.budgetUsd,
      minutes: guard.minutes,
      restrictNetwork: restricted,
      defaultBranch: sandboxEnv.UPSTREAM_BRANCH ?? null,
    }),
  };
  return restricted ? { ...vars, ...EGRESS_ENV, ...QUIET_ENV } : vars;
}

/**
 * Records a refused host as a step of the run, once per host. `seen` is
 * the hosts reported so far, kept by the sandbox.
 */
export function newlyBlocked(seen: readonly string[], host: string): { step: string; seen: string[] } | null {
  const step = blockedStep(host);
  if (seen.includes(step) || seen.length >= MAX_BLOCKED_REPORTED) return null;
  return { step, seen: [...seen, step] };
}

/** What a run stopped by its time cap is told. */
export function timeCapMessage(minutes: number): string {
  return `Stopped: it reached its time cap of ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/**
 * Where a sandbox tells the runner it stopped itself for mining
 * (crates/runner abuse.rs). The runner's Durable Object answers it; it
 * never leaves the machine.
 */
export const ABUSE_HOST = "sandbox.g1t.internal";
/** What a sandbox that stopped itself for mining exits with. */
export const ABUSE_EXIT_CODE = 86;
/** What such a run, check, job or build says. */
export const ABUSE_MESSAGE = "Stopped: unusual CPU use; contact support if this was a real job.";

/**
 * What workflow jobs and deploy builds may reach on top of the project's
 * allowed domains and registries: where `actions/checkout`, `uses:`
 * actions and the `setup-*` actions fetch from, the package registries
 * builds install from, the public container registries a job's Docker
 * Engine pulls images from (crates/runner docker/), and (for deploys)
 * Cloudflare's API, which a build uploads its app to. No mining pool is on
 * it, and no general host.
 */
export const BUILD_HOSTS: readonly string[] = [
  // Actions by `uses:`, and releases the setup actions download.
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "ghcr.io",
  "pkg-containers.githubusercontent.com",
  // Toolchains.
  "nodejs.org",
  "go.dev",
  "dl.google.com",
  "static.rust-lang.org",
  "sh.rustup.rs",
  // Package registries, whatever the project turned on for agents.
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "index.rubygems.org",
  "repo.packagist.org",
  "api.nuget.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "services.gradle.org",
  "plugins.gradle.org",
  "deb.debian.org",
  "security.debian.org",
  // Container images, for a job's own Docker Engine: Docker Hub (and the
  // CDN its layers come from), Google's public mirror of it, which the
  // Engine asks first, and Quay. GitHub's registry is above.
  "registry-1.docker.io",
  "auth.docker.io",
  "index.docker.io",
  "production.cloudflare.docker.com",
  "production.cloudfront.docker.com",
  "mirror.gcr.io",
  "quay.io",
  "cdn01.quay.io",
  "cdn02.quay.io",
  "cdn03.quay.io",
  // Docker's own packages (apt), for images that install the CLI.
  "download.docker.com",
];

/**
 * Whether a workflow job gets a Docker Engine of its own, from the
 * Worker's `DOCKER` setting: on unless it says `off`. Its containers share
 * the job's network, so the hosts above, and its guardrails, are theirs too.
 */
export function dockerFor(setting: string | undefined): "on" | "off" {
  return setting?.trim().toLowerCase() === "off" ? "off" : "on";
}

/**
 * A workflow job, for the guardrails' workflow-only domains: its workflow
 * file, the environment it names, and whether its run is trusted (not a
 * pull request from a fork). Only a trusted run's jobs get them.
 */
export type WorkflowJob = { workflow: string | null; environment: string | null; trusted: boolean };

/** The file name of a workflow's path: `.g1t/workflows/deploy.yml` is `deploy.yml`. */
function workflowFile(path: string): string {
  return path.trim().split(/[\\/]/).pop() ?? "";
}

/**
 * The workflow-only hosts a job of `workflow` (its path) in `environment`
 * may reach, as `Guardrails::workflow_hosts` decides it: names compare
 * without regard to case, and an empty list of workflows or environments
 * is any.
 */
export function workflowHosts(entries: readonly WorkflowDomain[] | undefined, workflow: string, environment: string | null | undefined): string[] {
  const file = workflowFile(workflow).toLowerCase();
  const env = environment?.trim().toLowerCase() ?? null;
  const hosts: string[] = [];
  for (const entry of entries ?? []) {
    const workflowOk = !entry.workflows.length || entry.workflows.some((w) => workflowFile(w).toLowerCase() === file);
    const envOk = !entry.environments.length || (env != null && entry.environments.some((e) => e.toLowerCase() === env));
    if (workflowOk && envOk && !hosts.includes(entry.domain)) hosts.push(entry.domain);
  }
  return hosts;
}

/**
 * The workflow-only domains a sandbox gets: for a workflow job of a
 * trusted run, those whose workflows and environments include its own.
 * Never for a deploy build, an agent or a pull request from a fork.
 */
export function jobHosts(
  policy: { workflowDomains?: readonly WorkflowDomain[] },
  kind: "actions" | "deploy" | "bump",
  job: WorkflowJob | null | undefined,
): string[] {
  if (kind !== "actions" || !job?.trusted || !job.workflow) return [];
  return workflowHosts(policy.workflowDomains, job.workflow, job.environment);
}

/**
 * The Durable Object namespace behind each sandbox class, by its binding:
 * a sandbox's outbound handlers are told its class, and report back to its
 * own object. Larger machines are classes of their own (wrangler.jsonc).
 */
export const SANDBOX_BINDINGS: Record<string, string> = {
  AttemptSandbox: "SANDBOX",
  Sandbox2Core: "SANDBOX_2CORE",
  Sandbox4Core: "SANDBOX_4CORE",
};

/** The namespace of a sandbox of `className`; the standard one when unknown. */
export function sandboxNamespace(env: object, className: string | undefined): DurableObjectNamespace {
  const bindings = env as Record<string, DurableObjectNamespace | undefined>;
  const binding = (className && SANDBOX_BINDINGS[className]) || "SANDBOX";
  return (bindings[binding] ?? bindings.SANDBOX) as DurableObjectNamespace;
}

/**
 * What a security update's sandbox may reach on top of its project's
 * list: the package registries its lockfile tools resolve versions from
 * (npm, corepack's pnpm and yarn, crates.io, Go's module proxy and
 * checksum database, PyPI), and nothing else. Mode `bump` in
 * crates/runner bump.rs.
 */
export const BUMP_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "pypi.org",
  "files.pythonhosted.org",
];

/** What a build sandbox may reach on top of its project's list. */
export function buildHosts(kind: "actions" | "deploy" | "bump"): string[] {
  if (kind === "bump") return [...BUMP_HOSTS];
  return kind === "deploy" ? [...BUILD_HOSTS, "api.cloudflare.com"] : [...BUILD_HOSTS];
}

/** The lower of two caps, where null, zero or less means no cap. */
function lower(a: number | null | undefined, b: number | null | undefined): number | null {
  const caps = [a, b].filter((cap): cap is number => typeof cap === "number" && Number.isFinite(cap) && cap > 0);
  return caps.length ? Math.min(...caps) : null;
}

/** A plan's caps on one run, from its entitlements; null where it sets none. */
export type PlanLimits = { minutes?: number | null; budgetUsd?: number | null };

/**
 * A run's guardrails under its workspace's plan: the time and cost caps are
 * each the lower of the two.
 */
export function withPlanLimits(guard: RunGuard, limits: PlanLimits | null | undefined): RunGuard {
  if (!limits) return guard;
  return {
    policy: { ...guard.policy, budgetUsd: lower(guard.policy.budgetUsd, limits.budgetUsd) },
    minutes: lower(guard.minutes, limits.minutes) ?? guard.minutes,
  };
}
