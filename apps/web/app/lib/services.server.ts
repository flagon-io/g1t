import { env } from "cloudflare:workers";

import {
  privacyClient,
  accountsClient,
  actionsClient,
  advisoriesClient,
  agentSessionsClient,
  agentsClient,
  billingClient,
  chatClient,
  deploymentsClient,
  docsClient,
  foliosClient,
  packagesClient,
  projectsClient,
  eventsClient,
  guardrailsClient,
  identityClient,
  inboxClient,
  integrationsClient,
  reposClient,
  searchClient,
  securityClient,
  securitySuiteClient,
  webhooksClient,
  workClient,
} from "@g1t/contracts";
import { telemetryClient } from "@g1t/contracts/telemetry";

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
const SEARCH = instrumented("search", env.SEARCH);
const PACKAGES = instrumented("packages", env.PACKAGES);
const CHAT = instrumented("chat", env.CHAT);
const ARTIFACTS = instrumented("artifacts", env.ARTIFACTS);
const TELEMETRY = env.TELEMETRY ? instrumented("telemetry", env.TELEMETRY) : null;

export const identity = identityClient(IDENTITY);
/** A person's email addresses and account security: methods of identity. */
export const accounts = accountsClient(IDENTITY);
export const repos = reposClient(REPOS);
export const work = workClient(WORK);
export const billing = billingClient(BILLING);
export const events = eventsClient(EVENTS);
/** Each person's inbox, which the events service keeps. */
export const inbox = inboxClient(EVENTS);
export const integrations = integrationsClient(INTEGRATIONS);
/** Sessions on a workspace's own Anthropic account: the integrations service's agent_sessions.rs. */
export const agentSessions = agentSessionsClient(INTEGRATIONS);
export const webhooks = webhooksClient(WEBHOOKS);
export const actions = actionsClient(ACTIONS);
export const deployments = deploymentsClient(DEPLOYMENTS);
export const projects = projectsClient(PROJECTS);
export const security = securityClient(SECURITY);
/** The security suite: patterns, bypasses, code scanning, the dependency graph, settings. */
export const securitySuite = securitySuiteClient(SECURITY);
/** Security advisories and private vulnerability reports: methods of the security service. */
export const advisories = advisoriesClient(SECURITY);
/** Runs and pull request sessions: methods of the work service. */
export const agents = agentsClient(WORK);
/** The network a sandbox may reach: methods of the work service. */
export const guardrails = guardrailsClient(WORK);
/** Search across all of g1t, and Explore. */
export const search = searchClient(SEARCH);
/** The workspace's registries: container images, and more to come. */
export const packages = packagesClient(PACKAGES);
/** Channels, direct messages and threads, where people talk. */
export const chat = chatClient(CHAT);
/** The artifacts service's spaces (Artifacts' spaces) and projects' docs. Its old pages are no longer read. */
export const docs = docsClient(ARTIFACTS);
/** Artifacts (folios): docs, and later slides, designs and dashboards, kept by the artifacts service. */
export const folios = foliosClient(ARTIFACTS);

/**
 * Observability (services/telemetry): a project's requests, logs, traces,
 * metrics and errors. Null where it is not deployed; the pages say so.
 */
export const telemetry = TELEMETRY ? telemetryClient(TELEMETRY) : null;

export const privacy = privacyClient(env.IDENTITY);
