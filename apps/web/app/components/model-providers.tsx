/**
 * A workspace's model providers: the catalogue people choose from, the
 * fields each one asks for, and the routing of each kind of work to a
 * provider and model.
 */
import { Bot, ChevronRight, Sparkles, Webhook } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Form, Link } from "react-router";

import { type Connection, MODEL_TASKS, MODEL_TIERS, type ModelRoute, type ModelTask, type ModelTier, type Provider, PROVIDERS } from "@g1t/contracts";

import { Field, Input, SubmitButton } from "./ui";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "./ui/select";

type Group = "labs" | "platforms" | "any";

type CatalogEntry = {
  group: Group;
  blurb: string;
  /** The provider's colour, for its mark. */
  color: string;
  /** What the mark shows: an initial or two. */
  mark: string;
  /** Where to get a key. */
  keyUrl?: string;
  keyPlaceholder?: string;
  /** A model to suggest. */
  model?: string;
};

/** Every model provider, as people are shown them. */
export const MODEL_CATALOG: Partial<Record<Provider, CatalogEntry>> = {
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
    blurb: "Anything that speaks Anthropic's API: your own AI Gateway, LiteLLM, Bedrock or Vertex behind a proxy.",
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

const OTHER_COLORS: Partial<Record<Provider, string>> = {
  sentry: "#a78bfa",
  datadog: "#a26ce6",
  webhook: "#5eead4",
  jira: "#5b8def",
  linear: "#8b8ff0",
};

/** A provider's mark: its initials in its colour, or an icon for the generic ones. */
export function ProviderMark({ provider, size = 32 }: { provider: Provider; size?: number }) {
  const entry = MODEL_CATALOG[provider];
  const color = entry?.color ?? OTHER_COLORS[provider] ?? "#a1a1aa";
  const content =
    provider === "webhook" ? (
      <Webhook size={size * 0.5} />
    ) : provider.endsWith("_endpoint") ? (
      <Bot size={size * 0.5} />
    ) : (
      entry?.mark || PROVIDERS[provider].label[0]
    );
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center font-semibold tracking-tight"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        fontSize: size * (String(content).length > 1 ? 0.34 : 0.42),
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        // Lifted toward white, so the small letters read on the dark tile.
        color: `color-mix(in srgb, ${color} 72%, white)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {content}
    </span>
  );
}

const GROUPS: { group: Group; title: string }[] = [
  { group: "labs", title: "Labs" },
  { group: "platforms", title: "Platforms" },
  { group: "any", title: "Any endpoint" },
];

/** Providers to choose from, as compact tiles that open their form. */
export function ProviderTiles({
  providers,
  slug,
  adding,
  blurb,
}: {
  providers: Provider[];
  slug: string;
  adding: Provider | null;
  blurb: (provider: Provider) => string;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {providers.map((provider) => (
        <Link
          key={provider}
          to={`/${slug}/-/integrations?add=${provider}#add`}
          preventScrollReset
          className={`group flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
            adding === provider ? "border-accent-dim bg-surface" : "border-line hover:border-line-strong hover:bg-surface"
          }`}
        >
          <ProviderMark provider={provider} size={28} />
          <span className="min-w-0 grow">
            <span className="block truncate text-sm font-medium">{PROVIDERS[provider].label}</span>
            <span className="block truncate text-xs text-muted" title={blurb(provider)}>
              {blurb(provider)}
            </span>
          </span>
          <ChevronRight size={14} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
        </Link>
      ))}
    </div>
  );
}

/** The model providers to choose from, grouped. */
export function ModelCatalog({ slug, adding }: { slug: string; adding: Provider | null }) {
  return (
    <div className="mt-4 space-y-4">
      {GROUPS.map(({ group, title }) => (
        <div key={group}>
          <p className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">{title}</p>
          <ProviderTiles
            providers={(Object.keys(MODEL_CATALOG) as Provider[]).filter((provider) => MODEL_CATALOG[provider]!.group === group)}
            slug={slug}
            adding={adding}
            blurb={(provider) => MODEL_CATALOG[provider]!.blurb}
          />
        </div>
      ))}
    </div>
  );
}

/** Radix Select items cannot be "": the routing value for "same as everything". */
const SAME = "same";

const SELECT =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none hover:border-line-strong focus:border-accent-dim disabled:opacity-60";

const GATEWAY_TOKEN = (
  <Field label="Cloudflare AI Gateway token" hint="Only for an authenticated AI Gateway: sent as cf-aig-authorization.">
    <Input name="signingSecret" type="password" />
  </Field>
);

