import { env } from "cloudflare:workers";

import { billingAdminClient, identityAdminClient } from "@g1t/contracts";

/** Staff-only billing, on the billing service. */
export const admin = billingAdminClient(env.BILLING);

/** Staff-only identity: every workspace, its owners and members. */
export const identity = identityAdminClient(env.IDENTITY);
