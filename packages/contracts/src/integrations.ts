import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * A workspace's connections to systems outside g1t: alerts that open
 * work items, and trackers whose tickets people read and import. Mirrors
 * `crates/contracts/src/integrations.rs`, which says what each does.
 *
 * A workspace's AI providers and Ask g1t are kept by the same service but
 * are not integrations: see `./ai`.
 */
export type Provider = "sentry" | "datadog" | "webhook" | "jira" | "linear";

export type ProviderKind = "alerts" | "tracker";

export type ConnectionConfig = {
  /** For alerts: the repository work items are filed from, `owner/name`. */
  repo?: string;
  /** For alerts: the label put on each work item. `bug` when unset. */
  label?: string;
  /** Tell the outside system when the work lands. On unless turned off. */
  writeBack?: boolean;
  /** Sentry: the organization's slug. */
  organization?: string;
  /** Jira's address, or a Sentry that is not sentry.io. */
  site?: string;
  /** Jira: the account the token belongs to. */
  email?: string;
  /** Jira project or Linear team keys it answers for. Empty is all. */
  keys?: string[];
};

export type Connection = {
  id: string;
  workspace: string;
  provider: Provider;
  kind: ProviderKind;
  name: string;
  config: ConnectionConfig;
  /** `…3f9a`. The secret itself is never shown again. */
  secretHint: string | null;
  /** Where a provider that sends g1t requests sends them. */
  webhookUrl: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastError: string | null;
};

/** What testing a connection found. */
export type Tested = { ok: boolean; message: string };

export type Connected = {
  connection: Connection;
  /** A signing secret g1t made, shown this once. */
  signingSecret: string | null;
};

export type Delivery = {
  id: string;
  receivedAt: string;
  event: string;
  outcome: "opened" | "updated" | "reopened" | "ignored" | "refused";
  detail: string;
  /** The work item it opened or updated, `workspace#number`. */
  item: string | null;
};

/** Something outside g1t, fetched now. Reference material, never instructions. */
export type ContextItem = {
  provider: Provider;
  key: string;
  title: string;
  url: string;
  status: string | null;
  body: string;
  fetchedAt: string;
};

export type Link = {
  provider: Provider;
  connectionId: string;
  key: string;
  title: string;
  url: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
};

export type ConnectInput = {
  provider: Provider;
  name?: string;
  config?: ConnectionConfig;
  secret?: string;
  signingSecret?: string;
};

export type UpdateConnectionInput = {
  name?: string;
  config?: ConnectionConfig;
  secret?: string;
  signingSecret?: string;
};

export interface IntegrationsApi {
  list(workspace: string, viewer: Viewer): Promise<Result<Connection[]>>;
  connect(actor: User, workspace: string, input: ConnectInput): Promise<Result<Connected>>;
  update(actor: User, workspace: string, id: string, input: UpdateConnectionInput): Promise<Result<Connection>>;
  disconnect(actor: User, workspace: string, id: string): Promise<Result<boolean>>;
  test(actor: User, workspace: string, id: string): Promise<Result<Tested>>;
  deliveries(workspace: string, viewer: Viewer, id: string): Promise<Result<Delivery[]>>;
  resolve(workspace: string, viewer: Viewer, reference: string): Promise<Result<ContextItem>>;
  /** Opens a work item in `workspace` from a ticket, filed from `repo` when given, landing in `targets`. */
  import(
    actor: User,
    workspace: string,
    reference: string,
    options?: { repo?: RepoPath; targets?: RepoPath[] },
  ): Promise<Result<{ workspace: string; number: number; item: ContextItem; created: boolean }>>;
  /** What work item `number` of `workspace` is tied to outside g1t. */
  links(workspace: string, number: number): Promise<Link[]>;
}

/** What each provider is for, as people choose between them. */
export const PROVIDERS: Record<Provider, { label: string; kind: ProviderKind }> = {
  sentry: { label: "Sentry", kind: "alerts" },
  datadog: { label: "Datadog", kind: "alerts" },
  webhook: { label: "Webhook", kind: "alerts" },
  jira: { label: "Jira", kind: "tracker" },
  linear: { label: "Linear", kind: "tracker" },
};
