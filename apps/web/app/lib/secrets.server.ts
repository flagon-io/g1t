import { redirect } from "react-router";

import type { Setting, SettingKind, SettingReader, SettingsOwner, User } from "@g1t/contracts";

import { actions, repos } from "./services.server";

export type SecretsData = {
  rows: Setting[];
  /** For a workspace: its repositories, to link rows to. */
  repositories: string[];
  error: string | null;
};

/** A repository's or a workspace's secrets and variables, as one list. */
export async function loadSecrets(owner: SettingsOwner, actor: User): Promise<SecretsData> {
  const [rows, list] = await Promise.all([
    actions.settings(actor, owner, "all"),
    "workspace" in owner ? repos.list(actor, { namespace: owner.workspace }) : Promise.resolve(null),
  ]);
  return {
    rows: rows.ok ? rows.value : [],
    repositories: Array.isArray(list) ? list.filter((repo) => !repo.forkOf).map((repo) => repo.name).sort() : [],
    error: rows.ok ? null : rows.error.message,
  };
}

export type SecretsAction = { error?: string };

/** `KEY=value` lines, as a .env file has them; quotes around a value are dropped. */
function parseDotenv(text: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    let value = line.slice(at + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    pairs.push([line.slice(0, at).trim(), value]);
  }
  return pairs;
}

/**
 * Saves the side panel's form (one row, or many pasted as a .env file), or
 * removes a row, then returns to the list.
 */
export async function actOnSecrets(owner: SettingsOwner, actor: User, form: FormData, page: string): Promise<SecretsAction> {
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "") || undefined;
  if (intent === "delete") {
    const removed = await actions.deleteSetting(actor, owner, "all", String(form.get("name") ?? ""), id);
    if (!removed.ok) return { error: removed.error.message };
    throw redirect(page);
  }
  const kind: SettingKind = form.get("type") === "config" ? "variable" : "secret";
  const environments =
    form.get("scope") === "some"
      ? [
          ...form.getAll("env").map(String),
          ...String(form.get("envCustom") ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        ]
      : [];
  if (form.get("scope") === "some" && environments.length === 0) {
    return { error: "Choose at least one environment, or All environments." };
  }
  const availableTo = form.getAll("availableTo").map(String) as SettingReader[];
  if (availableTo.length === 0) return { error: "Choose who reads it: Workflows, Deployments, or both." };
  const repositories =
    "workspace" in owner && form.get("reach") === "some" ? form.getAll("repo").map(String) : [];
  const note = String(form.get("note") ?? "");
  const key = String(form.get("key") ?? "").trim();
  const value = String(form.get("value") ?? "");
  // A pasted .env file adds a row for each line.
  const pasted = !id && key.includes("=") ? parseDotenv(key) : [];
  const entries: [string, string | null][] = pasted.length > 0 ? pasted : [[key, value === "" && id ? null : value]];
  for (const [name, entryValue] of entries) {
    if (!name) return { error: "Give it a key." };
    if (entryValue === "" && !id) return { error: `Give ${name} a value.` };
    const saved = await actions.setSetting(actor, owner, kind, name, entryValue, {
      id,
      availableTo,
      environments,
      repositories: "workspace" in owner ? repositories : undefined,
      note,
    });
    if (!saved.ok) return { error: pasted.length > 0 ? `${name}: ${saved.error.message}` : saved.error.message };
  }
  throw redirect(page);
}
