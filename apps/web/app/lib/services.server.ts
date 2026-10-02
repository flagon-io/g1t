import { env } from "cloudflare:workers";

import { identityClient, reposClient, workClient } from "@g1t/contracts";

export const identity = identityClient(env.IDENTITY);
export const repos = reposClient(env.REPOS);
export const work = workClient(env.WORK);
