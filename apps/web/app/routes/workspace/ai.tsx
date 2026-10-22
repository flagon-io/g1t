import { AlertTriangle, CheckCircle2, ChevronRight, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { Form, Link } from "react-router";

import { type AiConnection, type AiProvider, type AskSetup, AI_PROVIDERS, aiOwnAddress, isAiProvider } from "@g1t/contracts";

import type { Route } from "./+types/ai";
import { page } from "../../lib/meta";
import { AiProviderMark } from "../../components/connectors";
import { GettingStartedButton } from "../../components/onboarding";
import { ConsoleWorkspaceField, ModelCatalog, ModelProviderFields } from "../../components/model-providers";
import { AI_PROVIDER_LOOKS, isEndpoint } from "../../lib/ai-providers";
import { ErrorText, Field, Input, SubmitButton, TimeAgo } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { Combobox } from "../../components/ui/combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { autoOffered, defaultModel as startingModel, modelLabel, modelOptions } from "../../lib/ask-model";
import { ai } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";
import { Unavailable } from "../../components/boundary";
import { isFailed, part } from "../../lib/partial";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `AI · ${params.owner} · g1t` });
}

/**
 * The workspace's AI: the providers it keeps keys for (a frontier lab, a
 * platform, or a model it hosts itself) and which one Ask g1t answers
 * with. It is the workspace's own setting, not an integration: the
 * Integrations directory is for connecting other products.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw new Response(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  // The providers are what the page is about. Ask's setting is a section
  // beside them: when it does not answer, that section says so instead of
  // offering a form that would save over a choice it could not read.
  const [connections, ask] = await Promise.all([ai.list(slug, viewer), part(ai.askSettings(slug, viewer), "Ask g1t's provider")]);
  const adding = new URL(request.url).searchParams.get("add");
  return {
    slug,
    owner: role === "owner",
    connections: unwrap(connections),
    adding: adding && isAiProvider(adding) ? adding : null,
    ask: isFailed(ask) ? ask : ask.ok ? ask.value : null,
  };
}

function text(form: FormData, name: string): string | undefined {
  const value = String(form.get(name) ?? "").trim();
  return value || undefined;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const form = await request.formData();
  const intent = form.get("intent");
  const id = String(form.get("id") ?? "");
  if (intent === "remove") {
    const removed = await ai.remove(user, slug, id);
    return { error: removed.ok ? null : removed.error.message };
  }
  if (intent === "test") {
    const tested = await ai.test(user, slug, id);
    return tested.ok ? { tested: { id, ...tested.value } } : { error: tested.error.message };
  }
  if (intent === "ask") {
    // Which provider and model Ask g1t answers with; none turns it off.
    const providerId = text(form, "providerId");
    const chosen = await ai.setAskSettings(user, slug, providerId ?? null, providerId ? (text(form, "model") ?? null) : null);
    return chosen.ok ? { asked: true } : { error: chosen.error.message, ask: true };
  }
  if (intent === "provider") {
    // A provider's model and address, and a new key if one was given: its
    // other settings as they are.
    const listed = await ai.list(slug, user);
    const connection = listed.ok ? listed.value.find((c) => c.id === id) : undefined;
    if (!connection) return { error: listed.ok ? "No such AI provider." : listed.error.message };
    const updated = await ai.update(user, slug, id, {
      config: {
        ...connection.config,
        model: text(form, "model"),
        ...(form.has("baseUrl") ? { baseUrl: text(form, "baseUrl") } : {}),
        ...(form.has("consoleWorkspace") ? { consoleWorkspace: text(form, "consoleWorkspace") } : {}),
      },
      secret: text(form, "secret"),
    });
    return updated.ok ? { updated: id } : { error: updated.error.message };
  }
  const provider = String(form.get("provider") ?? "");
  if (!isAiProvider(provider)) return { error: "Choose an AI provider." };
  const added = await ai.add(user, slug, {
    provider,
    name: text(form, "name"),
    config: {
      baseUrl: text(form, "baseUrl"),
      authHeader: text(form, "authHeader"),
      model: text(form, "model"),
      consoleWorkspace: text(form, "consoleWorkspace"),
    },
    secret: text(form, "secret"),
  });
  if (!added.ok) return { error: added.error.message, provider };
  return { added: added.value };
}

export default function WorkspaceAi({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, owner, connections, adding, ask } = loaderData;
  const justAdded = actionData && "added" in actionData ? actionData.added : null;
  const tested = (actionData && "tested" in actionData ? actionData.tested : null) ?? null;
  const error = (actionData && "error" in actionData ? actionData.error : null) ?? null;
  const updated = (actionData && "updated" in actionData ? actionData.updated : null) ?? null;
  const asked = actionData != null && "asked" in actionData;
  const askError = actionData && "ask" in actionData ? error : null;
  const addError = actionData && "provider" in actionData ? error : null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight [&_svg]:size-5">
          <span className="text-muted">
            <Sparkles size={16} />
          </span>
          AI
        </h1>
        {owner && <GettingStartedButton slug={slug} />}
      </div>
      <p className="mt-1.5 mb-6 border-b border-line pb-6 text-sm text-muted">
        The models g1t works with in {slug}, on your own keys: Ask and @g1t in Chat answer with one, and an Anthropic key starts sessions on work items. Use a
        frontier lab or a platform, or a model you host yourself. g1t hosts no model for this and bills nothing for it: what it costs is on your provider's
        bill.
      </p>
      {justAdded && <Added connection={justAdded} />}
      <ErrorText>{askError || addError ? null : error}</ErrorText>

      {isFailed(ask) ? (
        <section aria-labelledby="ask-heading" className="mb-8">
          <h2 id="ask-heading" className="mb-3 text-sm font-medium">
            Ask g1t
          </h2>
          <Unavailable what={ask.what} />
        </section>
      ) : (
        <AskSetting connections={connections} setup={ask} owner={owner} saved={asked} error={askError} />
      )}

      <section aria-labelledby="providers-heading">
        <h2 id="providers-heading" className="mb-3 text-sm font-medium">
          Providers
        </h2>
        {connections.length === 0 ? (
          <p className="mb-4 text-sm text-muted">{owner ? "None yet. Add one below." : `None yet. An owner of ${slug} can add one.`}</p>
        ) : (
          <Card asChild divided className="mb-4 overflow-hidden">
            <ul>
              {connections.map((connection) => (
                <li key={connection.id} className="p-4">
                  <ProviderRow connection={connection} owner={owner} tested={tested} updated={updated === connection.id} />
                </li>
              ))}
            </ul>
          </Card>
        )}
        <p className="mb-6 text-xs text-faint">
          Keys are sealed when saved and never shown again. Only an owner of {slug} can add, test, change or remove them.
        </p>
      </section>

      {owner && (
        <section aria-labelledby="add-heading">
          <h2 id="add-heading" className="text-sm font-medium">
            Add a provider
          </h2>
          <ModelCatalog slug={slug} adding={adding} />
          {adding && <AddForm provider={adding} slug={slug} error={addError} />}
        </section>
      )}
    </div>
  );
}

/** Just the host of an address, which is what tells providers apart. */
function host(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ProviderRow({
  connection,
  owner,
  tested,
  updated,
}: {
  connection: AiConnection;
  owner: boolean;
  tested: { id: string; ok: boolean; message: string } | null;
  updated: boolean;
}) {
  const { config } = connection;
  const facts = [
    AI_PROVIDERS[connection.provider].label,
    host(config.baseUrl),
    config.model && `model ${config.model}`,
    connection.models.length > 0 && `${connection.models.length} models`,
    connection.secretHint && `key ${connection.secretHint}`,
  ].filter(Boolean);
  return (
    <div>
      <div className="flex items-center gap-3">
        <AiProviderMark provider={connection.provider} />
        <div className="min-w-0 grow">
          <p className="truncate text-sm font-medium">{connection.name}</p>
          <p className="truncate text-xs text-muted">{facts.join(" · ")}</p>
        </div>
        {connection.lastUsedAt && (
          <span className="hidden shrink-0 text-xs text-faint sm:inline">
            Used <TimeAgo at={connection.lastUsedAt} />
          </span>
        )}
        {owner && (
          <Form method="post" className="flex shrink-0 gap-2">
            <input type="hidden" name="id" value={connection.id} />
            <SubmitButton variant="outline" name="intent" value="test" match={{ id: connection.id }} pending="Testing…">
              Test
            </SubmitButton>
            <SubmitButton variant="outline" name="intent" value="remove" match={{ id: connection.id }} pending="Removing…" aria-label="Remove">
              <X size={14} />
            </SubmitButton>
          </Form>
        )}
      </div>
      {tested?.id === connection.id && <p className={`mt-3 text-sm ${tested.ok ? "text-success" : "text-danger"}`}>{tested.message}</p>}
      {connection.lastError && (
        <p className="mt-3 flex items-start gap-2 text-xs text-warn">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {connection.lastError}
        </p>
      )}
      {owner && <ProviderSettings connection={connection} updated={updated} />}
    </div>
  );
}

/**
 * Ask g1t's provider and model: one of the workspace's AI providers, and
 * Auto (the default: a model for each question) or one of the models it
 * offered when last checked (or any name, for one that lists none). Owners
 * choose; members see what it is.
 */
function AskSetting({
  connections,
  setup,
  owner,
  saved,
  error,
}: {
  connections: AiConnection[];
  setup: AskSetup | null;
  owner: boolean;
  saved: boolean;
  error: string | null;
}) {
  const current = connections.find((c) => c.id === setup?.provider_id) ?? null;
  const [chosen, setChosen] = useState(current?.id ?? connections[0]?.id ?? "");
  const connection = connections.find((c) => c.id === chosen) ?? null;
  const azure = connection?.provider === "azure_openai";
  const defaultModel = startingModel(connection, setup);
  return (
    <Card asChild className="mb-8 scroll-mt-[calc(var(--topbar-h)+1rem)] p-4">
      <section id="ask" aria-labelledby="ask-heading">
        <h2 id="ask-heading" className="text-sm font-medium">
          Ask g1t
        </h2>
        <p className="mt-1 text-xs text-muted">The top bar's Ask, and @g1t in Chat, answer with this provider and model.</p>
        {setup?.provider_id && !setup.problem && (
          <p className="mt-3 text-sm">
            Answers with <span className="font-medium">{setup.provider_name}</span> · <span className="font-mono text-[0.8125rem]">{modelLabel(setup)}</span>
          </p>
        )}
        {setup?.problem && <p className="mt-3 text-sm text-warn">{setup.problem}</p>}
        {connections.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            {owner ? "Add an AI provider below, then choose it here." : "An owner of the workspace can add one and choose it here."}
          </p>
        ) : (
          owner && (
            <Form method="post" className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <input type="hidden" name="intent" value="ask" />
              <Field label="Provider">
                <Select name="providerId" value={chosen} onValueChange={setChosen}>
                  <SelectTrigger aria-label="Provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((c) => (
                      <SelectItem key={c.id} value={c.id} description={AI_PROVIDERS[c.provider].label}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={azure ? "Deployment" : "Model"}>
                {autoOffered(connection) && connection ? (
                  <Combobox
                    key={connection.id}
                    name="model"
                    defaultValue={defaultModel}
                    aria-label="Model"
                    searchPlaceholder="Find a model"
                    emptyText="It offers no model by that name."
                    options={modelOptions(connection)}
                    className="font-mono text-[0.8125rem]"
                  />
                ) : (
                  <Input
                    key={connection?.id}
                    name="model"
                    required
                    defaultValue={defaultModel}
                    placeholder={azure ? "The deployment's name" : "The model's name"}
                    className="font-mono text-[0.8125rem]"
                    autoComplete="off"
                  />
                )}
              </Field>
              <div className="flex items-center gap-2">
                <SubmitButton variant="outline" match={{ intent: "ask" }} pending="Saving…">
                  Use for Ask
                </SubmitButton>
              </div>
            </Form>
          )
        )}
        {owner && setup?.provider_id && (
          <Form method="post" className="mt-2">
            <input type="hidden" name="intent" value="ask" />
            <SubmitButton variant="link" size="inline" match={{ intent: "ask" }} className="text-xs text-muted">
              Turn Ask off
            </SubmitButton>
          </Form>
        )}
        {saved && !error && <p className="mt-2 text-sm text-success">Saved.</p>}
        <ErrorText>{error}</ErrorText>
      </section>
    </Card>
  );
}

