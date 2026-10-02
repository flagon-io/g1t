import type { AgentModel } from "@g1t/contracts";

/** A model as configured: what people see, and what is sent to the provider. */
export type ConfiguredModel = AgentModel & { model: string };

/** The settings that decide where model requests go. */
export type ModelRouting = {
  ANTHROPIC_API_KEY?: string;
  /** A Cloudflare AI Gateway id; empty sends requests to the provider directly. */
  AI_GATEWAY_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Needed only if the gateway requires authentication. */
  AI_GATEWAY_TOKEN?: string;
};

/** Where the sandbox sends model requests, and what it sends with them. */
export function modelEnv(env: ModelRouting, model: ConfiguredModel): Record<string, string> {
  const vars: Record<string, string> = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY!,
    ANTHROPIC_MODEL: model.model,
    // Recorded at the top of the session, so anyone can see what ran.
    AGENT_MODEL_NAME: `${model.modelName} (${model.label})`,
  };
  if (env.AI_GATEWAY_ID) {
    vars.ANTHROPIC_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`;
    if (env.AI_GATEWAY_TOKEN) {
      vars.AI_GATEWAY_TOKEN = env.AI_GATEWAY_TOKEN;
      vars.ANTHROPIC_CUSTOM_HEADERS = `cf-aig-authorization: Bearer ${env.AI_GATEWAY_TOKEN}`;
    }
  }
  return vars;
}
