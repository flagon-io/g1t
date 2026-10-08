import { Plus } from "lucide-react";
import { useState } from "react";
import { data } from "react-router";

import type { CustomPattern } from "@g1t/contracts";

import type { Route } from "./+types/security-patterns";
import { page } from "../../lib/meta";
import { CARD, PatternEditor, patternFields } from "../../components/security-suite";
import { WorkspaceSecurityHeading, WorkspaceSecurityTabs } from "../../components/workspace-security-tabs";
import { Badge } from "../../components/ui/badge";
import { securitySuite } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Custom patterns · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  return { list: unwrap(await securitySuite.patterns(params.owner, null, viewer)), owner: role === "owner" };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "save_pattern") {
    const saved = await securitySuite.savePattern(user, params.owner, null, patternFields(form));
    return saved.ok ? { ok: true, saved: saved.value } : { ok: false, error: saved.error.message };
  }
  if (intent === "dry_run") {
    const ran = await securitySuite.dryRun(user, params.owner, null, patternFields(form));
    return ran.ok ? { ok: true, dryRun: ran.value } : { ok: false, error: ran.error.message };
  }
  if (intent === "delete_pattern") {
    const deleted = await securitySuite.deletePattern(user, params.owner, null, String(form.get("id") ?? ""));
    return deleted.ok ? { ok: true } : { ok: false, error: deleted.error.message };
  }
  return { ok: false, error: "Unknown action." };
}

function draftOf(pattern: CustomPattern | null) {
  return {
    id: pattern?.id,
    name: pattern?.name ?? "",
    pattern: pattern?.pattern ?? "",
    before: pattern?.before ?? "",
    after: pattern?.after ?? "",
    testStrings: (pattern?.testStrings ?? []).join("\n"),
    published: pattern?.state === "published",
  };
}

export default function WorkspacePatterns({ loaderData, params }: Route.ComponentProps) {
  const { list, owner } = loaderData;
  const [editing, setEditing] = useState<CustomPattern | "new" | null>(null);
  return (
    <div>
      <WorkspaceSecurityHeading
        title="Custom patterns"
        about="Secret formats of the workspace's own, found in every repository's pushes and history alongside the built-in ones. Without the Security and quality activation they cover public repositories only."
      />
      <WorkspaceSecurityTabs owner={params.owner} />
      {!list.entitled && (
        <p className="mb-4 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn">
          This workspace has no Security and quality activation: its patterns run on public repositories only. An owner can turn it
          on in Billing.
        </p>
      )}
      {owner && editing === null && (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="mb-4 inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:border-line-strong"
        >
          <Plus size={14} /> New pattern
        </button>
      )}
      {editing !== null && (
        <section className={`${CARD} mb-6 p-4`}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">{editing === "new" ? "New pattern" : editing.name}</h2>
            <button type="button" onClick={() => setEditing(null)} className="text-sm text-muted hover:text-fg">
              Close
            </button>
          </div>
          <PatternEditor key={editing === "new" ? "new" : editing.id} action={`/${params.owner}/-/security/patterns`} draft={draftOf(editing === "new" ? null : editing)} />
        </section>
      )}
      {list.patterns.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">No custom patterns yet.</p>
      ) : (
        <ul className={`${CARD} divide-y divide-line`}>
          {list.patterns.map((pattern) => (
            <li key={pattern.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
              <div className="min-w-0 grow">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{pattern.name}</span>
                  <Badge tone={pattern.state === "published" ? "accent" : "neutral"}>{pattern.state === "published" ? "Published" : "Draft"}</Badge>
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-muted">{pattern.pattern}</p>
              </div>
              <span className="shrink-0 text-xs text-faint">
                {pattern.openAlerts} open {pattern.openAlerts === 1 ? "alert" : "alerts"}
              </span>
              {owner && (
                <button type="button" onClick={() => setEditing(pattern)} className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:text-fg">
                  Edit
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