/** Changing an AI provider after it is added: its model, its address, a new key. */
function ProviderSettings({ connection, updated }: { connection: AiConnection; updated: boolean }) {
  const azure = connection.provider === "azure_openai";
  const ownAddress = aiOwnAddress(connection.provider);
  return (
    <details className="group mt-3" open={updated || undefined}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-fg">
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
        {connection.provider === "anthropic" ? "Change its model, Console workspace or key" : "Change its model, address or key"}
      </summary>
      <Form method="post" className="mt-3 max-w-2xl space-y-3">
        <input type="hidden" name="intent" value="provider" />
        <input type="hidden" name="id" value={connection.id} />
        {ownAddress && (
          <Field label="Base URL">
            <Input name="baseUrl" type="url" required defaultValue={connection.config.baseUrl ?? ""} className="max-w-sm" />
          </Field>
        )}
        <Field
          label={azure ? "Deployment" : "Model"}
          hint={
            azure
              ? undefined
              : connection.provider === "anthropic"
                ? "Optional, and separate from Ask's model above. Sessions on work items run on Ask's model when it names one, else this one, else claude-opus-5-5."
                : "Optional, and separate from Ask's model above: the model your team uses on it."
          }
        >
          <Input
            name="model"
            required={azure}
            placeholder={azure ? undefined : "None"}
            defaultValue={connection.config.model ?? ""}
            list={connection.models.length > 0 ? `models-${connection.id}` : undefined}
            className="max-w-sm font-mono text-[0.8125rem]"
            autoComplete="off"
          />
        </Field>
        {connection.models.length > 0 && (
          <datalist id={`models-${connection.id}`}>
            {connection.models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        )}
        {connection.provider === "anthropic" && <ConsoleWorkspaceField defaultValue={connection.config.consoleWorkspace} />}
        <Field label="Replace the key" hint="Write-only: g1t never shows it again. Leave it empty to keep the key you have.">
          <Input
            name="secret"
            type="password"
            placeholder={connection.secretHint ? `Now ${connection.secretHint}` : "Paste a key"}
            autoComplete="new-password"
            className="max-w-sm"
          />
        </Field>
        <div className="flex items-center gap-3">
          <SubmitButton variant="outline" match={{ intent: "provider", id: connection.id }} pending="Saving…">
            Save
          </SubmitButton>
          {updated && <span className="text-sm text-success">Saved.</span>}
        </div>
      </Form>
    </details>
  );
}

function AddForm({ provider, slug, error }: { provider: AiProvider; slug: string; error: string | null }) {
  return (
    <Card asChild className="mt-4 scroll-mt-[calc(var(--topbar-h)+1rem)] p-5">
      <section id="add">
        <div className="flex items-center gap-3">
          <AiProviderMark provider={provider} />
          <div className="grow">
            <h3 className="font-medium">Add {isEndpoint(provider) ? `an ${AI_PROVIDERS[provider].label}` : AI_PROVIDERS[provider].label}</h3>
            <p className="text-xs text-muted">{AI_PROVIDER_LOOKS[provider].blurb}</p>
          </div>
          <Link to={`/${slug}/-/settings/ai`} className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg" aria-label="Close">
            <X size={16} />
          </Link>
        </div>
        <Form method="post" className="mt-5 grid max-w-xl gap-4">
          <input type="hidden" name="provider" value={provider} />
          <ModelProviderFields provider={provider} />
          <ErrorText>{error}</ErrorText>
          <div>
            <SubmitButton match={{ provider }} pending="Adding…">
              Add
            </SubmitButton>
          </div>
        </Form>
      </section>
    </Card>
  );
}

/** What happened, right after adding a provider: shown once. */
function Added({ connection }: { connection: AiConnection }) {
  return (
    <div className="mb-6 rounded-xl border border-success-dim/60 bg-success/5 p-5">
      <p className="flex items-center gap-2 font-medium">
        <CheckCircle2 size={16} className="text-success" />
        {connection.name} is added.
      </p>
      <p className="mt-2 text-sm text-muted">
        {connection.lastError
          ? `It was saved, but the check failed: ${connection.lastError}`
          : connection.models.length > 0
            ? `The key works, and it offers ${connection.models.length} models.`
            : "The key is saved. Use Test to check it again."}
      </p>
    </div>
  );
}
