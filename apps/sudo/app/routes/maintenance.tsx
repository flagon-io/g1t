import { ExternalLink } from "lucide-react";
import { redirect } from "react-router";

import type { MaintenanceChange } from "@g1t/contracts";

import type { Route } from "./+types/maintenance";
import { BackLink, MaintenanceBadge } from "~/components/incidents";
import { Button, EmptyState, Field, Notice, PageHeader, Section, Textarea, When } from "~/components/ui";
import { text } from "~/lib/forms";
import { duration, secondsBetween } from "~/lib/incidents";
import { statusAdmin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData?.maintenance?.title ?? "Maintenance"} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

const DONE: Record<string, string> = {
  scheduled: "Scheduled. status.g1t.sh lists it as upcoming within 30 seconds.",
  update: "Update posted.",
  start: "Started early.",
  complete: "Marked complete.",
  cancel: "Cancelled.",
};

export async function loader({ params, request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const [board, components] = await Promise.all([settle(statusAdmin.board()), settle(statusAdmin.components())]);
  const maintenance = board.ok ? (board.value.maintenance.find((m) => m.id === params.id) ?? null) : null;
  if (board.ok && !maintenance) throw new Response("No such maintenance, or it ended over 90 days ago.", { status: 404 });
  return {
    maintenance,
    names: components.ok ? components.value : [],
    error: board.ok ? null : board.error,
    done: DONE[new URL(request.url).searchParams.get("done") ?? ""] ?? null,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const act = text(form, "intent") as MaintenanceChange["action"];
  const result = await settle(
    statusAdmin.changeMaintenance(params.id, { action: act, message: String(form.get("message") ?? ""), notify: form.get("notify") === "on", by: staff.email }),
  );
  if (!result.ok) return { error: result.error };
  if (!result.value.ok) return { error: result.value.error.message };
  return redirect(`/incidents/maintenance/${params.id}?done=${act}`);
}

export default function Maintenance({ loaderData, actionData }: Route.ComponentProps) {
  const { maintenance: m, names, error, done } = loaderData;
  const failed = actionData as { error: string } | undefined;
  if (!m) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Notice tone="warn">The status worker did not answer: {error}</Notice>
      </main>
    );
  }
  const name = new Map(names.map((c) => [c.key, c.name]));
  const live = m.state === "scheduled" || m.state === "in_progress";
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
      <BackLink to="/incidents?tab=maintenance">Incidents</BackLink>
      <div className="mt-3">
        <PageHeader
          title={m.title}
          description={
            <>
              <MaintenanceBadge state={m.state} /> <When at={m.starts_at} time /> to <When at={m.ends_at} time /> · {duration(secondsBetween(m.starts_at, m.ends_at))} ·{" "}
              {m.components.map((k) => name.get(k) ?? k).join(", ")}
            </>
          }
          actions={
            <a href={m.url} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
              On the status page <ExternalLink size={13} aria-hidden="true" />
            </a>
          }
        />
      </div>
      <div className="mt-4 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {failed && <Notice tone="error">{failed.error}</Notice>}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-6">
          {live && (
            <Section title="Post an update" description="Shown on its page and the status page.">
              <form method="post" className="space-y-3">
                <Textarea name="message" rows={3} maxLength={4000} aria-label="Update" placeholder="Running a little long: about 20 more minutes." />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="notify" className="accent-[var(--g1t-accent)]" />
                    Email subscribers
                  </label>
                  <Button type="submit" name="intent" value="update" variant="lavender">
                    Post update
                  </Button>
                </div>
              </form>
            </Section>
          )}
          <Section title="Updates" description="Newest first, as the status page shows them.">
            {m.updates.length === 0 ? (
              <EmptyState title="No updates" />
            ) : (
              <ol className="space-y-3">
                {m.updates.map((u) => (
                  <li key={u.id} className="rounded-md border border-line bg-raised/30 px-3.5 py-3">
                    <p className="text-xs text-faint">
                      <When at={u.at} time />
                    </p>
                    <p className="mt-1 text-sm whitespace-pre-line text-fg-soft">{u.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
        <aside className="min-w-0 space-y-6">
          {live ? (
            <Section title="Move it along" description="It starts and completes on its own with its window; do it by hand when the work runs early or late.">
              <form method="post" className="space-y-3">
                <Field label="Message (optional)">
                  <Textarea name="message" rows={2} maxLength={4000} placeholder="Said for you when empty." />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="notify" defaultChecked className="accent-[var(--g1t-accent)]" />
                  Email subscribers
                </label>
                <div className="flex flex-wrap gap-2">
                  {m.state === "scheduled" && (
                    <Button type="submit" name="intent" value="start" variant="quiet">
                      Start now
                    </Button>
                  )}
                  <Button type="submit" name="intent" value="complete" variant="quiet">
                    Complete
                  </Button>
                  <Button type="submit" name="intent" value="cancel" variant="danger">
                    Cancel
                  </Button>
                </div>
              </form>
            </Section>
          ) : (
            <Section title="Finished">
              <p className="text-sm text-muted">This maintenance is {m.state === "completed" ? "complete" : "cancelled"}. It stays in the status page's history.</p>
            </Section>
          )}
          <Section title="Scheduled by">
            <p className="font-mono text-xs text-fg-soft">{m.created_by}</p>
            <p className="mt-1 text-xs text-faint">
              <When at={m.created_at} time />
            </p>
          </Section>
        </aside>
      </div>
    </main>
  );
}
