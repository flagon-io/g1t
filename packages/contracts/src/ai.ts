import type { User, Viewer } from "./identity";
import type { Tested } from "./integrations";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * A workspace's AI: the AI providers it keeps keys for, and what Ask g1t
 * answers with. Kept by the integrations service, but not an integration: a
 * workspace's AI is one of its own settings, at `/:workspace/-/ai`. Mirrors
 * `crates/contracts/src/ai.rs`, which says what each does.
 */
export type AiProvider =
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
  | "openai_endpoint";

/**
 * Where an AI provider's models come from, as people choose them: a lab's
 * own API, a platform serving many labs' models, or a model the workspace
 * hosts itself (or its own gateway).
 */
export type AiGroup = "labs" | "platforms" | "self_hosted";

/** What g1t knows about an AI provider. */
export type AiSpec = {
  label: string;
  group: AiGroup;
  /** The API it speaks. */
  api: "anthropic" | "openai";
  /**
   * Where its API is, with the version for OpenAI's API and without it for
   * Anthropic's. Empty when the workspace gives its own.
   */
  baseUrl: string;
  /** The header the key goes in; `authorization` means `Bearer <key>`. */
  authHeader: "x-api-key" | "authorization" | "api-key";
};

/** Every AI provider, in the order people are shown them. */
export const AI_PROVIDERS: Record<AiProvider, AiSpec> = {
  anthropic: { label: "Anthropic", group: "labs", api: "anthropic", baseUrl: "https://api.anthropic.com", authHeader: "x-api-key" },
  openai: { label: "OpenAI", group: "labs", api: "openai", baseUrl: "https://api.openai.com/v1", authHeader: "authorization" },
  gemini: {
    label: "Google Gemini",
    group: "labs",
    api: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authHeader: "authorization",
  },
  xai: { label: "xAI", group: "labs", api: "openai", baseUrl: "https://api.x.ai/v1", authHeader: "authorization" },
  mistral: { label: "Mistral", group: "labs", api: "openai", baseUrl: "https://api.mistral.ai/v1", authHeader: "authorization" },
  deepseek: { label: "DeepSeek", group: "labs", api: "openai", baseUrl: "https://api.deepseek.com/v1", authHeader: "authorization" },
  azure_openai: { label: "Azure OpenAI", group: "platforms", api: "openai", baseUrl: "", authHeader: "api-key" },
  openrouter: { label: "OpenRouter", group: "platforms", api: "openai", baseUrl: "https://openrouter.ai/api/v1", authHeader: "authorization" },
  groq: { label: "Groq", group: "platforms", api: "openai", baseUrl: "https://api.groq.com/openai/v1", authHeader: "authorization" },
  together: { label: "Together AI", group: "platforms", api: "openai", baseUrl: "https://api.together.xyz/v1", authHeader: "authorization" },
  fireworks: {
    label: "Fireworks AI",
    group: "platforms",
    api: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authHeader: "authorization",
  },
  cerebras: { label: "Cerebras", group: "platforms", api: "openai", baseUrl: "https://api.cerebras.ai/v1", authHeader: "authorization" },
  anthropic_endpoint: { label: "Anthropic-compatible endpoint", group: "self_hosted", api: "anthropic", baseUrl: "", authHeader: "x-api-key" },
  openai_endpoint: { label: "OpenAI-compatible endpoint", group: "self_hosted", api: "openai", baseUrl: "", authHeader: "authorization" },
};

/** Whether the workspace gives the provider's address, rather than g1t knowing it. */
export function aiOwnAddress(provider: AiProvider): boolean {
  return AI_PROVIDERS[provider].baseUrl === "";
}

export function isAiProvider(value: string): value is AiProvider {
  return Object.hasOwn(AI_PROVIDERS, value);
}

/** An AI provider's settings: everything but its key. */
export type AiConfig = {
  /**
   * For an endpoint or an Azure OpenAI resource: its address over
   * `https://`. An Anthropic-compatible one without `/v1`, an
   * OpenAI-compatible one up to and including the version.
   */
  baseUrl?: string;
  /** For an endpoint: `x-api-key` or `authorization` (Bearer). */
  authHeader?: string;
  /** The model the team uses on it; for Azure OpenAI, the deployment. */
  model?: string;
  /**
   * For Anthropic: the Console workspace the key belongs to, as its Console
   * address names it (`wrkspc_…`), so links to the sessions it starts open
   * there. Without it, the account's Default workspace.
   */
  consoleWorkspace?: string;
};

/** One of a workspace's AI providers, as any member sees it. */
export type AiConnection = {
  id: string;
  workspace: string;
  provider: AiProvider;
  group: AiGroup;
  name: string;
  config: AiConfig;
  /** `…3f9a`. The key itself is never shown again. */
  secretHint: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** The last thing that went wrong talking to it, until it next works. */
  lastError: string | null;
  /** The models it offered when last checked. */
  models: string[];
};

export type AddAiInput = {
  provider: AiProvider;
  name?: string;
  config?: AiConfig;
  /** Its API key. Optional for an endpoint that needs none. */
  secret?: string;
};

export type UpdateAiInput = {
  name?: string;
  config?: AiConfig;
  /** A new key, replacing the old one. */
  secret?: string;
};

// --- Ask g1t -----------------------------------------------------------------
// A conversation with g1t from the top bar and with @g1t in Chat, answered by
// the AI provider and model an owner chose, on the workspace's own key. g1t
// hosts no model for it and bills nothing for it.

