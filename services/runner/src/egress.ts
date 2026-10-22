/**
 * What a sandbox's guardrails come to inside it, and the host names its
 * outbound requests are compared by. Pure, so it can be tested on its
 * own; guard.ts applies it.
 *
 * Every sandbox reaches the internet, as a CI machine does. Its requests
 * go straight out, except where the Worker has to see them: a workflow
 * job that may be given brokered secrets sends its HTTP and HTTPS through
 * the Worker (Cloudflare Containers' outbound interception), which fills
 * the secrets in (broker-egress.ts), and every sandbox's report that it
 * stopped itself for mining (`ABUSE_HOST`) is answered by its own Durable
 * Object.
 */

import type { Guardrails } from "@g1t/contracts";

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
 * Whether `host` is on the list. `example.com` matches exactly that host;
 * `*.example.com` matches its subdomains, at any depth, but not
 * `example.com` itself. Used for the hosts a brokered secret is for.
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

/**
 * The variables a sandbox whose HTTPS passes the Worker needs, so that its
 * programs trust the certificate HTTPS is re-signed with there. The runner
 * adds that certificate to the system's store when it starts; these point
 * the tools that keep their own list at it.
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

/** What a sandbox's guardrails come to for one run. */
export type RunGuard = {
  policy: Guardrails;
  /** The time cap of this kind of run, in minutes. */
  minutes: number;
};

/** What the harness is told about the run's guardrails. */
export function harnessEnv(guard: RunGuard, sandboxEnv: Record<string, string>): Record<string, string> {
  return {
    GUARDRAILS: JSON.stringify({
      minutes: guard.minutes,
      defaultBranch: sandboxEnv.UPSTREAM_BRANCH ?? null,
    }),
  };
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
 * Whether a workflow job gets a Docker Engine of its own, from the
 * Worker's `DOCKER` setting: on unless it says `off`. Its containers share
 * the job's network.
 */
export function dockerFor(setting: string | undefined): "on" | "off" {
  return setting?.trim().toLowerCase() === "off" ? "off" : "on";
}

/**
 * Whether a sandbox sends its HTTP and HTTPS through the Worker: only a
 * workflow job that may be given brokered secrets, so they can be filled
 * in, and not when the operator turned that off (`EGRESS` is `off`).
 * Every other sandbox's requests go straight out.
 */
export function throughWorker(job: { brokered?: boolean } | null | undefined, setting: string | undefined): boolean {
  return job?.brokered === true && setting?.trim().toLowerCase() !== "off";
}

/**
 * The Durable Object namespace behind each sandbox class, by its binding:
 * a sandbox's outbound handlers are told its class, and report back to its
 * own object. Each label in the machine catalogue (`INSTANCE_TYPES`) has a
 * class of its own (wrangler.jsonc), named by its `sandboxClass`.
 */
export const SANDBOX_BINDINGS: Record<string, string> = {
  AttemptSandbox: "SANDBOX",
  SandboxSlim: "SANDBOX_SLIM",
};

/** The namespace of a sandbox of `className`; the standard one when unknown. */
export function sandboxNamespace(env: object, className: string | undefined): DurableObjectNamespace {
  const bindings = env as Record<string, DurableObjectNamespace | undefined>;
  const binding = (className && SANDBOX_BINDINGS[className]) || "SANDBOX";
  return (bindings[binding] ?? bindings.SANDBOX) as DurableObjectNamespace;
}

/**
 * The namespace a workflow job on `instance` starts in: its catalogue class's
 * binding. Null when the class or its binding is missing here (a self-hosted
 * g1t that did not deploy that class), so the job says so rather than
 * running on another machine.
 */
export function jobNamespaceOf(env: object, instance: { sandboxClass: string }): DurableObjectNamespace | null {
  const binding = SANDBOX_BINDINGS[instance.sandboxClass];
  return (binding && (env as Record<string, DurableObjectNamespace | undefined>)[binding]) || null;
}

/** The lower of two caps, where null, zero or less means no cap. */
function lower(a: number | null | undefined, b: number | null | undefined): number | null {
  const caps = [a, b].filter((cap): cap is number => typeof cap === "number" && Number.isFinite(cap) && cap > 0);
  return caps.length ? Math.min(...caps) : null;
}

/** A plan's cap on one run, from its entitlements; null where it sets none. */
export type PlanLimits = { minutes?: number | null };

/** A run's guardrails under its workspace's plan: the time cap is the lower of the two. */
export function withPlanLimits(guard: RunGuard, limits: PlanLimits | null | undefined): RunGuard {
  if (!limits) return guard;
  return { policy: guard.policy, minutes: lower(guard.minutes, limits.minutes) ?? guard.minutes };
}
