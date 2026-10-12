import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * A workspace's connections to systems outside g1t. Mirrors
 * `crates/contracts/src/integrations.rs`, which says what each does.
 *
 * The AI providers (`anthropic` through `openai_endpoint`, of kind
 * `models`) keep the credentials for the AI providers a workspace's team
 * uses.
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

/** `models`: an AI provider whose credentials the workspace keeps. */
export type ProviderKind = "models" | "alerts" | "tracker";

export type ConnectionConfig = {
  /** For alerts: where issues are opened, `owner/name`. */
  repo?: string;
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
  /** For an AI provider: the model (or Azure deployment) the team uses on it. */
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

// --- Ask g1t -----------------------------------------------------------------
// A conversation with g1t from the top bar, answered by the AI provider and
// model an owner chose from the workspace's own connections, on its own key.
// g1t hosts no model for it and bills nothing for it.

/** The most messages one ask sends: the conversation's latest turns. */
export const ASK_MAX_MESSAGES = 40;
/** The longest one message may be, in characters. */
export const ASK_MAX_MESSAGE_CHARS = 16_000;
/** The longest a whole conversation may be, in characters. */
export const ASK_MAX_TOTAL_CHARS = 64_000;
/** The most tokens one answer may run to. */
export const ASK_MAX_OUTPUT_TOKENS = 4_096;

/** What Ask answers with in a workspace, or why it cannot yet. */
export type AskSetup = {
  connection_id: string | null;
  connection_name: string | null;
  provider: Provider | null;
  model: string | null;
  /** Why Ask cannot answer, for the person asking. Null when it can. */
  problem: string | null;
};

export type AskRole = "user" | "assistant";
export type AskMessage = { role: AskRole; content: string };

/** Where the person asking is, so the answer is about their work. */
export type AskPage = {
  path?: string | null;
  repo?: RepoPath | null;
  issue?: number | null;
  pull?: number | null;
};

/** One line of an `ask` answer, as newline-delimited JSON. */
export type AskEvent =
  | { type: "meta"; provider: Provider; provider_label: string; model: string }
  | { type: "text"; text: string }
  | { type: "done"; stop_reason: string | null }
  | { type: "error"; message: string };

export interface IntegrationsApi {
  list(workspace: string, viewer: Viewer): Promise<Result<Connection[]>>;
  connect(actor: User, workspace: string, input: ConnectInput): Promise<Result<Connected>>;
  update(actor: User, workspace: string, id: string, input: UpdateConnectionInput): Promise<Result<Connection>>;
  disconnect(actor: User, workspace: string, id: string): Promise<Result<boolean>>;
  test(actor: User, workspace: string, id: string): Promise<Result<{ ok: boolean; message: string }>>;
  deliveries(workspace: string, viewer: Viewer, id: string): Promise<Result<Delivery[]>>;
  resolve(workspace: string, viewer: Viewer, reference: string): Promise<Result<ContextItem>>;
  import(actor: User, repo: RepoPath, reference: string): Promise<Result<{ number: number; item: ContextItem; created: boolean }>>;
  links(repo: RepoPath, number: number): Promise<Link[]>;
  /** What Ask answers with. Members only. */
  askSettings(workspace: string, viewer: Viewer): Promise<Result<AskSetup>>;
  /** Chooses Ask's connection and model; a null connection turns it off. Owners only. */
  setAskSettings(actor: User, workspace: string, connectionId: string | null, model: string | null): Promise<Result<AskSetup>>;
  /**
   * One answer, as the service's response: newline-delimited `AskEvent`s,
   * streamed. Members only. Call it on the binding itself, not through
   * anything that reads the whole body first. `signal` stops the answer.
   */
  ask(actor: User, workspace: string, messages: AskMessage[], page: AskPage, signal?: AbortSignal): Promise<Response>;
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
