import { ArrowRight, Signpost } from "lucide-react";
import { Link, data, redirect } from "react-router";

import type { WorkspaceAlias } from "@g1t/contracts";

import type { Route } from "./+types/aliases";
import { Button, EmptyState, Field, Input, Notice, PageHeader, Section, Textarea, When } from "~/components/ui";
import { MAX_ALIAS_NOTE, parseNewAlias, parseRemovalReason } from "~/lib/aliases";
import { text } from "~/lib/forms";
import { identity } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Aliases · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const aliases = await settle(identity.aliases());
  const done = url.searchParams.get("done");
  const name = url.searchParams.get("alias") ?? "";
  return {
    aliases: aliases.ok ? aliases.value : [],
    error: aliases.ok ? null : aliases.error,
    done: done === "added" ? `${name} is an alias now.` : done === "removed" ? `Removed ${name}.` : null,
  };
}

type ActionData = { error: string; alias?: string; values?: { alias: string; workspace: string; note: string } };

/**
 * Adding and removing. Identity checks each again (a person's or a
 * workspace's name is never an alias) and records it in sudo's audit log,
 * naming the staff member.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const back = (done: string, alias: string) => redirect(`/aliases?done=${done}&alias=${encodeURIComponent(alias)}`);
  switch (text(form, "intent")) {
    case "add": {
      const values = { alias: text(form, "alias"), workspace: text(form, "workspace"), note: text(form, "note") };
      const parsed = parseNewAlias(values.alias, values.workspace, values.note);
      if (!parsed.ok) return data<ActionData>({ error: parsed.error, values }, { status: 422 });
      const { alias, workspace, note } = parsed.value;
      const result = await identity.setAlias(alias, workspace, note, staff.email);
      if (!result.ok) return data<ActionData>({ error: result.error.message, values }, { status: 422 });
      throw back("added", alias);
    }
    case "remove": {
      const alias = text(form, "alias");
      const reason = parseRemovalReason(text(form, "reason"));
      if (!reason.ok) return data<ActionData>({ error: reason.error, alias }, { status: 422 });
      const result = await identity.removeAlias(alias, reason.value, staff.email);
      if (!result.ok) return data<ActionData>({ error: result.error.message, alias }, { status: 422 });
      throw back("removed", alias);
    }
  }
  return data<ActionData>({ error: "Unknown action." }, { status: 400 });
}

export default function Aliases({ loaderData, actionData }: Route.ComponentProps) {
  const { aliases, error, done } = loaderData;
  const adding = actionData && !actionData.alias ? actionData : null;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Aliases"
        description="Names that lead to a workspace. Every address under an alias (pages, git, the API, packages) leads to the workspace under its own name, and the alias follows it through renames. Only staff set them, for a company's trading name such as g1t for Flagon, Inc.; customers cannot make one."
      />
      <div className="mt-6 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">Identity did not answer: {error}</Notice>}
      </div>
      <div className="mt-6">
        {aliases.length === 0 ? (
          <EmptyState title="No aliases">An alias appears here once staff add one below.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {aliases.map((alias) => (
              <AliasRow key={alias.alias} alias={alias} error={actionData && actionData.alias === alias.alias ? actionData.error : null} />
            ))}
          </ul>
        )}
      </div>
      <Section
        className="mt-6"
        title="Add an alias"
        description="A name nobody has: never a person's username or a workspace's slug, and not one of the site's own routes. Reserved names such as g1t can be. It is nobody's to register while it is an alias."
      >
        <form method="post" className="space-y-3">
          <input type="hidden" name="intent" value="add" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Alias">
              <Input name="alias" required maxLength={39} spellCheck={false} placeholder="acme-corp" defaultValue={adding?.values?.alias} className="font-mono" />
            </Field>
            <Field label="Leads to workspace">
              <Input
                name="workspace"
                required
                maxLength={39}
                spellCheck={false}
                placeholder="acme"
                defaultValue={adding?.values?.workspace}
                className="font-mono"
              />
            </Field>
          </div>
          <Field label="Why" hint="Kept with the alias, and in the audit log.">
            <Textarea
              name="note"
              rows={2}
              maxLength={MAX_ALIAS_NOTE}
              required
              placeholder="e.g. Acme's trading name, asked for by their CTO."
              defaultValue={adding?.values?.note}
            />
          </Field>
          {adding && <Notice tone="error">{adding.error}</Notice>}
          <div className="flex justify-end">
            <Button type="submit" variant="lavender">
              <Signpost size={14} />
              Add alias
            </Button>
          </div>
        </form>
      </Section>
    </main>
  );
}

function AliasRow({ alias, error }: { alias: WorkspaceAlias; error: string | null }) {
  return (
    <li id={`alias-${alias.alias}`} className="scroll-mt-20 rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono font-medium">{alias.alias}</span>
        <ArrowRight size={14} className="text-faint" aria-label="leads to" />
        <Link to={`/workspaces/${alias.workspace}`} className="font-mono hover:underline">
          {alias.workspace}
        </Link>
        <span className="text-sm text-muted">{alias.workspaceName}</span>
      </div>
      <p className="mt-2 text-sm text-fg-soft">{alias.note || <span className="text-faint">No note.</span>}</p>
      <p className="mt-1 text-xs text-muted">
        Added by <span className="text-fg-soft">{alias.createdBy}</span> <When at={alias.createdAt} time />
      </p>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <form method="post" action={`/aliases#alias-${alias.alias}`} className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end">
        <input type="hidden" name="intent" value="remove" />
        <input type="hidden" name="alias" value={alias.alias} />
        <label className="grid flex-1 gap-1 text-xs text-muted">
          <span>Why remove it</span>
          <Input name="reason" required maxLength={MAX_ALIAS_NOTE} aria-label={`Why remove ${alias.alias}`} />
        </label>
        <Button type="submit" variant="danger">
          Remove
        </Button>
      </form>
    </li>
  );
}
