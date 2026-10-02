import { env } from "cloudflare:workers";

import { identityClient } from "@g1t/contracts";

export const identity = identityClient(env.IDENTITY);
