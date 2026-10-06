/**
 * Custom domains: a project's production served at a hostname of its own,
 * such as `example.com` or `www.example.com`, beside its address on
 * g1t.page.
 *
 * Each hostname is a Cloudflare for SaaS custom hostname on the g1t.page
 * zone. Its owner points it at `domains.g1t.page` (a CNAME, or a flattened
 * CNAME at the apex); Cloudflare checks it, issues its certificate, and
 * sends its traffic to the dispatcher, which reads the `DOMAINS` KV
 * namespace to find the app: `{ script, redirect }` under the hostname.
 *
 * A domain maps to the project, not to a build: production redeploys
 * leave it alone, and the KV entry follows the production script if its
 * name ever changes (see `follow`).
 *
 * Until Cloudflare for SaaS is switched on for the zone, domains are kept
 * as pending with a note saying so, and the sweep adds them at Cloudflare
 * the moment it is.
 */

import { CUSTOM_DOMAIN_TARGET, newId, type Domain, type DomainRecord, type DomainStatus } from "@g1t/contracts";

import { CustomHostnames, NotEnabled, Refused, recordsOf, statusOf, type CustomHostname } from "./custom-hostnames";
import { checkHostname, isApex, twinOf } from "./hostname";

/** What the UI says while Cloudflare for SaaS is not on for the zone yet. */
export const NOT_ENABLED_NOTICE =
  "Custom domains are being switched on for g1t.page. Domains you add now are kept, and set up by themselves the moment they are.";

/** A project has at most this many hostnames. */
const PER_PROJECT = 20;
/** How long the answer to "is it switched on" is trusted, in this isolate. */
const AVAILABILITY_TTL_MS = 5 * 60 * 1000;
/** An active domain is checked again this often, in case its DNS moved away. */
const RECHECK_ACTIVE_MS = 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 100;
/** A pending domain is read again from Cloudflare when the page is, at most this often. */
const CATCH_UP_MS = 10 * 1000;

let availability: { at: number; available: boolean } | null = null;

export type DomainRow = {
  id: string;
  project_id: string;
  workspace: string;
  slug: string;
  hostname: string;
  target: string;
  cf_hostname_id: string | null;
  status: DomainStatus;
  ssl_status: string | null;
  records: string;
  redirect_to: string | null;
  script: string | null;
  error: string | null;
  created_by: string;
  created_at: string;
  verified_at: string | null;
  checked_at: string | null;
};

const now = () => new Date().toISOString();

/** The record that sends a hostname's traffic to g1t. */
export function routingRecord(hostname: string): DomainRecord {
  return isApex(hostname)
    ? { type: "ALIAS", name: hostname, value: CUSTOM_DOMAIN_TARGET, purpose: "Sends traffic to your app (a flattened CNAME, or ALIAS)" }
    : { type: "CNAME", name: hostname, value: CUSTOM_DOMAIN_TARGET, purpose: "Sends traffic to your app" };
}

