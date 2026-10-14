/**
 * Ask's model picker (Settings → AI → Ask g1t): Auto
 * first and chosen by default, then each model the provider listed. Pure,
 * so it is tested on its own (ask-model.test.ts).
 */
import type { ASK_AUTO_MODEL as AutoModel, AiConnection, AskSetup } from "@g1t/contracts";

/** `ASK_AUTO_MODEL`: the model name that chooses Auto. */
const ASK_AUTO_MODEL: typeof AutoModel = "auto";

export type ModelOption = { value: string; label: string; description?: string };

/** Whether Auto can choose on an AI provider: it lists its models, and it is not an Azure deployment. */
export function autoOffered(connection: Pick<AiConnection, "provider" | "models"> | null): boolean {
  return connection != null && connection.provider !== "azure_openai" && connection.models.length > 0;
}

/** The picker's options for an AI provider: Auto, then its models. */
export function modelOptions(connection: Pick<AiConnection, "provider" | "models">): ModelOption[] {
  const models = connection.models.map((model) => ({ value: model, label: model }));
  if (!autoOffered(connection)) return models;
  return [{ value: ASK_AUTO_MODEL, label: "Auto", description: "A fast model for lookups, a stronger one when a question needs it" }, ...models];
}

/**
 * What the picker starts at: for the AI provider Ask uses, what was chosen
 * (Auto unless a model was); for another, Auto where it is offered, else
 * the provider's own model or the first it lists.
 */
export function defaultModel(
  connection: Pick<AiConnection, "id" | "provider" | "models" | "config"> | null,
  setup: Pick<AskSetup, "provider_id" | "model" | "auto"> | null,
): string {
  if (!connection) return "";
  const offered = autoOffered(connection);
  if (setup && connection.id === setup.provider_id) {
    if (setup.auto && offered) return ASK_AUTO_MODEL;
    if (setup.model && (!offered || connection.models.includes(setup.model))) return setup.model;
  }
  if (offered) return ASK_AUTO_MODEL;
  return connection.config.model ?? connection.models[0] ?? "";
}

/** How the chosen model reads: "Auto", or the model's name. */
export function modelLabel(setup: Pick<AskSetup, "model" | "auto"> | null): string {
  if (setup?.auto) return setup.model ? `Auto · ${setup.model}` : "Auto";
  return setup?.model ?? "";
}
