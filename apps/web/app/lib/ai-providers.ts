/**
 * The AI providers a workspace can keep credentials for, as people are
 * shown them: grouped, with a line each, a mark, and where to get a key.
 */
import type { Provider } from "@g1t/contracts";

export type AiProviderGroup = "labs" | "platforms" | "any";

export type AiProviderEntry = {
  group: AiProviderGroup;
  blurb: string;
  /** The provider's colour, for its mark. */
  color: string;
  /** What the mark shows: an initial or two. Empty for an icon. */
  mark: string;
  /** Where to get a key. */
  keyUrl?: string;
  keyPlaceholder?: string;
  /** A model to suggest. */
  model?: string;
};

/** Every AI provider, in the order people are shown them. */
export const AI_PROVIDERS: Partial<Record<Provider, AiProviderEntry>> = {
  anthropic: {
    group: "labs",
    blurb: "Claude, on your own Anthropic key.",
    color: "#d97757",
    mark: "A",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
  },
  openai: {
    group: "labs",
    blurb: "GPT and the o-series, on your own OpenAI key.",
    color: "#10a37f",
    mark: "O",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
    model: "gpt-5",
  },
  gemini: {
    group: "labs",
    blurb: "Gemini, on your own Google AI Studio key.",
    color: "#4285f4",
    mark: "G",
    keyUrl: "https://aistudio.google.com/apikey",
    model: "gemini-2.5-pro",
  },
  xai: {
    group: "labs",
    blurb: "Grok, on your own xAI key.",
    color: "#e5e5e5",
    mark: "x",
    keyUrl: "https://console.x.ai",
    keyPlaceholder: "xai-…",
    model: "grok-4",
  },
  mistral: {
    group: "labs",
    blurb: "Mistral and Codestral, on your own key.",
    color: "#fa520f",
    mark: "M",
    keyUrl: "https://console.mistral.ai/api-keys",
    model: "mistral-large-latest",
  },
  deepseek: {
    group: "labs",
    blurb: "DeepSeek's chat and reasoning models.",
    color: "#4d6bfe",
    mark: "D",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-…",
    model: "deepseek-chat",
  },
  azure_openai: {
    group: "platforms",
    blurb: "OpenAI's models on your own Azure resource and contract.",
    color: "#0078d4",
    mark: "Az",
  },
  openrouter: {
    group: "platforms",
    blurb: "Hundreds of models from every lab, on one key.",
    color: "#7c7ff5",
    mark: "OR",
    keyUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-…",
    model: "anthropic/claude-sonnet-4.5",
  },
  groq: {
    group: "platforms",
    blurb: "Open models at very high speed.",
    color: "#f55036",
    mark: "Gq",
    keyUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_…",
    model: "moonshotai/kimi-k2-instruct",
  },
  together: {
    group: "platforms",
    blurb: "Open models: Llama, Qwen, DeepSeek, Kimi.",
    color: "#0f6fff",
    mark: "T",
    keyUrl: "https://api.together.ai/settings/api-keys",
    model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
  },
  fireworks: {
    group: "platforms",
    blurb: "Fast open models, and your own fine-tunes.",
    color: "#7c3aed",
    mark: "F",
    keyUrl: "https://fireworks.ai/account/api-keys",
    model: "accounts/fireworks/models/kimi-k2-instruct",
  },
  cerebras: {
    group: "platforms",
    blurb: "Open models on wafer-scale chips.",
    color: "#f05a28",
    mark: "C",
    keyUrl: "https://cloud.cerebras.ai",
    keyPlaceholder: "csk-…",
    model: "qwen-3-coder-480b",
  },
  anthropic_endpoint: {
    group: "any",
    blurb: "Anything that speaks Anthropic's API: your own gateway, LiteLLM, Bedrock or Vertex behind a proxy.",
    color: "#a1a1aa",
    mark: "",
  },
  openai_endpoint: {
    group: "any",
    blurb: "Anything that speaks OpenAI's API: vLLM, Ollama behind a tunnel, LiteLLM, a gateway.",
    color: "#a1a1aa",
    mark: "",
  },
};

export const AI_PROVIDER_GROUPS: { group: AiProviderGroup; title: string }[] = [
  { group: "labs", title: "Labs" },
  { group: "platforms", title: "Platforms" },
  { group: "any", title: "Any endpoint" },
];

/** The AI providers in one group, in catalogue order. */
export function aiProvidersIn(group: AiProviderGroup): Provider[] {
  return (Object.keys(AI_PROVIDERS) as Provider[]).filter((provider) => AI_PROVIDERS[provider]!.group === group);
}

/** Whether a provider is one whose own endpoint the connection gives. */
export function isEndpoint(provider: Provider): boolean {
  return provider === "anthropic_endpoint" || provider === "openai_endpoint";
}
