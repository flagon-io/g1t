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

import { instrumented } from "./perf.server";

/**
 * Each binding the clients use, timed for `Server-Timing` and, for the
 * services that read D1 with sessions, told where to read (lib/perf.ts).
 */
const IDENTITY = instrumented("identity", env.IDENTITY);
const REPOS = instrumented("repos", env.REPOS);
const WORK = instrumented("work", env.WORK);
const BILLING = instrumented("billing", env.BILLING);
const EVENTS = instrumented("events", env.EVENTS);
const INTEGRATIONS = instrumented("integrations", env.INTEGRATIONS);
const WEBHOOKS = instrumented("webhooks", env.WEBHOOKS);
const ACTIONS = instrumented("actions", env.ACTIONS);
const DEPLOYMENTS = instrumented("deployments", env.DEPLOYMENTS);
const PROJECTS = instrumented("projects", env.PROJECTS);
const SECURITY = instrumented("security", env.SECURITY);
const CONTEXT = instrumented("context", env.CONTEXT);
const SEARCH = instrumented("search", env.SEARCH);

export const identity = identityClient(IDENTITY);
/** A person's email addresses and account security: methods of identity. */
export const accounts = accountsClient(IDENTITY);
export const repos = reposClient(REPOS);
export const work = workClient(WORK);
export const billing = billingClient(BILLING);
export const events = eventsClient(EVENTS);
export const integrations = integrationsClient(INTEGRATIONS);
export const webhooks = webhooksClient(WEBHOOKS);
export const actions = actionsClient(ACTIONS);
export const deployments = deploymentsClient(DEPLOYMENTS);
export const projects = projectsClient(PROJECTS);
export const security = securityClient(SECURITY);
/** Agent runs, sessions and memory: methods of the work service. */
export const agents = agentsClient(WORK);
/** What agents may do in a sandbox: methods of the work service. */
export const guardrails = guardrailsClient(WORK);
/** The context hub: catalog, search and scorecards. */
export const context = contextClient(CONTEXT);
/** Search across all of g1t, and Explore. */
export const search = searchClient(SEARCH);
/** Memory candidates and their review: methods of the work service. */
export const memoryReview = memoryReviewClient(WORK);