/** What connecting a model provider asks for. */
export function ModelProviderFields({ provider }: { provider: Provider }): ReactNode {
  const entry = MODEL_CATALOG[provider];
  if (provider === "azure_openai") {
    return (
      <>
        <Field label="Endpoint" hint="Your resource's endpoint, from the Azure portal: Keys and Endpoint.">
          <Input name="baseUrl" type="url" required placeholder="https://acme.openai.azure.com" />
        </Field>
        <Field label="Key" hint="KEY 1 or KEY 2 of the resource.">
          <Input name="secret" type="password" required />
        </Field>
        <Field label="Deployment" hint="The name of the model deployment to use. Add a connection for each deployment you want to route to.">
          <Input name="model" required placeholder="gpt-5" />
        </Field>
      </>
    );
  }
  if (provider === "anthropic_endpoint" || provider === "openai_endpoint") {
    const anthropic = provider === "anthropic_endpoint";
    return (
      <>
        <Field
          label="Base URL"
          hint={
            anthropic
              ? "Without /v1. For a Cloudflare AI Gateway: https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic"
              : "Up to and including the version, such as https://llm.acme.dev/v1. g1t calls /chat/completions under it."
          }
        >
          <Input name="baseUrl" type="url" required placeholder={anthropic ? "https://llm.acme.dev" : "https://llm.acme.dev/v1"} />
        </Field>
        <Field label="Key" hint="Optional, if the endpoint needs one.">
          <Input name="secret" type="password" />
        </Field>
        <Field label="Send the key as">
          <Select name="authHeader" defaultValue={anthropic ? "x-api-key" : "authorization"}>
            <SelectTrigger aria-label="Send the key as" className="font-mono text-[0.8125rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="x-api-key" description="Anthropic's header" className="font-mono text-[0.8125rem]">
                x-api-key
              </SelectItem>
              <SelectItem value="authorization" description="OpenAI's header, and most others" className="font-mono text-[0.8125rem]">
                Authorization: Bearer
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {GATEWAY_TOKEN}
        <Field
          label={anthropic ? "Model" : "Default model"}
          hint={
            anthropic
              ? "Optional. Empty uses g1t's choice of Claude for each kind of work; set it if your endpoint names models its own way."
              : "The model to use unless routing says otherwise. g1t also lists the endpoint's models if it offers a list."
          }
        >
          <Input name="model" required={!anthropic} placeholder={anthropic ? "claude-sonnet-5-5" : "qwen3-coder"} />
        </Field>
      </>
    );
  }
  return (
    <>
      <Field
        label="API key"
        hint={`${entry?.keyUrl ? `Get one at ${new URL(entry.keyUrl).host}. ` : ""}Sealed when saved: nobody sees it again, and agents never do.`}
      >
        <Input name="secret" type="password" required placeholder={entry?.keyPlaceholder} />
      </Field>
      {provider !== "anthropic" && (
        <Field label="Default model" hint="Optional. g1t lists the key's models when you connect; you choose per kind of work after.">
          <Input name="model" placeholder={entry?.model} />
        </Field>
      )}
    </>
  );
}

const TASK_LABELS: Record<ModelTask, { label: string; hint: string }> = {
  default: { label: "Everything", hint: "Unless a kind of work below says otherwise." },
  implement: { label: "Making changes", hint: "Writing the change for an issue, and revising it." },
  review: { label: "Reviewing", hint: "The second agent that reviews each change." },
  plan: { label: "Planning", hint: "Turning an outcome into issues." },
  update: { label: "Catching up", hint: "Bringing a change up to date with main." },
};

type Choice = { target: string; model: string };

/** g1t's models, as a route can choose them: Auto, or one tier. */
const AUTO = "auto";
const TIER_CHOICES: Record<ModelTier, { label: string; hint: string }> = {
  small: { label: "Fast", hint: "Cheapest; simple work" },
  large: { label: "Standard", hint: "Most changes" },
  frontier: { label: "Most capable", hint: "Hard work; costs the most" },
};

function choiceOf(route: ModelRoute | undefined): Choice {
  if (!route) return { target: "", model: "" };
  return { target: route.connectionId ?? "g1t", model: route.model ?? "" };
}

