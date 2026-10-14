/**
 * The AI providers a workspace can keep credentials for, as its AI page
 * shows them: grouped (frontier labs and model platforms, then models it
 * hosts itself), with a line each, a mark, and where to get a key.
 */
import { type AiGroup, type AiProvider, AI_PROVIDERS } from "@g1t/contracts/ai";

/** How the AI page shows a provider; its name, group and API are the contracts' `AI_PROVIDERS`. */
export type AiProviderLook = {
  blurb: string;
  /** The provider's colour, for its mark. */
  color: string;
  /** What the mark shows: an initial or two. Empty for an icon. */
  mark: string;
  /** Where to get a key. */
  keyUrl?: string;
  /** How to get one there, in a sentence or two, for someone who never has. */
  keyHow?: string;
  keyPlaceholder?: string;
  /** A model to suggest. */
  model?: string;
};

/** How each AI provider is shown. */
export const AI_PROVIDER_LOOKS: Record<AiProvider, AiProviderLook> = {
  anthropic: {
    blurb: "Claude, on your own Anthropic key.",
    color: "#d97757",
    mark: "A",
    keyUrl: "https://platform.claude.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
    keyHow: "Sign in to the Claude Console, choose Create key and copy it. The account needs credits under Billing; a Claude.ai subscription does not include the API.",
  },
  openai: {
    blurb: "GPT and the o-series, on your own OpenAI key.",
    color: "#10a37f",
    mark: "O",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
    model: "gpt-5",
    keyHow: "Choose Create new secret key and copy it. The API needs credit under Settings → Billing; a ChatGPT subscription does not include it.",
  },
  gemini: {
    blurb: "Gemini, on your own Google AI Studio key.",
    color: "#4285f4",
    mark: "G",
    keyUrl: "https://aistudio.google.com/apikey",
    model: "gemini-2.5-pro",
    keyHow: "Sign in with a Google account, choose Create API key and copy it. The free tier needs no card.",
  },
  xai: {
    blurb: "Grok, on your own xAI key.",
    color: "#e5e5e5",
    mark: "x",
    keyUrl: "https://console.x.ai",
    keyPlaceholder: "xai-…",
    model: "grok-4",
    keyHow: "Open API Keys, choose Create API key and copy it. The team needs credits under Billing.",
  },
  mistral: {
    blurb: "Mistral and Codestral, on your own key.",
    color: "#fa520f",
    mark: "M",
    keyUrl: "https://console.mistral.ai/api-keys",
    model: "mistral-large-latest",
    keyHow: "Choose Create new key and copy it. The workspace needs a plan under Billing; the free Experiment plan works.",
  },
  deepseek: {
    blurb: "DeepSeek's chat and reasoning models.",
    color: "#4d6bfe",
    mark: "D",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-…",
    model: "deepseek-chat",
    keyHow: "Choose Create new API key and copy it. The account needs a balance under Top up.",
  },
  azure_openai: {
    blurb: "OpenAI's models on your own Azure resource and contract.",
    color: "#0078d4",
    mark: "Az",
    keyUrl: "https://portal.azure.com",
    keyHow: "Open your Azure OpenAI resource, then Resource Management → Keys and Endpoint: copy KEY 1 and the endpoint. Deployments are listed in the Azure AI Foundry portal.",
  },
  openrouter: {
    blurb: "Hundreds of models from every lab, on one key.",
    color: "#7c7ff5",
    mark: "OR",
    keyUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-…",
    model: "anthropic/claude-sonnet-4.5",
    keyHow: "Choose Create Key and copy it. Paid models need credits under Credits.",
  },
  groq: {
    blurb: "Open models at very high speed.",
    color: "#f55036",
    mark: "Gq",
    keyUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_…",
    model: "moonshotai/kimi-k2-instruct",
    keyHow: "Choose Create API Key and copy it. The free tier needs no card.",
  },
  together: {
    blurb: "Open models: Llama, Qwen, DeepSeek, Kimi.",
    color: "#0f6fff",
    mark: "T",
    keyUrl: "https://api.together.ai/settings/api-keys",
    model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
    keyHow: "Copy the key shown there, or create one.",
  },
  fireworks: {
    blurb: "Fast open models, and your own fine-tunes.",
    color: "#7c3aed",
    mark: "F",
    keyUrl: "https://fireworks.ai/account/api-keys",
    model: "accounts/fireworks/models/kimi-k2-instruct",
    keyHow: "Choose Create API Key and copy it.",
  },
  cerebras: {
    blurb: "Open models on wafer-scale chips.",
    color: "#f05a28",
    mark: "C",
    keyUrl: "https://cloud.cerebras.ai",
    keyPlaceholder: "csk-…",
    model: "qwen-3-coder-480b",
    keyHow: "Open API Keys, choose Generate API Key and copy it.",
  },
  anthropic_endpoint: {
    blurb: "Anything that speaks Anthropic's API: your own gateway, LiteLLM, Bedrock or Vertex behind a proxy.",
    color: "#a1a1aa",
    mark: "",
  },
  openai_endpoint: {
    blurb: "Anything that speaks OpenAI's API: vLLM, Ollama behind a tunnel, LiteLLM, a gateway.",
    color: "#a1a1aa",
    mark: "",
  },
};

/** The groups, in the order people are shown them. */
export const AI_PROVIDER_GROUPS: { group: AiGroup; title: string }[] = [
  { group: "labs", title: "Frontier labs" },
  { group: "platforms", title: "Model platforms" },
  { group: "self_hosted", title: "Self-hosted or your own gateway" },
];

/** The AI providers in one group, in catalogue order. */
export function aiProvidersIn(group: AiGroup): AiProvider[] {
  return (Object.keys(AI_PROVIDERS) as AiProvider[]).filter((provider) => AI_PROVIDERS[provider].group === group);
}

/** Whether a provider is one whose own endpoint the workspace gives. */
export function isEndpoint(provider: AiProvider): boolean {
  return AI_PROVIDERS[provider].group === "self_hosted";
}
