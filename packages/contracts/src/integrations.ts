import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * A workspace's connections to systems outside g1t. Mirrors
 * `crates/contracts/src/integrations.rs`, which says what each does.
 */
export type Provider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "xai"
  | "mistral"
  | "deepseek"
  | "azure_openai"
  | "openrouter"
  | "groq"
  | "together"
  | "fireworks"
  | "cerebras"
  | "anthropic_endpoint"
  | "openai_endpoint"
  | "sentry"
  | "datadog"
  | "webhook"
  | "jira"
  | "linear";

export type ProviderKind = "models" | "alerts" | "tracker";

export type ConnectionConfig = {
  /** For alerts: where issues are opened, `owner/name`. */
  repo?: string;
  /** For alerts: put a g1t agent on each issue opened. */
  assign?: boolean;
  /** For alerts: the label put on each issue. `bug` when unset. */
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
  /** Your own endpoint: its base URL. */
  baseUrl?: string;
  /** Your own endpoint: `x-api-key` (default) or `authorization`. */
  authHeader?: string;
  /** Models: the model used when a route to this connection names none. */
  model?: string;
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
  /** For a model provider: the models it offered when last checked. */
  models: string[];
};

/** The kinds of work a model is chosen for, and `default` for the rest. */
export const MODEL_TASKS = ["default", "implement", "review", "plan", "update"] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

/** Where one kind of work's model requests go: g1t's hosted models when `connectionId` is null. */
export type ModelRoute = { task: ModelTask; connectionId: string | null; model: string | null };

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
  issue: string | null;
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

export type ModelSession = {
  token: string;
  billedTo: "g1t" | "workspace";
  providerName: string | null;
  model: string | null;
  /** Names the run in AI Gateway's logs (`metadata.session`), for billing. */
  id: string;
};

export type ModelUpstream = {
  route: "g1t" | "anthropic" | "endpoint";
  /** The API the provider speaks, which the proxy translates to. */
  api: "anthropic" | "openai";
  /** The model every request of the run goes to, when the route names one. */
  model: string | null;
  /** OpenAI's own API. */
  official: boolean;
  /** Which provider, by name, for its quirks. */
  provider: string;
  workspace: string;
  repo: string;
  number: number;
  task: string;
  /** The session's id; see `ModelSession.id`. */
  session: string;
  baseUrl: string | null;
  apiKey: string | null;
  authHeader: string | null;
  /** For an endpoint behind an authenticated Cloudflare AI Gateway: its token. */
  gatewayToken?: string | null;
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
  test(actor: User, workspace: string, id: string): Promise<Result<{ ok: boolean; message: string }>>;
  deliveries(workspace: string, viewer: Viewer, id: string): Promise<Result<Delivery[]>>;
  resolve(workspace: string, viewer: Viewer, reference: string): Promise<Result<ContextItem>>;
  /** For g1t's agents: what `text` refers to outside g1t, fetched. */
  references(workspace: string, text: string, limit?: number): Promise<ContextItem[]>;
  import(actor: User, repo: RepoPath, reference: string, assign: boolean): Promise<Result<{ number: number; item: ContextItem; created: boolean }>>;
  links(repo: RepoPath, number: number): Promise<Link[]>;
  modelProvider(workspace: string): Promise<Connection | null>;
  openModelSession(run: {
    workspace: string;
    repo: RepoPath;
    number: number;
    task: string;
    hostedOpen: boolean;
  }): Promise<Result<ModelSession>>;
  routes(workspace: string, viewer: Viewer): Promise<Result<ModelRoute[]>>;
  setRoutes(actor: User, workspace: string, routes: ModelRoute[]): Promise<Result<ModelRoute[]>>;
  modelUpstream(token: string): Promise<ModelUpstream | null>;
}

/** What each provider is for, as people choose between them. */
export const PROVIDERS: Record<Provider, { label: string; kind: ProviderKind }> = {
  anthropic: { label: "Anthropic", kind: "models" },
  openai: { label: "OpenAI", kind: "models" },
  gemini: { label: "Google Gemini", kind: "models" },
  xai: { label: "xAI", kind: "models" },
  mistral: { label: "Mistral", kind: "models" },
  deepseek: { label: "DeepSeek", kind: "models" },
  azure_openai: { label: "Azure OpenAI", kind: "models" },
  openrouter: { label: "OpenRouter", kind: "models" },
  groq: { label: "Groq", kind: "models" },
  together: { label: "Together AI", kind: "models" },
  fireworks: { label: "Fireworks AI", kind: "models" },
  cerebras: { label: "Cerebras", kind: "models" },
  anthropic_endpoint: { label: "Anthropic-compatible endpoint", kind: "models" },
  openai_endpoint: { label: "OpenAI-compatible endpoint", kind: "models" },
  sentry: { label: "Sentry", kind: "alerts" },
  datadog: { label: "Datadog", kind: "alerts" },
  webhook: { label: "Webhook", kind: "alerts" },
  jira: { label: "Jira", kind: "tracker" },
  linear: { label: "Linear", kind: "tracker" },
};
