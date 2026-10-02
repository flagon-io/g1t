import { env } from "cloudflare:workers";

import { identityClient, reposClient } from "@g1t/contracts";

export const identity = identityClient(env.IDENTITY);
export const repos = reposClient(env.REPOS);
