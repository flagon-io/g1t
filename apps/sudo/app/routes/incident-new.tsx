import { redirect } from "react-router";

import type { IncidentSeverity, IncidentStatus } from "@g1t/contracts";

import type { Route } from "./+types/incident-new";
import { BackLink, ImpactPicker } from "~/components/incidents";
import { Button, Field, Input, Notice, PageHeader, Section, Select, Textarea } from "~/components/ui";
import { text } from "~/lib/forms";
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES, readImpacts, staffSuggestions, utc, wantsNotify } from "~/lib/incidents";
import { staffEmails, statusAdmin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Declare an incident · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ context }: Route.LoaderArgs) {
  const staff = requireStaff(context);
  const components = await settle(statusAdmin.components());
  return {
    me: staff.email,
    components: components.ok ? components.value : [],
    error: components.ok ? null : components.error,
    staff: staffSuggestions(staffEmails(), [staff.email]),
  };
}

type ActionData = { error: string; values: Record<string, string> };

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const components = await settle(statusAdmin.components());
  const keys = components.ok ? components.value.map((c) => c.key) : [];
  const values = Object.fromEntries(["title", "severity", "status", "message", "started_at", "commander", "communications", "notify"].map((k) => [k, text(form, k)]));
  const result = await settle(
    statusAdmin.declare({
      title: text(form, "title"),
      severity: text(form, "severity") as IncidentSeverity,
      status: text(form, "status") as IncidentStatus,
      components: readImpacts(form, keys),
      message: String(form.get("message") ?? ""),
      started_at: utc(text(form, "started_at")),
      commander: text(form, "commander") || null,
      communications: text(form, "communications") || null,
      notify: wantsNotify(text(form, "notify"), text(form, "severity") as IncidentSeverity),
      by: staff.email,
    }),
  );
  if (!result.ok) return { error: result.error, values } satisfies ActionData;
  if (!result.value.ok) return { error: result.value.error.message, values } satisfies ActionData;
  return redirect(`/incidents/${result.value.value.id}?declared=1`);
}

export default function DeclareIncident({ loaderData, actionData }: Route.ComponentProps) {
  const { me, components, error, staff } = loaderData;
  const failed = actionData as ActionData | undefined;
  const v = failed?.values ?? {};

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <BackLink to="/incidents">Incidents</BackLink>
      <div className="mt-3">
        <PageHeader
          title="Declare an incident"
          description="It goes on status.g1t.sh at once with its first update, and the parts you mark show their impact there until it is resolved."
        />
      </div>
      <div className="mt-5 space-y-3">
        {error && <Notice tone="warn">The status worker did not answer: {error}</Notice>}
        {failed && <Notice tone="error">{failed.error}</Notice>}
      </div>

      <form method="post" className="mt-6 space-y-6">
        <Section title="What is happening">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" className="sm:col-span-2" hint="What people notice, not the internals. Shown publicly.">
              <Input name="title" required maxLength={120} autoFocus defaultValue={v.title} placeholder="Pushes over HTTPS failing" />
            </Field>
            <fieldset className="sm:col-span-2">
              <legend className="mb-1.5 text-sm font-medium text-muted">Severity</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {INCIDENT_SEVERITIES.map((s) => (
                  <label
                    key={s.value}
                    className="flex cursor-pointer gap-2.5 rounded-md border border-line px-3 py-2 has-checked:border-merged/60 has-checked:bg-merged/8"
                  >
                    <input type="radio" name="severity" value={s.value} required defaultChecked={(v.severity || "sev3") === s.value} className="mt-1 accent-[#b6a8ff]" />
                    <span>
                      <span className="block text-sm font-semibold">{s.label}</span>
                      <span className="block text-xs text-muted">{s.about}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Status" hint="Investigating: the cause is not known yet. Identified: a fix is under way. Monitoring: a fix is out.">
              <Select name="status" defaultValue={v.status || "investigating"}>
                {INCIDENT_STATUSES.filter((s) => s.value !== "resolved").map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Impact began (UTC)" hint="Leave empty for now. Up to 90 days back; durations count from here.">
              <Input type="datetime-local" name="started_at" defaultValue={v.started_at} />
            </Field>
          </div>
        </Section>

        <Section title="Parts affected" description="Mark each affected part. They show this on the status page, or worse if their checks say so.">
          <ImpactPicker components={components} current={new Map()} />
        </Section>

        <Section title="First public update" description="Shown on the status page with the status above.">
          <Textarea
            name="message"
            rows={4}
            required
            maxLength={4000}
            defaultValue={v.message}
            aria-label="First public update"
            placeholder="We are looking into reports that pushes over HTTPS fail with a 502. Pulls and the website are not affected."
          />
          <Field label="Email subscribers" className="mt-3 sm:w-80" hint="Subscribers who chose other parts are not emailed.">
            <Select name="notify" defaultValue={v.notify || "auto"}>
              <option value="auto">As the severity says: yes for SEV1 and SEV2</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
        </Section>

        <Section title="Roles" description="Staff emails. Change them any time from the incident.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Incident commander" hint="Runs the response and decides.">
              <Input name="commander" type="email" list="staff" defaultValue={v.commander ?? me} placeholder={me} />
            </Field>
            <Field label="Communications" hint="Writes the public updates.">
              <Input name="communications" type="email" list="staff" defaultValue={v.communications} placeholder="Optional" />
            </Field>
          </div>
          <datalist id="staff">
            {staff.map((email) => (
              <option key={email} value={email} />
            ))}
          </datalist>
        </Section>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="lavender">
            Declare and publish
          </Button>
          <p className="text-xs text-faint">Recorded in the audit log with your email.</p>
        </div>
      </form>
    </main>
  );
}
