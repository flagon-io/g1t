import { env } from "cloudflare:workers";

import {
  automationsClient,
  billingClient,
  eventsClient,
  identityClient,
  integrationsClient,
  reposClient,
  webhooksClient,
  workClient,
} from "@g1t/contracts";

export const identity = identityClient(env.IDENTITY);
export const repos = reposClient(env.REPOS);
export const work = workClient(env.WORK);
export const billing = billingClient(env.BILLING);
export const events = eventsClient(env.EVENTS);
export const integrations = integrationsClient(env.INTEGRATIONS);
export const webhooks = webhooksClient(env.WEBHOOKS);
export const automations = automationsClient(env.AUTOMATIONS);
