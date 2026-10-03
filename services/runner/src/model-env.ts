/** The kinds of work a g1t agent does. Each is routed on its own. */
export type AgentTask = "implement" | "review" | "update" | "plan";

/** Where one kind of work goes: what people see, and what is sent. */
export type ModelRoute = {
  /** The model's public name, e.g. `Claude Sonnet 5.5`. */
  modelName: string;
  /** The identifier sent to the provider. */
  model: string;
};

/**
 * g1t's routing policy. Nobody assigning an agent picks a model; the kind
 * of work decides, here, and the operator changes it in one place.
 */
export type AgentRoutes = Record<AgentTask, ModelRoute>;

/** The settings that decide where model requests go. */
export type ModelRouting = {
  /**
   * The provider's key. Not needed when the gateway holds it and requests
   * authenticate to the gateway instead.
   */
  ANTHROPIC_API_KEY?: string;
  /** A Cloudflare AI Gateway id; empty sends requests to the provider directly. */
  AI_GATEWAY_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Authenticates to the gateway, if it requires it. */
  AI_GATEWAY_TOKEN?: string;
};

/** What a run is for, attached to each of its requests at the gateway. */
export type RunTags = { repo: string; pull: number };

/** Whether there is a way to reach a model at all. */
export function canReachModel(env: ModelRouting): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || (env.AI_GATEWAY_ID && env.AI_GATEWAY_TOKEN));
}

/** Where the sandbox sends model requests, and what it sends with them. */
export function modelEnv(
  env: ModelRouting,
  routes: AgentRoutes,
  task: AgentTask,
  tags: RunTags,
): Record<string, string> {
  const route = routes[task];
  const vars: Record<string, string> = {
    ANTHROPIC_MODEL: route.model,
    // Recorded at the top of the session, so anyone can see what ran.
    AGENT_MODEL_NAME: route.modelName,
  };
  if (env.ANTHROPIC_API_KEY) vars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (!env.AI_GATEWAY_ID) return vars;

  vars.ANTHROPIC_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`;
  // The gateway logs these with every request, so spend and failures can
  // be read per kind of work, repository and pull request.
  const headers = [`cf-aig-metadata: ${JSON.stringify({ task, ...tags })}`];
  if (env.AI_GATEWAY_TOKEN) {
    vars.AI_GATEWAY_TOKEN = env.AI_GATEWAY_TOKEN;
    headers.push(`cf-aig-authorization: Bearer ${env.AI_GATEWAY_TOKEN}`);
    // With the provider's key stored in the gateway, the sandbox never
    // holds it. The harness still wants the variable set.
    vars.ANTHROPIC_API_KEY ??= env.AI_GATEWAY_TOKEN;
  }
  vars.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n");
  return vars;
}
