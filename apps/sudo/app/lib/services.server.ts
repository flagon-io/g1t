import { env } from "cloudflare:workers";

import { accountsAdminClient, billingAdminClient, billingClient, eventsClient, identityAdminClient } from "@g1t/contracts";

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
