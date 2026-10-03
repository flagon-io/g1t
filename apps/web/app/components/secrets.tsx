/**
 * A repository's or a workspace's secrets and variables, as workflows read
 * them: `secrets.NAME` and `vars.NAME`. A repository's list includes what
 * it inherits from its workspace, which its own of the same name replace.
 */
import { KeyRound, Trash2, Variable } from "lucide-react";
import { useEffect, useRef } from "react";
import { Form, useNavigation } from "react-router";

import type { Setting, SettingKind } from "@g1t/contracts";

import type { SecretsAction, SecretsData } from "../lib/secrets.server";
import { Button, EmptyState, ErrorText, Field, Input, Textarea, TimeAgo } from "./ui";

function SettingRow({ setting, kind, manage, inherited }: { setting: Setting; kind: SettingKind; manage: boolean; inherited: boolean }) {
  const busy = useNavigation().state === "submitting";
  return (
    <li className="flex items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0">
      <span className="font-mono text-[0.8125rem]">{setting.name}</span>
      {kind === "variable" && setting.value != null && (
        <span className="min-w-0 truncate font-mono text-xs text-muted">{setting.value}</span>
      )}
      {inherited && (
        <span className="shrink-0 rounded-full px-2 py-px text-xs text-muted ring-1 ring-line">From the workspace</span>
      )}
      <span className="ml-auto shrink-0 text-xs text-faint">
        Updated <TimeAgo at={setting.updatedAt} />
      </span>
      {manage && !inherited && (
        <Form method="post" className="shrink-0">
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="name" value={setting.name} />
          <button
            type="submit"
            disabled={busy}
            aria-label={`Remove ${setting.name}`}
            title="Remove"
            className="rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-danger"
          >
            <Trash2 size={14} />
          </button>
        </Form>
      )}
    </li>
  );
}

function Section({
  kind,
  items,
  scope,
  manage,
  action,
}: {
  kind: SettingKind;
  items: Setting[];
  scope: "repository" | "workspace";
  manage: boolean;
  action: SecretsAction | undefined;
}) {
  const navigation = useNavigation();
  const form = useRef<HTMLFormElement>(null);
  const mine = action?.kind === kind;
  // Clear the form once something was saved.
  useEffect(() => {
    if (mine && action?.done && navigation.state === "idle") form.current?.reset();
  }, [mine, action, navigation.state]);
  const secret = kind === "secret";
  return (
    <section>
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {secret ? <KeyRound size={15} className="text-accent" /> : <Variable size={15} className="text-accent" />}
        {secret ? "Secrets" : "Variables"}
      </h3>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {secret ? (
          <>
            Read in workflows as <code className="text-fg">{"${{ secrets.NAME }}"}</code>. Values are sealed when
            saved, never shown again, and hidden in logs.
          </>
        ) : (
          <>
            Read in workflows as <code className="text-fg">{"${{ vars.NAME }}"}</code>. For settings that are not
            secret; their values are shown.
          </>
        )}
        {scope === "workspace" && " Every repository in the workspace reads these, unless it has its own of the same name."}
      </p>
      <div className="mt-4">
        {items.length === 0 ? (
          <EmptyState title={secret ? "No secrets yet" : "No variables yet"} />
        ) : (
          <ul className="overflow-hidden rounded-xl border border-line bg-surface">
            {items.map((item) => (
              <SettingRow key={`${item.scope}:${item.name}`} setting={item} kind={kind} manage={manage} inherited={item.scope !== scope} />
            ))}
          </ul>
        )}
      </div>
      {manage && (
        <Form ref={form} method="post" className="mt-4 grid gap-3 rounded-xl border border-line bg-surface p-4">
          <input type="hidden" name="intent" value="set" />
          <input type="hidden" name="kind" value={kind} />
          <Field label="Name" hint="Letters, digits and underscores. Saving one that exists replaces it.">
            <Input name="name" required placeholder={secret ? "NPM_TOKEN" : "DEPLOY_REGION"} autoComplete="off" />
          </Field>
          <Field label="Value">
            {secret ? (
              <Textarea name="value" required rows={3} autoComplete="off" spellCheck={false} />
            ) : (
              <Input name="value" autoComplete="off" />
            )}
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={navigation.state === "submitting"}>
              {secret ? "Save secret" : "Save variable"}
            </Button>
            {mine && action?.done && <span className="text-sm text-muted">{action.done}</span>}
          </div>
          {mine && <ErrorText>{action?.error}</ErrorText>}
        </Form>
      )}
    </section>
  );
}

export function SecretsPanel({
  data,
  action,
  scope,
  manage,
}: {
  data: SecretsData;
  action: SecretsAction | undefined;
  scope: "repository" | "workspace";
  manage: boolean;
}) {
  return (
    <div className="max-w-4xl space-y-12">
      <ErrorText>{data.error}</ErrorText>
      <Section kind="secret" items={data.secrets} scope={scope} manage={manage} action={action} />
      <Section kind="variable" items={data.variables} scope={scope} manage={manage} action={action} />
    </div>
  );
}
