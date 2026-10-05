/**
 * Cloudflare for SaaS: custom hostnames on the g1t.page zone. A hostname
 * someone points at `domains.g1t.page` is added here; Cloudflare checks
 * they own it, issues its certificate, and sends its traffic through the
 * zone, where the dispatcher's `*\/*` route serves it.
 *
 * The token needs SSL and Certificates: Edit on the zone, beside what the
 * service's token already holds. Until Cloudflare for SaaS is turned on for
 * the zone, Cloudflare answers with codes 1404 or 1456; that is reported as
 * `NotEnabled`, so callers can say so instead of failing.
 *
 * Kept free of imports so its tests run on Node as they are.
 */

const API = "https://api.cloudflare.com/client/v4";

/** Cloudflare's codes for a zone without Cloudflare for SaaS. */
const NOT_ENABLED_CODES = new Set([1404, 1456]);

/** Thrown while Cloudflare for SaaS is not turned on for the zone. */
export class NotEnabled extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotEnabled";
  }
}

/** Cloudflare refused, with its codes. */
export class Refused extends Error {
  readonly status: number;
  readonly codes: number[];
  constructor(message: string, status: number, codes: number[]) {
    super(message);
    this.name = "Refused";
    this.status = status;
    this.codes = codes;
  }
}

/** A record the domain's owner adds at their DNS provider. */
export type DnsRecord = {
  type: "CNAME" | "TXT" | "ALIAS";
  /** The record's full name. */
  name: string;
  value: string;
  /** What it is for, in a few words. */
  purpose: string;
};

/** A custom hostname as Cloudflare answers with it, the fields used. */
export type CustomHostname = {
  id: string;
  hostname: string;
  status: string;
  ssl?: {
    status?: string;
    method?: string;
    validation_records?: { txt_name?: string; txt_value?: string; cname?: string; cname_target?: string; http_url?: string; http_body?: string }[];
    validation_errors?: { message: string }[];
  };
  ownership_verification?: { type?: string; name?: string; value?: string };
  verification_errors?: string[];
};

export type DomainStatus = "pending" | "verifying" | "active" | "failed";

/** Cloudflare's view of a hostname, as a domain's status and what to show. */
export function statusOf(found: CustomHostname): { status: DomainStatus; ssl: string | null; error: string | null } {
  const ssl = found.ssl?.status ?? null;
  const errors = [...(found.verification_errors ?? []), ...(found.ssl?.validation_errors ?? []).map((e) => e.message)];
  const error = errors.length ? errors.join(" ") : null;
  if (["blocked", "moved", "deleted"].includes(found.status)) return { status: "failed", ssl, error: error ?? `Cloudflare marked it ${found.status}.` };
  if (ssl && ["validation_timed_out", "issuance_timed_out", "expired", "deleted"].includes(ssl)) {
    return { status: "failed", ssl, error: error ?? "The certificate could not be issued in time. Check the records, then check again." };
  }
  if (found.status === "active" && ssl === "active") return { status: "active", ssl, error: null };
  if (found.status === "active") return { status: "verifying", ssl, error };
  return { status: "pending", ssl, error };
}

/**
 * The records Cloudflare asks for: the TXT that proves ownership before
 * traffic moves, and any TXT or CNAME the certificate's validation needs.
 * HTTP validation needs nothing in DNS: Cloudflare answers it once the
 * hostname points here.
 */
export function recordsOf(found: CustomHostname): DnsRecord[] {
  const records: DnsRecord[] = [];
  const own = found.ownership_verification;
  if (own?.name && own.value) {
    records.push({ type: "TXT", name: own.name, value: own.value, purpose: "Proves you own the domain" });
  }
  for (const record of found.ssl?.validation_records ?? []) {
    if (record.txt_name && record.txt_value) {
      records.push({ type: "TXT", name: record.txt_name, value: record.txt_value, purpose: "Validates the certificate" });
    }
    if (record.cname && record.cname_target) {
      records.push({ type: "CNAME", name: record.cname, value: record.cname_target, purpose: "Validates the certificate" });
    }
  }
  return records;
}

export class CustomHostnames {
  private readonly token: string;
  private readonly zone: string;
  constructor(token: string, zone: string) {
    this.token = token;
    this.zone = zone;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}/zones/${this.zone}/custom_hostnames${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const answer = (await response.json().catch(() => null)) as {
      success?: boolean;
      result?: T;
      errors?: { code: number; message: string }[];
    } | null;
    if (!response.ok || !answer?.success) {
      const errors = answer?.errors ?? [];
      const why = errors.map((error) => `${error.message} (${error.code})`).join("; ") || "no reason given";
      if (errors.some((error) => NOT_ENABLED_CODES.has(error.code)) || /ssl for saas|not.*(entitled|provisioned)/i.test(why)) {
        throw new NotEnabled(why);
      }
      throw new Refused(`Cloudflare answered ${response.status}: ${why}`, response.status, errors.map((e) => e.code));
    }
    return answer.result as T;
  }

  /** Adds `hostname`, with a certificate validated over HTTP once it points here. */
  async create(hostname: string, metadata: Record<string, string>): Promise<CustomHostname> {
    return this.call<CustomHostname>("POST", "", {
      hostname,
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
      custom_metadata: metadata,
    });
  }

  async get(id: string): Promise<CustomHostname> {
    return this.call<CustomHostname>("GET", `/${encodeURIComponent(id)}`);
  }

  /** The hostname, if it is on the zone already, as when an add half-finished. */
  async find(hostname: string): Promise<CustomHostname | null> {
    const found = await this.call<CustomHostname[]>("GET", `?hostname=${encodeURIComponent(hostname)}`);
    return found.find((h) => h.hostname === hostname) ?? null;
  }

  /** Asks Cloudflare to check the hostname again now: a PATCH with its SSL settings. */
  async recheck(id: string): Promise<CustomHostname> {
    return this.call<CustomHostname>("PATCH", `/${encodeURIComponent(id)}`, {
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    });
  }

  /** Removes it. Already gone is fine. */
  async delete(id: string): Promise<void> {
    try {
      await this.call("DELETE", `/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof Refused && error.status === 404) return;
      throw error;
    }
  }
}
