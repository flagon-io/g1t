import { redirect } from "react-router";

import type { Route } from "./+types/maintenance-new";
import { BackLink } from "~/components/incidents";
import { Button, Field, Input, Notice, PageHeader, Section, Textarea } from "~/components/ui";
import { text } from "~/lib/forms";
import { localValue, utc } from "~/lib/incidents";
import { statusAdmin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff, zoneContext } from "~/lib/staff";
import { zoneAbbr } from "~/lib/time";

export const meta: Route.MetaFunction = () => [{ title: "Schedule maintenance · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ context }: Route.LoaderArgs) {
  requireStaff(context);
  const { zone } = context.get(zoneContext);
  const components = await settle(statusAdmin.components());
  // A sensible default: tomorrow, 02:00 to 03:00 UTC, shown in the staff member's zone.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 2));
  return {
    components: components.ok ? components.value : [],
    error: components.ok ? null : components.error,
    start: localValue(start, zone),
    end: localValue(new Date(start.getTime() + 3600_000), zone),
    zone: zoneAbbr(start, zone),
  };
}

type ActionData = { error: string; values: Record<string, string>; chosen: string[] };

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const { zone } = context.get(zoneContext);
  const form = await request.formData();
  const values = Object.fromEntries(["title", "message", "starts_at", "ends_at"].map((k) => [k, text(form, k)]));
  const chosen = form.getAll("components").map(String);
  const result = await settle(
    statusAdmin.scheduleMaintenance({
      title: text(form, "title"),
      message: String(form.get("message") ?? ""),
      components: chosen,
      starts_at: utc(text(form, "starts_at"), zone) ?? "",
      ends_at: utc(text(form, "ends_at"), zone) ?? "",
      notify: form.get("notify") === "on",
      by: staff.email,
    }),
  );
  if (!result.ok) return { error: result.error, values, chosen } satisfies ActionData;
  if (!result.value.ok) return { error: result.value.error.message, values, chosen } satisfies ActionData;
  return redirect(`/incidents/maintenance/${result.value.value.id}?done=scheduled`);
}

export default function ScheduleMaintenance({ loaderData, actionData }: Route.ComponentProps) {
  const { components, error, start, end, zone } = loaderData;
  const failed = actionData as ActionData | undefined;
  const v = failed?.values ?? {};
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <BackLink to="/incidents?tab=maintenance">Incidents</BackLink>
      <div className="mt-3">
        <PageHeader
          title="Schedule maintenance"
          description="Shown on status.g1t.sh as upcoming maintenance at once; during the window its parts show “Under maintenance” and their checks do not count against uptime. It completes on its own when the window ends."
        />
      </div>
      <div className="mt-5 space-y-3">
        {error && <Notice tone="warn">The status worker did not answer: {error}</Notice>}
        {failed && <Notice tone="error">{failed.error}</Notice>}
      </div>
      <form method="post" className="mt-6 space-y-6">
        <Section title="What and when">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" className="sm:col-span-2">
              <Input name="title" required maxLength={120} autoFocus defaultValue={v.title} placeholder="Database upgrade" />
            </Field>
            <Field label={`Starts (${zone})`}>
              <Input type="datetime-local" name="starts_at" required defaultValue={v.starts_at || start} />
            </Field>
            <Field label={`Ends (${zone})`} hint="Up to 72 hours after it starts.">
              <Input type="datetime-local" name="ends_at" required defaultValue={v.ends_at || end} />
            </Field>
          </div>
        </Section>
        <Section title="Parts affected">
          <div className="flex flex-wrap gap-2">
            {components.map((c) => (
              <label
                key={c.key}
                className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm has-checked:border-merged/60 has-checked:bg-merged/10"
              >
                <input type="checkbox" name="components" value={c.key} defaultChecked={failed?.chosen.includes(c.key)} className="accent-[#b6a8ff]" />
                {c.name}
              </label>
            ))}
          </div>
        </Section>
        <Section title="Message" description="What will happen and what people will notice. Shown publicly.">
          <Textarea name="message" rows={4} required maxLength={4000} aria-label="Message" defaultValue={v.message} placeholder="We are upgrading the database behind git. Pushes may pause for up to five minutes; clones and the website keep working." />
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" name="notify" defaultChecked className="accent-[#b6a8ff]" />
            Email subscribers now, when it starts, and when it ends
          </label>
        </Section>
        <Button type="submit" variant="lavender">
          Schedule
        </Button>
      </form>
    </main>
  );
}