export function toDomain(row: DomainRow): Domain {
  return {
    id: row.id,
    hostname: row.hostname,
    target: "production",
    status: row.status,
    sslStatus: row.ssl_status,
    apex: isApex(row.hostname),
    records: [routingRecord(row.hostname), ...(JSON.parse(row.records || "[]") as DomainRecord[])],
    redirectTo: row.redirect_to,
    error: row.error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

/** What the dispatcher reads under a hostname. */
export type DomainEntry = { script: string; redirect: string | null; project: string };

export class Domains {
  constructor(
    private readonly db: D1Database,
    private readonly kv: KVNamespace | undefined,
    private readonly hostnames: CustomHostnames | null,
  ) {}

  /**
   * The project's domains still on their way to active, read again from
   * Cloudflare if not read in the last few seconds: what keeps the page's
   * live view moving between sweeps.
   */
  async catchUp(projectId: string): Promise<void> {
    const since = new Date(Date.now() - CATCH_UP_MS).toISOString();
    const rows = await this.db
      .prepare(
        `SELECT * FROM domains WHERE project_id = ? AND status IN ('pending', 'verifying')
           AND cf_hostname_id IS NOT NULL AND COALESCE(checked_at, '') < ? LIMIT 5`,
      )
      .bind(projectId, since)
      .all<DomainRow>();
    await Promise.all(rows.results.map((row) => (row.script ? this.refresh(row, row.script) : null)));
  }

  async forProject(projectId: string): Promise<DomainRow[]> {
    const rows = await this.db
      .prepare("SELECT * FROM domains WHERE project_id = ? ORDER BY redirect_to IS NOT NULL, created_at")
      .bind(projectId)
      .all<DomainRow>();
    return rows.results;
  }

  /** The workspace's custom domains that Cloudflare holds, which are what is charged. */
  async countFor(workspace: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM domains WHERE workspace = ? AND cf_hostname_id IS NOT NULL")
      .bind(workspace)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** The first active domain that serves the app itself. */
  async primary(projectId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT hostname FROM domains WHERE project_id = ? AND status = 'active' AND redirect_to IS NULL
         ORDER BY created_at LIMIT 1`,
      )
      .bind(projectId)
      .first<{ hostname: string }>();
    return row?.hostname ?? null;
  }

  /** Whether Cloudflare for SaaS is on for the zone, asked at most every few minutes. */
  async available(): Promise<boolean> {
    if (!this.hostnames) return false;
    if (availability && Date.now() - availability.at < AVAILABILITY_TTL_MS) return availability.available;
    let available = true;
    try {
      await this.hostnames.find("probe.invalid");
    } catch (error) {
      if (error instanceof NotEnabled) available = false;
      else console.error("could not ask whether custom hostnames are on", error);
    }
    availability = { at: Date.now(), available };
    return available;
  }

  /**
   * Adds `input` for the project's production, and with `twin` its www or
   * apex twin, redirecting to it. Answers with what was added, or why not.
   */
  async add(input: {
    project: { id: string; workspace: string; slug: string };
    script: string;
    hostname: string;
    twin: boolean;
    by: string;
  }): Promise<{ ok: true; rows: DomainRow[] } | { ok: false; code: "invalid" | "conflict"; message: string }> {
    const checked = checkHostname(input.hostname);
    if (!checked.ok) return { ok: false, code: "invalid", message: checked.reason };
    const hostname = checked.hostname;
    const twin = input.twin ? twinOf(hostname) : null;
    if (input.twin && !twin) {
      return { ok: false, code: "invalid", message: "Only a domain and its www subdomain can be paired. Add other subdomains on their own." };
    }
    const wanted = twin ? [hostname, twin] : [hostname];
    const taken = await this.db
      .prepare(`SELECT hostname, project_id FROM domains WHERE hostname IN (${wanted.map(() => "?").join(", ")})`)
      .bind(...wanted)
      .all<{ hostname: string; project_id: string }>();
    const fresh = wanted.filter((h) => !taken.results.some((t) => t.hostname === h));
    const elsewhere = taken.results.find((t) => t.project_id !== input.project.id);
    if (elsewhere) return { ok: false, code: "conflict", message: `${elsewhere.hostname} is already in use on g1t.` };
    if (!fresh.includes(hostname) && !twin) return { ok: false, code: "conflict", message: `${hostname} is already added to this project.` };
    const count = await this.db
      .prepare("SELECT COUNT(*) AS n FROM domains WHERE project_id = ?")
      .bind(input.project.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) + fresh.length > PER_PROJECT) {
      return { ok: false, code: "conflict", message: `A project can have up to ${PER_PROJECT} domains.` };
    }

    const at = now();
    const added: DomainRow[] = [];
    for (const name of fresh) {
      const row: DomainRow = {
        id: newId("dom"),
        project_id: input.project.id,
        workspace: input.project.workspace,
        slug: input.project.slug,
        hostname: name,
        target: "production",
        cf_hostname_id: null,
        status: "pending",
        ssl_status: null,
        records: "[]",
        redirect_to: name === hostname ? null : hostname,
        script: null,
        error: null,
        created_by: input.by,
        created_at: at,
        verified_at: null,
        checked_at: null,
      };
      try {
        await this.db
          .prepare(
            `INSERT INTO domains (id, project_id, workspace, slug, hostname, target, status, records, redirect_to, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, 'production', 'pending', '[]', ?, ?, ?)`,
          )
          .bind(row.id, row.project_id, row.workspace, row.slug, row.hostname, row.redirect_to, row.created_by, row.created_at)
          .run();
      } catch (error) {
        if (/UNIQUE/i.test(String(error))) return { ok: false, code: "conflict", message: `${name} is already in use on g1t.` };
        throw error;
      }
      await this.point(row, input.script);
      added.push(await this.register(row, input.script));
    }
    // Pairing with a domain the project already had: it now redirects too.
    if (twin && !fresh.includes(twin)) {
      await this.db
        .prepare("UPDATE domains SET redirect_to = ? WHERE hostname = ? AND project_id = ?")
        .bind(hostname, twin, input.project.id)
        .run();
      const row = await this.byHostname(twin);
      if (row) await this.point(row, input.script);
    }
    return { ok: true, rows: added };
  }

  private async byHostname(hostname: string): Promise<DomainRow | null> {
    return this.db.prepare("SELECT * FROM domains WHERE hostname = ?").bind(hostname).first<DomainRow>();
  }

  async byId(projectId: string, id: string): Promise<DomainRow | null> {
    return this.db.prepare("SELECT * FROM domains WHERE id = ? AND project_id = ?").bind(id, projectId).first<DomainRow>();
  }

  /** Writes what the dispatcher reads for the hostname, and remembers the script it names. */
  private async point(row: DomainRow, script: string): Promise<void> {
    const entry: DomainEntry = { script, redirect: row.redirect_to, project: row.project_id };
    await this.kv?.put(row.hostname, JSON.stringify(entry));
    await this.db.prepare("UPDATE domains SET script = ? WHERE id = ?").bind(script, row.id).run();
  }

  /**
   * Adds the hostname at Cloudflare, or finds it there from an add that
   * half-finished, and records what Cloudflare asks for. While Cloudflare
   * for SaaS is off, the row stays pending with a note.
   */
  private async register(row: DomainRow, script: string): Promise<DomainRow> {
    if (!this.hostnames) {
      return this.note(row, "Custom domains are not set up on this g1t: it has no Cloudflare token or zone.");
    }
    let found: CustomHostname;
    try {
      found =
        (await this.hostnames.find(row.hostname)) ??
        (await this.hostnames.create(row.hostname, { script, project: row.project_id, domain: row.id }));
    } catch (error) {
      if (error instanceof NotEnabled) {
        availability = { at: Date.now(), available: false };
        return this.note(row, NOT_ENABLED_NOTICE);
      }
      if (error instanceof Refused && error.status < 500) {
        return this.save(row, { status: "failed", error: error.message.replace(/^Cloudflare answered \d+: /, "Cloudflare refused it: ") });
      }
      console.error("could not add custom hostname", row.hostname, error);
      return this.note(row, "Cloudflare could not be reached; it is tried again in a few minutes.");
    }
    availability = { at: Date.now(), available: true };
    await this.db.prepare("UPDATE domains SET cf_hostname_id = ? WHERE id = ?").bind(found.id, row.id).run();
    return this.apply({ ...row, cf_hostname_id: found.id }, found);
  }

  private async note(row: DomainRow, error: string): Promise<DomainRow> {
    return this.save(row, { status: "pending", error });
  }

  private async save(row: DomainRow, changes: Partial<DomainRow>): Promise<DomainRow> {
    const next = { ...row, ...changes, checked_at: now() };
    await this.db
      .prepare(
        `UPDATE domains SET status = ?, ssl_status = ?, records = ?, error = ?, verified_at = ?, checked_at = ? WHERE id = ?`,
      )
      .bind(next.status, next.ssl_status, next.records, next.error, next.verified_at, next.checked_at, row.id)
      .run();
    return next;
  }

  /** Cloudflare's view of the hostname, onto its row. */
  private async apply(row: DomainRow, found: CustomHostname): Promise<DomainRow> {
    const seen = statusOf(found);
    return this.save(row, {
      status: seen.status,
      ssl_status: seen.ssl,
      records: JSON.stringify(recordsOf(found)),
      error: seen.status === "active" ? null : seen.error,
      verified_at: seen.status === "active" ? (row.verified_at ?? now()) : row.verified_at,
    });
  }

  /**
   * Reads the domain's state from Cloudflare; with `recheck`, first asks
   * Cloudflare to check its DNS and certificate again now.
   */
  async refresh(row: DomainRow, script: string, recheck = false): Promise<DomainRow> {
    if (!row.cf_hostname_id) return this.register(row, script);
    if (!this.hostnames) return row;
    try {
      const found =
        recheck && row.status !== "active"
          ? await this.hostnames.recheck(row.cf_hostname_id)
          : await this.hostnames.get(row.cf_hostname_id);
      return this.apply(row, found);
    } catch (error) {
      if (error instanceof Refused && error.status === 404) {
        // Gone at Cloudflare: add it again.
        await this.db.prepare("UPDATE domains SET cf_hostname_id = NULL WHERE id = ?").bind(row.id).run();
        return this.register({ ...row, cf_hostname_id: null }, script);
      }
      if (error instanceof NotEnabled) return this.note(row, NOT_ENABLED_NOTICE);
      console.error("could not check custom hostname", row.hostname, error);
      return row;
    }
  }

  /**
   * Removes the domain, and any of the project's domains redirecting to it:
   * from the dispatcher at once, then from Cloudflare. A removal Cloudflare
   * does not take now is left `removing`, for the sweep to finish.
   */
  async remove(row: DomainRow): Promise<void> {
    const redirecting = await this.db
      .prepare("SELECT * FROM domains WHERE project_id = ? AND redirect_to = ?")
      .bind(row.project_id, row.hostname)
      .all<DomainRow>();
    for (const target of [row, ...redirecting.results]) await this.drop(target);
  }

  private async drop(row: DomainRow): Promise<void> {
    await this.kv?.delete(row.hostname);
    if (row.cf_hostname_id) {
      try {
        if (!this.hostnames) throw new Error("no Cloudflare token");
        await this.hostnames.delete(row.cf_hostname_id);
      } catch (error) {
        console.error("could not remove custom hostname; the sweep tries again", row.hostname, error);
        await this.db.prepare("UPDATE domains SET status = 'removing' WHERE id = ?").bind(row.id).run();
        return;
      }
    }
    await this.db.prepare("DELETE FROM domains WHERE id = ?").bind(row.id).run();
  }

  /** Every domain of the project's, removed: its deployments were turned off for good, or its plan ended. */
  async removeWhere(column: "project_id" | "workspace", value: string): Promise<void> {
    const rows = await this.db.prepare(`SELECT * FROM domains WHERE ${column} = ?`).bind(value).all<DomainRow>();
    for (const row of rows.results) await this.drop(row);
  }

  /**
   * Production is up under `script`: the project's domains serve it. Only
   * entries naming another script are written, so a redeploy under the
   * same name writes nothing.
   */
  async follow(projectId: string, script: string): Promise<void> {
    const rows = await this.db
      .prepare("SELECT * FROM domains WHERE project_id = ? AND status != 'removing' AND script IS NOT ?")
      .bind(projectId, script)
      .all<DomainRow>();
    for (const row of rows.results) await this.point(row, script);
  }

  /**
   * From the sweep: domains not yet at Cloudflare are added (as soon as
   * custom hostnames are switched on), pending ones are checked, active
   * ones now and then, and removals that failed are tried again.
   */
  async sweep(productionScript: (projectId: string) => Promise<string | null>): Promise<void> {
    const recheck = new Date(Date.now() - RECHECK_ACTIVE_MS).toISOString();
    const rows = await this.db
      .prepare(
        `SELECT * FROM domains
         WHERE status IN ('pending', 'verifying', 'removing')
            OR (status = 'active' AND COALESCE(checked_at, '') < ?)
         ORDER BY checked_at IS NOT NULL, checked_at LIMIT ?`,
      )
      .bind(recheck, SWEEP_LIMIT)
      .all<DomainRow>();
    let enabled = true;
    for (const row of rows.results) {
      try {
        if (row.status === "removing") {
          await this.drop(row);
          continue;
        }
        if (!row.cf_hostname_id && !enabled) continue;
        const script = row.script ?? (await productionScript(row.project_id));
        if (!script) continue;
        const after = await this.refresh(row, script);
        if (!after.cf_hostname_id && after.error === NOT_ENABLED_NOTICE) enabled = false;
      } catch (error) {
        console.error("could not sweep domain", row.hostname, error);
      }
    }
  }

  /** The workspace's slug changed; the rows follow. Their KV entries name scripts, which `follow` moves. */
  rename(from: string, to: string): D1PreparedStatement {
    return this.db.prepare("UPDATE domains SET workspace = ?1 WHERE workspace = ?2").bind(to, from);
  }
}
