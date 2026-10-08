import { LoaderCircle, Plus, Search, Tag, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link, useActionData } from "react-router";

import type { Label } from "@g1t/contracts";

import type { Route } from "./+types/labels";
import { LabelChip } from "../../components/labels";
import { Button, EmptyState, ErrorText, SubmitButton, usePending } from "../../components/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { refusal, requireRepo } from "../../lib/access.server";
import { matchLabels, tidyColor } from "../../lib/labels";
import { page } from "../../lib/meta";
import { work } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Labels · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { viewer, access } = await requireRepo(context, params, "read");
  const labels = await work.listLabels({ namespace: params.owner, name: params.repo }, viewer);
  return { labels: unwrap(labels), canEdit: access.can.triage };
}

type ActionData = { intent: string; name?: string; error?: string; done?: string };

export async function action({ request, params, context }: Route.ActionArgs): Promise<ActionData> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const name = String(form.get("name") ?? "");
  // Labels are managed with the Triage role.
  const refused = await refusal(context, params, "triage");
  if (refused) return { intent, name, error: refused };
  const path = { namespace: params.owner, name: params.repo };
  const text = (key: string) => String(form.get(key) ?? "");
  switch (intent) {
    case "defaults": {
      const added = await work.addDefaultLabels(user, path);
      return added.ok ? { intent, done: "The default labels are here." } : { intent, error: added.error.message };
    }
    case "delete": {
      const deleted = await work.deleteLabel(user, path, name);
      return deleted.ok ? { intent, name } : { intent, name, error: deleted.error.message };
    }
    case "create":
    case "edit": {
      const saved = await work.saveLabel(user, path, {
        name: intent === "edit" ? name : undefined,
        newName: text("newName"),
        color: text("color"),
        description: text("description"),
      });
      return saved.ok ? { intent, name: saved.value.name } : { intent, name, error: saved.error.message };
    }
    default:
      return { intent, error: "Nothing to do." };
  }
}

/** A color's input: a swatch picker and its hex digits, kept together. */
function ColorField({ defaultValue }: { defaultValue: string }) {
  const [color, setColor] = useState(tidyColor(defaultValue) ?? "bfdadc");
  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Color</span>
      <input
        type="color"
        value={`#${color}`}
        onChange={(event) => setColor(event.target.value.slice(1))}
        className="size-9 shrink-0 cursor-pointer rounded-md border border-line bg-bg p-1"
        aria-label="Pick a color"
      />
      <input
        name="color"
        value={color}
        onChange={(event) => setColor(event.target.value.replace(/^#/, "").slice(0, 6))}
        pattern="[0-9a-fA-F]{6}"
        required
        aria-label="Color, six hex digits"
        autoComplete="off"
        className="h-9 w-24 rounded-md border border-line bg-bg px-2 font-mono text-sm outline-none hover:border-line-strong focus:border-accent-dim"
      />
    </label>
  );
}

/** Creating a label, or editing one: name, description and color. */
function LabelForm({ label, onDone }: { label?: Label; onDone: () => void }) {
  const intent = label ? "edit" : "create";
  const result = useActionData<ActionData>();
  const pending = usePending({ intent, name: label?.name ?? "" });
  const mine = result?.intent === intent && (label ? result.name === label.name : true);
  // Saved: close the form, once this form's own save has come back.
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current && !pending && mine && !result?.error) onDone();
    sent.current = pending;
  }, [mine, result, pending, onDone]);
  return (
    <Form method="post" className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="name" value={label?.name ?? ""} />
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Name</span>
        <input
          name="newName"
          defaultValue={label?.name ?? ""}
          required
          maxLength={50}
          autoFocus
          autoComplete="off"
          data-1p-ignore
          placeholder="area: cli"
          className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none hover:border-line-strong focus:border-accent-dim"
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Description</span>
        <input
          name="description"
          defaultValue={label?.description ?? ""}
          maxLength={100}
          autoComplete="off"
          data-1p-ignore
          placeholder="What it means (optional)"
          className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none hover:border-line-strong focus:border-accent-dim"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <ColorField defaultValue={label?.color ?? ""} />
        <Button type="button" variant="quiet" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton match={{ intent, name: label?.name ?? "" }} pending="Saving…">
          {label ? "Save" : "Create label"}
        </SubmitButton>
      </div>
      {mine && result?.error && (
        <div className="sm:col-span-3">
          <ErrorText>{result.error}</ErrorText>
        </div>
      )}
    </Form>
  );
}