/** Each kind of work, and the provider and model it goes to. */
export function Routing({
  connections,
  routes,
  hostedOpen,
  owner,
  saved,
}: {
  connections: Connection[];
  routes: ModelRoute[];
  hostedOpen: boolean;
  owner: boolean;
  saved: boolean;
}) {
  const fallback: Choice = hostedOpen || connections.length === 0 ? { target: "g1t", model: "" } : { target: connections[0].id, model: "" };
  const [choices, setChoices] = useState<Record<ModelTask, Choice>>(() => {
    const initial = {} as Record<ModelTask, Choice>;
    for (const task of MODEL_TASKS) {
      const chosen = choiceOf(routes.find((route) => route.task === task));
      initial[task] = task === "default" && !chosen.target ? fallback : chosen;
    }
    return initial;
  });
  const set = (task: ModelTask, choice: Partial<Choice>) => setChoices((all) => ({ ...all, [task]: { ...all[task], ...choice } }));

  return (
    <Form method="post" className="rounded-xl border border-line bg-surface">
      <input type="hidden" name="intent" value="routes" />
      {connections.map((connection) => (
        <datalist key={connection.id} id={`models-${connection.id}`}>
          {connection.models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      ))}
      <div className="border-b border-line px-4 py-3">
        <p className="text-sm font-medium">Which model does which work</p>
        <p className="text-xs text-muted">
          Each kind of work can go to g1t's models, or to any of your providers on the model you choose. On g1t's models, Auto picks the cheapest model that can do each job and says why on the run.
        </p>
      </div>
      <ul className="divide-y divide-line">
        {MODEL_TASKS.map((task) => {
          const choice = choices[task];
          const connection = connections.find((c) => c.id === choice.target);
          const speaksAnthropic = connection && PROVIDERS[connection.provider] && (connection.provider === "anthropic" || connection.provider === "anthropic_endpoint");
          const needsModel = connection && !speaksAnthropic && !choice.model && !connection.config.model;
          const hosted = choice.target === "g1t";
          const value = !choice.target
            ? ""
            : hosted
              ? choice.model
                ? `g1t::${choice.model}`
                : "g1t"
              : `${choice.target}::${choice.model}`;
          return (
            <li key={task} className="grid items-start gap-2 px-4 py-3 md:grid-cols-[11rem_1fr_1fr]">
              <div className="pt-1.5">
                <p className="text-sm font-medium">{TASK_LABELS[task].label}</p>
                <p className="text-xs text-faint">{TASK_LABELS[task].hint}</p>
              </div>
              <input type="hidden" name={`route-${task}`} value={value} />
              <Select
                disabled={!owner}
                value={choice.target || SAME}
                onValueChange={(target) => set(task, { target: target === SAME ? "" : target, model: "" })}
              >
                <SelectTrigger aria-label={`${TASK_LABELS[task].label}: provider`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {task !== "default" && (
                    <>
                      <SelectItem value={SAME} description="Follows the choice for everything">
                        Same as everything
                      </SelectItem>
                      <SelectSeparator />
                    </>
                  )}
                  <SelectItem
                    value="g1t"
                    disabled={!hostedOpen}
                    icon={<Sparkles />}
                    description={hostedOpen ? "The provider's price, plus the agent rate" : "Not open to this workspace yet"}
                  >
                    g1t's models
                  </SelectItem>
                  {connections.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Your providers</SelectLabel>
                      {connections.map((c) => (
                        <SelectItem key={c.id} value={c.id} icon={<Bot />} description={PROVIDERS[c.provider]?.label}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
              {hosted ? (
                <Select
                  disabled={!owner}
                  value={choice.model || AUTO}
                  onValueChange={(model) => set(task, { model: model === AUTO ? "" : model })}
                >
                  <SelectTrigger aria-label={`${TASK_LABELS[task].label}: g1t's model`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO} description="g1t picks per job, and says why">
                      Auto
                    </SelectItem>
                    <SelectSeparator />
                    {MODEL_TIERS.map((tier) => (
                      <SelectItem key={tier} value={tier} description={TIER_CHOICES[tier].hint}>
                        {TIER_CHOICES[tier].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
              <div>
                <input
                  aria-label={`${TASK_LABELS[task].label}: model`}
                  list={connection ? `models-${connection.id}` : undefined}
                  disabled={!owner || !connection}
                  value={connection ? choice.model : ""}
                  onChange={(event) => set(task, { model: event.target.value })}
                  placeholder={
                    !choice.target
                      ? "Follows everything"
                      : !connection
                        ? "Auto"
                        : speaksAnthropic
                          ? connection.config.model ?? "g1t's choice of Claude"
                          : connection.config.model ?? `Search ${connection.models.length} models`
                  }
                  className={`${SELECT} font-mono text-[0.8125rem] ${needsModel ? "border-warn/60" : ""}`}
                  autoComplete="off"
                />
                {needsModel && <p className="mt-1 text-xs text-warn">Choose a model.</p>}
              </div>
              )}
            </li>
          );
        })}
      </ul>
      {owner && (
        <div className="flex items-center gap-3 border-t border-line px-4 py-3">
          <SubmitButton variant="quiet" match={{ intent: "routes" }} pending="Saving…">
            Save routing
          </SubmitButton>
          {saved && <span className="text-sm text-accent">Saved. The next runs use it.</span>}
        </div>
      )}
    </Form>
  );
}
