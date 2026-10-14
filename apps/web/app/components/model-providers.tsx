/**
 * A workspace's AI providers, on its AI page: the catalogue people choose
 * from, and the fields each one asks for when it is added. The marks and
 * tiles are drawn like the integrations' (components/connectors).
 */
import type { ReactNode } from "react";

import type { AiProvider } from "@g1t/contracts";

import { AI_PROVIDER_GROUPS, AI_PROVIDER_LOOKS, aiProvidersIn, isEndpoint } from "../lib/ai-providers";
import { AiProviderTiles } from "./connectors";
import { Field, Input } from "./ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/** The AI providers to choose from, grouped. */
export function ModelCatalog({ slug, adding }: { slug: string; adding: AiProvider | null }) {
  return (
    <div className="mt-4 space-y-4">
      {AI_PROVIDER_GROUPS.map(({ group, title }) => (
        <div key={group}>
          <p className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">{title}</p>
          <AiProviderTiles providers={aiProvidersIn(group)} slug={slug} adding={adding} />
        </div>
      ))}
    </div>
  );
}

/** What adding an AI provider asks for. */
export function ModelProviderFields({ provider }: { provider: AiProvider }): ReactNode {
  const look = AI_PROVIDER_LOOKS[provider];
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
  if (isEndpoint(provider)) {
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
        hint={`${look.keyUrl ? `Get one at ${new URL(look.keyUrl).host}. ` : ""}Sealed when saved: nobody sees it again.`}
      >
        <Input name="secret" type="password" required placeholder={look.keyPlaceholder} autoComplete="new-password" />
      </Field>
      <Field label="Model" hint="Optional. The model your team uses on it. g1t lists the key's models when it checks the key.">
        <Input name="model" placeholder={look.model} />
      </Field>
      {provider === "anthropic" && <ConsoleWorkspaceField />}
    </>
  );
}

/**
 * The Console workspace an Anthropic key belongs to: links to the sessions
 * it starts open there. Sessions don't say which workspace they are in.
 */
export function ConsoleWorkspaceField({ defaultValue }: { defaultValue?: string }) {
  return (
    <Field
      label="Console workspace"
      hint="Optional. Paste any Console address from the workspace the key belongs to, or its wrkspc_ id, so session links open there. Empty means the Default workspace."
    >
      <Input
        name="consoleWorkspace"
        defaultValue={defaultValue ?? ""}
        placeholder="https://platform.claude.com/workspaces/wrkspc_…"
        className="max-w-sm font-mono text-[0.8125rem]"
        autoComplete="off"
      />
    </Field>
  );
}