function DeleteLabel({ label }: { label: Label }) {
  const deleting = usePending({ intent: "delete", name: label.name });
  const carried = label.issues + label.pulls;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="quiet" disabled={deleting} aria-label={`Delete ${label.name}`}>
          {deleting ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} />}
          <span className="hidden sm:inline">{deleting ? "Deleting…" : "Delete"}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <Form method="post" className="grid gap-4">
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="name" value={label.name} />
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the {label.name} label?</AlertDialogTitle>
            <AlertDialogDescription>
              {carried === 0
                ? "Nothing carries it. "
                : `It comes off the ${label.issues} ${label.issues === 1 ? "issue" : "issues"} and ${label.pulls} pull ${label.pulls === 1 ? "request" : "requests"} that carry it. `}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction asChild>
              <button type="submit">
                <Trash2 size={14} />
                Delete label
              </button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function Labels({ loaderData, actionData, params }: Route.ComponentProps) {
  const { labels, canEdit } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const shown = matchLabels(labels, query);
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Labels</h2>
          <p className="mt-1 text-sm text-muted">
            Issues and pull requests carry labels to say what they are. Filter either list by one.
          </p>
        </div>
        {canEdit && !creating && (
          <div className="flex flex-wrap items-center gap-2">
            <Form method="post">
              <input type="hidden" name="intent" value="defaults" />
              <SubmitButton variant="quiet" match={{ intent: "defaults" }} pending="Adding…">
                Add the default labels
              </SubmitButton>
            </Form>
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus size={15} />
              New label
            </Button>
          </div>
        )}
      </div>
      {actionData?.intent === "defaults" &&
        (actionData.error ? <ErrorText>{actionData.error}</ErrorText> : <p className="text-sm text-muted">{actionData.done}</p>)}
      {actionData?.intent === "delete" && actionData.error && <ErrorText>{actionData.error}</ErrorText>}
      {creating && <LabelForm onDone={() => setCreating(false)} />}

      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
          <span className="text-sm font-medium">{count(labels.length, "label", "labels")}</span>
          <label className="ml-auto flex h-8 w-full items-center gap-2 rounded-md border border-line bg-bg px-2.5 sm:w-64">
            <Search size={14} className="shrink-0 text-faint" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search labels"
              aria-label="Search labels"
              autoComplete="off"
              data-1p-ignore
              className="w-full bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
        </div>
        {labels.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No labels yet">
              {canEdit ? "Add the default labels, or make your own." : "Nobody has made a label here yet."}
            </EmptyState>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-faint">No label matches “{query}”.</p>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((label) =>
              editing === label.name ? (
                <li key={label.name} className="p-3">
                  <LabelForm label={label} onDone={() => setEditing(null)} />
                </li>
              ) : (
                <li key={label.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <span className="w-full min-w-0 sm:w-56">
                    <LabelChip name={label.name} color={label.color} />
                  </span>
                  <span className="min-w-0 grow text-sm text-muted">{label.description}</span>
                  <span className="flex shrink-0 items-center gap-3 text-xs text-faint">
                    {label.issues > 0 ? (
                      <Link to={`${base}/issues?label=${encodeURIComponent(label.name)}&state=open`} className="hover:text-fg">
                        {count(label.issues, "issue", "issues")}
                      </Link>
                    ) : (
                      <span>no issues</span>
                    )}
                    {label.pulls > 0 ? (
                      <Link to={`${base}/pulls?label=${encodeURIComponent(label.name)}`} className="hover:text-fg">
                        {count(label.pulls, "pull request", "pull requests")}
                      </Link>
                    ) : (
                      <span>no pull requests</span>
                    )}
                  </span>
                  {canEdit && (
                    <span className="flex shrink-0 items-center gap-2">
                      <Button type="button" variant="quiet" onClick={() => setEditing(label.name)} aria-label={`Edit ${label.name}`}>
                        <Tag size={14} />
                        <span className="hidden sm:inline">Edit</span>
                      </Button>
                      <DeleteLabel label={label} />
                    </span>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
