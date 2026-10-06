import { env } from "cloudflare:workers";

import {
  accountsClient,
  actionsClient,
  agentsClient,
  billingClient,
  contextClient,
  deploymentsClient,
  memoryReviewClient,
  projectsClient,
  eventsClient,
  guardrailsClient,
  identityClient,
  integrationsClient,
  reposClient,
  searchClient,
  securityClient,
  webhooksClient,
  workClient,
} from "@g1t/contracts";

export const identity = identityClient(env.IDENTITY);
/** A person's email addresses and account security: methods of identity. */
export const accounts = accountsClient(env.IDENTITY);
export const repos = reposClient(env.REPOS);
export const work = workClient(env.WORK);
export const billing = billingClient(env.BILLING);
export const events = eventsClient(env.EVENTS);
export const integrations = integrationsClient(env.INTEGRATIONS);
export const webhooks = webhooksClient(env.WEBHOOKS);
export const actions = actionsClient(env.ACTIONS);
export const deployments = deploymentsClient(env.DEPLOYMENTS);
export const projects = projectsClient(env.PROJECTS);
export const security = securityClient(env.SECURITY);
/** Agent runs, sessions and memory: methods of the work service. */
export const agents = agentsClient(env.WORK);
/** What agents may do in a sandbox: methods of the work service. */
export const guardrails = guardrailsClient(env.WORK);
/** The context hub: catalog, search and scorecards. */
export const context = contextClient(env.CONTEXT);
/** Search across all of g1t, and Explore. */
export const search = searchClient(env.SEARCH);
/** Memory candidates and their review: methods of the work service. */
export const memoryReview = memoryReviewClient(env.WORK);
