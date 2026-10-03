import type { Setting, SettingKind, SettingsOwner, User } from "@g1t/contracts";

import { actions } from "./services.server";

export type SecretsData = {
  secrets: Setting[];
  variables: Setting[];
  error: string | null;
};

/** A repository's or a workspace's secrets and variables. */
export async function loadSecrets(owner: SettingsOwner, actor: User): Promise<SecretsData> {
  const [secrets, variables] = await Promise.all([
    actions.settings(actor, owner, "secret"),
    actions.settings(actor, owner, "variable"),
  ]);
  return {
    secrets: secrets.ok ? secrets.value : [],
    variables: variables.ok ? variables.value : [],
    error: !secrets.ok ? secrets.error.message : !variables.ok ? variables.error.message : null,
  };
}

export type SecretsAction = { done?: string; error?: string; kind?: SettingKind };

export async function actOnSecrets(owner: SettingsOwner, actor: User, form: FormData): Promise<SecretsAction> {
  const intent = String(form.get("intent") ?? "");
  const kind: SettingKind = form.get("kind") === "variable" ? "variable" : "secret";
  const name = String(form.get("name") ?? "").trim();
  const what = kind === "secret" ? "Secret" : "Variable";
  if (intent === "delete") {
    const removed = await actions.deleteSetting(actor, owner, kind, name);
    return removed.ok ? { done: `${what} ${name} removed.`, kind } : { error: removed.error.message, kind };
  }
  const value = String(form.get("value") ?? "");
  if (!name) return { error: "Give it a name.", kind };
  if (kind === "secret" && !value) return { error: "Give the secret a value.", kind };
  const saved = await actions.setSetting(actor, owner, kind, name, value);
  return saved.ok ? { done: `${what} ${saved.value.name} saved.`, kind } : { error: saved.error.message, kind };
}
