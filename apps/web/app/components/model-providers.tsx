/**
 * A workspace's AI providers: the catalogue people choose from, and the
 * fields each one asks for when it is added. The marks and tiles are the
 * integrations' own (components/connectors).
 */
import type { ReactNode } from "react";

import type { Provider } from "@g1t/contracts";

import { AI_PROVIDER_GROUPS, AI_PROVIDERS, aiProvidersIn } from "../lib/ai-providers";
import { ProviderTiles } from "./connectors";
import { Field, Input } from "./ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/** The AI providers to choose from, grouped. */
export function ModelCatalog({ slug, adding }: { slug: string; adding: Provider | null }) {
  return (
    <div className="mt-4 space-y-4">
      {AI_PROVIDER_GROUPS.map(({ group, title }) => (
        <div key={group}>
          <p className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">{title}</p>
          <ProviderTiles
            providers={aiProvidersIn(group)}
            slug={slug}
            adding={adding}
            blurb={(provider) => AI_PROVIDERS[provider]?.blurb ?? ""}
          />
        </div>
      ))}
    </div>
  );
}

/** What adding an AI provider asks for. */
export function ModelProviderFields({ provider }: { provider: Provider }): ReactNode {
  const entry = AI_PROVIDERS[provider];
  if (provider === "azure_openai") {
    return (
      <>
        <Field label="Endpoint" hint="Your resource's endpoint, from the Azure portal: Keys and Endpoint.">
          <Input name="baseUrl" type="url" required placeholder="https://acme.openai.azure.com" />
        </Field>
        <Field label="Key" hint="KEY 1 or KEY 2 of the resource. Sealed when saved: nobody sees it again.">
          <Input name="secret" type="password" required autoComplete="new-password" />
        </Field>
        <Field label="Deployment" hint="The name of the model deployment. Add one provider for each deployment your team uses.">
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
          hint={anthropic ? "Without /v1, such as https://llm.acme.dev." : "Up to and including the version, such as https://llm.acme.dev/v1."}
        >
          <Input name="baseUrl" type="url" required placeholder={anthropic ? "https://llm.acme.dev" : "https://llm.acme.dev/v1"} />
        </Field>
        <Field label="Key" hint="Optional, if the endpoint needs one. Sealed when saved: nobody sees it again.">
          <Input name="secret" type="password" autoComplete="new-password" />
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
        <Field label="Model" hint="Optional. The model your team uses on it.">
          <Input name="model" placeholder={anthropic ? "claude-sonnet-5-5" : "qwen3-coder"} />
        </Field>
      </>
    );
  }
  return (
    <>
      <Field
        label="API key"
        hint={`${entry?.keyUrl ? `Get one at ${new URL(entry.keyUrl).host}. ` : ""}Sealed when saved: nobody sees it again.`}
      >
        <Input name="secret" type="password" required placeholder={entry?.keyPlaceholder} autoComplete="new-password" />
      </Field>
      <Field label="Model" hint="Optional. The model your team uses on it. g1t lists the key's models when it checks the key.">
        <Input name="model" placeholder={entry?.model} />
      </Field>
    </>
  );
}
