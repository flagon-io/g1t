import { env } from "cloudflare:workers";

import { billingAdminClient } from "@g1t/contracts";

/** Staff-only billing, on the billing service. */
export const admin = billingAdminClient(env.BILLING);
