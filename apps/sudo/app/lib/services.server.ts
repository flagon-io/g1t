import { env } from "cloudflare:workers";

import { billingAdminClient, billingClient, identityAdminClient } from "@g1t/contracts";

/** Staff-only billing, on the billing service. */
export const admin = billingAdminClient(env.BILLING);

/** The public price book, read-only, from the same service. */
export const priceBook = () => billingClient(env.BILLING).prices();

/** Staff-only identity: every workspace, its owners and members. */
export const identity = identityAdminClient(env.IDENTITY);
