import { env } from "cloudflare:workers";

import {
  type StatusAdminApi,
  privacyClient,
  accountsAdminClient,
  billingAdminClient,
  billingClient,
  eventsClient,
  identityAdminClient,
  projectsClient,
  reposAdminClient,
  runnersAdminClient,
  telemetryClient,
  type User,
} from "@g1t/contracts";

/** Staff-only billing, on the billing service. */
export const admin = billingAdminClient(env.BILLING);

/** The public price book, read-only, from the same service. */
export const priceBook = () => billingClient(env.BILLING).prices();

/** Staff-only identity: every workspace, its owners and members. */
export const identity = identityAdminClient(env.IDENTITY);

/** Staff-only accounts: a person's email addresses and security log. */
export const accountsAdmin = accountsAdminClient(env.IDENTITY);

/** The workspace's plan, caps and pause, as billing gives them to every service. */
export const entitlements = (workspace: string) => billingClient(env.BILLING).entitlements(workspace);

/** The event log, read-only: sudo lists `abuse.flagged`. */
export const events = eventsClient(env.EVENTS);

/** The status page's incidents (apps/status's `StatusAdmin` entrypoint). */
export const statusAdmin = env.STATUS as unknown as StatusAdminApi;

/** A workspace's self-hosted runners, and removing them (actions' admin_* methods). */
export const runnersAdmin = runnersAdminClient(env.ACTIONS);

/** Public storage holds and drift (the repos service's admin_storage_* methods). */
export const reposAdmin = reposAdminClient(env.REPOS);

/** A workspace's projects, read as the workspace itself, which sees them all. */
export const workspaceProjects = (slug: string) => {
  const workspace: User = { id: `staff:${slug}`, username: slug, kind: "workspace", verified: true, workspaces: [{ slug, role: "member" }] };
  return projectsClient(env.PROJECTS).list(slug, workspace);
};

/** Projects' telemetry: their ingest tokens, to see and revoke. */
export const telemetry = telemetryClient(env.TELEMETRY);

/** STAFF_EMAILS, for suggesting staff in the incident roles. */
export const staffEmails = (): string => env.STAFF_EMAILS ?? "";

export const privacy = privacyClient(env.IDENTITY);