/** The most messages one ask sends: the conversation's latest turns. */
export const ASK_MAX_MESSAGES = 40;
/** The longest one message may be, in characters. */
export const ASK_MAX_MESSAGE_CHARS = 16_000;
/** The longest a whole conversation may be, in characters. */
export const ASK_MAX_TOTAL_CHARS = 64_000;
/** The most tokens one answer may run to. */
export const ASK_MAX_OUTPUT_TOKENS = 4_096;

/** The model name that chooses Auto in `setAskSettings`. */
export const ASK_AUTO_MODEL = "auto";

/** What Ask answers with in a workspace, or why it cannot yet. */
export type AskSetup = {
  /** The workspace's AI provider Ask answers with: an `AiConnection`'s id. */
  provider_id: string | null;
  /** Its name, as its owner named it. */
  provider_name: string | null;
  provider: AiProvider | null;
  /** The model chosen. With `auto`, null, or the provider's own model when it lists none. */
  model: string | null;
  /**
   * Auto: each question goes to the provider's model that suits it (a fast
   * one for a lookup, a stronger one for a question that needs several reads
   * or reasoning). The default.
   */
  auto?: boolean;
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
  /** The browser's IANA time zone, such as `America/Denver`: what "today" means when their profile names none. */
  time_zone?: string | null;
};

/** The most rounds of tool calls one answer takes before it must answer. */
export const ASK_MAX_TOOL_ROUNDS = 10;
/** The most tool calls one answer makes, across its rounds. */
export const ASK_MAX_TOOL_CALLS = 30;
/** The most characters of one tool's result the model is given; more is trimmed, with a note. */
export const ASK_MAX_TOOL_RESULT_CHARS = 16_000;
/** The most characters of tool results one answer gives the model in all. */
export const ASK_MAX_TOOL_TOTAL_CHARS = 120_000;
/** How long one answer may spend calling tools, in seconds. */
export const ASK_MAX_TOOL_SECONDS = 120;
/** The most sources one answer lists. */
export const ASK_MAX_SOURCES = 12;

/**
 * Where a step of an answer is. `refused`: Ask did not run it (it only
 * reads and hands work off, or the answer had used its tool calls).
 */
export type AskToolStatus = "running" | "done" | "failed" | "refused";

/** A page on g1t an answer drew on; `cited` when the answer links to it. */
export type AskSource = { title: string; url: string; cited: boolean };

/**
 * One line of an `ask` answer, as newline-delimited JSON: `meta`, then
 * `text` as it comes and a `tool` line as each step starts and ends (the
 * same `id` twice), then `sources` and `done`, or `error` at any point.
 */
export type AskEvent =
  | { type: "meta"; provider: AiProvider; provider_label: string; model: string; /** Auto chose `model`. */ auto?: boolean }
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      /** The tool, such as `pull_request`, and its action, such as `list`. */
      name: string;
      action: string | null;
      /** What it does, for a person: "Read pull requests in acme/web". */
      label: string;
      status: AskToolStatus;
      summary: string | null;
      link: string | null;
    }
  | { type: "sources"; sources: AskSource[] }
  | {
      /**
       * Work Ask proposes to hand to a session in the person's own harness:
       * on an issue, or a new one with `title` and `body`. Nothing has
       * started; the person starts it from the card the answer shows.
       */
      type: "proposal";
      id: string;
      repo: string;
      issue: number | null;
      title: string | null;
      body: string | null;
      mode: "plan" | "implement" | "review";
      instruction: string | null;
      /**
       * `repo` does not exist yet: the card creates it (`private` or
       * public), turns on its deployments when `deploy`, then opens the
       * issue and starts the session, which pushes the first version to
       * the default branch, and so deploys it.
       */
      new_repository?: boolean;
      private?: boolean;
      deploy?: boolean;
    }
  | { type: "done"; stop_reason: string | null }
  | { type: "error"; message: string };

/** A workspace's AI, through the integrations service's `ai_*` and Ask methods. */
export interface AiApi {
  /** The workspace's AI providers. Members only. */
  list(workspace: string, viewer: Viewer): Promise<Result<AiConnection[]>>;
  /** Adds an AI provider, after checking its key. Owners only. */
  add(actor: User, workspace: string, input: AddAiInput): Promise<Result<AiConnection>>;
  /** Changes only the fields given. Owners only. */
  update(actor: User, workspace: string, id: string, input: UpdateAiInput): Promise<Result<AiConnection>>;
  remove(actor: User, workspace: string, id: string): Promise<Result<boolean>>;
  test(actor: User, workspace: string, id: string): Promise<Result<Tested>>;
  /** What Ask answers with. Members only. */
  askSettings(workspace: string, viewer: Viewer): Promise<Result<AskSetup>>;
  /** Chooses Ask's AI provider and model; a null provider turns it off. Owners only. */
  setAskSettings(actor: User, workspace: string, providerId: string | null, model: string | null): Promise<Result<AskSetup>>;
  /**
   * One answer, as the service's response: newline-delimited `AskEvent`s,
   * streamed. Members only. Call it on the binding itself, not through
   * anything that reads the whole body first. `signal` stops the answer.
   */
  ask(actor: User, workspace: string, messages: AskMessage[], page: AskPage, signal?: AbortSignal): Promise<Response>;
}
