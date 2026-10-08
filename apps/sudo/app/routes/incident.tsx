import { CheckCircle2, Circle, CircleDot, ExternalLink, FileText, Globe, Lock, Radar } from "lucide-react";
import { Link, redirect } from "react-router";

import type { AdminIncidentDetail, IncidentSeverity, IncidentStatus, TimelineEntry } from "@g1t/contracts";

import type { Route } from "./+types/incident";
import { BackLink, ImpactBadge, ImpactPicker, PhaseBadge, SeverityBadge, Timer } from "~/components/incidents";
import { IncidentChecks } from "~/components/latency";
import { Badge, Button, Field, Input, Notice, Section, Select, Textarea, When } from "~/components/ui";
import { text } from "~/lib/forms";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  duration,
  nextStatus,
  notifyByDefault,
  readImpacts,
  secondsBetween,
  severityLabel,
  staffSuggestions,
  statusLabel,
} from "~/lib/incidents";
import { staffEmails, statusAdmin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData?.incident?.title ?? "Incident"} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

/** What the page says after a change, by the code in `?done=`. */
const DONE: Record<string, string> = {
  declared: "Declared and published. status.g1t.sh shows it within 30 seconds.",
  update: "Update posted. The status page shows it within 30 seconds.",
  note: "Note added. Only staff see it.",
  resolved: "Resolved. Write the postmortem while it is fresh.",
  roles: "Roles saved.",
  published: "Published to the status page.",
  dismissed: "Dismissed. It never appeared on the status page.",
  followup: "Follow-up saved.",
};

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const staff = requireStaff(context);
  const [incident, components] = await Promise.all([settle(statusAdmin.incident(params.id)), settle(statusAdmin.components())]);
  if (incident.ok && !incident.value) throw new Response("No such incident.", { status: 404 });
  const url = new URL(request.url);
  const done = url.searchParams.get("declared") ? "declared" : (url.searchParams.get("done") ?? "");
  const detail = incident.ok ? incident.value : null;
  return {
    me: staff.email,
    incident: detail,
    components: components.ok ? components.value : [],
    error: incident.ok ? null : incident.error,
    done: DONE[done] ?? null,
    staff: staffSuggestions(staffEmails(), [staff.email, detail?.commander, detail?.communications, ...(detail?.followups.map((f) => f.owner) ?? [])]),
    now: new Date().toISOString(),
  };
}

type ActionData = { error: string; intent: string };

export async function action({ params, request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const id = params.id ?? "";
  const back = (done: string, anchor = "") => redirect(`/incidents/${id}?done=${done}${anchor}`);
  const failed = (error: string) => ({ error, intent }) satisfies ActionData;
  const unwrap = async <T,>(call: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>) => {
    const result = await settle(call);
    if (!result.ok) return { ok: false as const, error: result.error };
    return result.value.ok ? { ok: true as const, value: result.value.value } : { ok: false as const, error: result.value.error.message };
  };

  if (intent === "update" || intent === "resolve") {
    const components = await settle(statusAdmin.components());
    const keys = components.ok ? components.value.map((c) => c.key) : [];
    const isPublic = intent === "resolve" || text(form, "visibility") === "public";
    const status = intent === "resolve" ? "resolved" : (text(form, "status") as IncidentStatus) || null;
    const r = await unwrap(
      statusAdmin.update(id, {
        public: isPublic,
        message: String(form.get("message") ?? ""),
        status,
        severity: (text(form, "severity") as IncidentSeverity) || null,
        impacts: intent === "resolve" ? [] : readImpacts(form, keys),
        notify: isPublic && form.get("notify") === "on",
        by: staff.email,
      }),
    );
    if (!r.ok) return failed(r.error);
    return back(status === "resolved" ? "resolved" : isPublic ? "update" : "note");
  }
  if (intent === "roles") {
    const r = await unwrap(statusAdmin.roles(id, { commander: text(form, "commander") || null, communications: text(form, "communications") || null, by: staff.email }));
    return !r.ok ? failed(r.error) : back("roles", "#roles");
  }
  if (intent === "publish") {
    const r = await unwrap(
      statusAdmin.publish(id, { title: text(form, "title") || null, message: String(form.get("message") ?? ""), notify: form.get("notify") === "on", by: staff.email }),
    );
    return !r.ok ? failed(r.error) : back("published");
  }
  if (intent === "dismiss") {
    const r = await unwrap(statusAdmin.dismiss(id, { reason: text(form, "reason"), by: staff.email }));
    return !r.ok ? failed(r.error) : back("dismissed");
  }
  if (intent === "followup_add") {
    const r = await unwrap(statusAdmin.addFollowUp(id, { title: text(form, "title"), owner: text(form, "owner") || null, by: staff.email }));
    return !r.ok ? failed(r.error) : back("followup", "#followups");
  }
  if (intent === "followup_set") {
    const r = await unwrap(statusAdmin.setFollowUp(id, text(form, "followup"), { done: text(form, "done") === "1", by: staff.email }));
    return !r.ok ? failed(r.error) : back("followup", "#followups");
  }
  return failed("Unknown action.");
}

const KIND_ICON = { update: Globe, note: Lock, detected: Radar, followup: CheckCircle2, postmortem: FileText } as const;

function EntryLine({ entry }: { entry: TimelineEntry }) {
  const who = entry.by === "status" ? "the checks" : entry.by;
  const meta = (
    <span className="text-xs text-faint">
      <When at={entry.at} time /> · <span className="font-mono">{who}</span>
    </span>
  );
  if (entry.kind === "update") {
    return (
      <li className="rounded-md border border-accent/30 bg-accent/6 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Globe size={14} aria-hidden="true" className="text-accent" />
          <span className="text-xs font-semibold text-accent">Public update</span>
          {entry.status && <Badge tone="lavender">{statusLabel(entry.status)}</Badge>}
          {meta}
          {entry.notified != null && <span className="text-xs text-faint">· emailed {entry.notified}</span>}
        </div>
        <p className="mt-1.5 text-sm whitespace-pre-line text-fg">{entry.text}</p>
      </li>
    );
  }
  if (entry.kind === "note") {
    return (
      <li className="rounded-md border border-line bg-raised/40 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Lock size={13} aria-hidden="true" className="text-faint" />
          <span className="text-xs font-medium text-muted">Internal note</span>
          {meta}
        </div>
        <p className="mt-1.5 text-sm whitespace-pre-line text-fg-soft">{entry.text}</p>
      </li>
    );
  }
  const Icon = KIND_ICON[entry.kind as keyof typeof KIND_ICON] ?? CircleDot;
  const loud = entry.kind === "detected" || entry.kind === "failing";
  return (
    <li className="flex gap-2.5 px-1 py-1">
      <Icon size={13} aria-hidden="true" className={`mt-1 shrink-0 ${loud ? "text-warn" : "text-faint"}`} />
      <p className="min-w-0 text-sm text-muted">
        <span className={loud ? "text-fg-soft" : ""}>{entry.text}</span> {meta}
      </p>
    </li>
  );
}

function Header({ incident, now }: { incident: AdminIncidentDetail; now: string }) {
  const open = incident.resolved_at == null;
  const d = incident.durations;
  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SeverityBadge severity={incident.severity} />
        <PhaseBadge incident={incident} />
        {incident.source === "detected" && <Badge tone="warn">Detected by the checks</Badge>}
        {incident.visibility !== "public" && <Badge>Not on the status page</Badge>}
      </div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight break-words">{incident.title}</h1>
      <p className="mt-1 text-sm text-muted">
        Impact began <When at={incident.started_at} time /> · declared by <span className="font-mono text-xs">{incident.created_by === "status" ? "the checks" : incident.created_by}</span>
        {incident.commander && (
          <>
            {" "}· IC <span className="font-mono text-xs">{incident.commander}</span>
          </>
        )}
        {incident.communications && (
          <>
            {" "}· comms <span className="font-mono text-xs">{incident.communications}</span>
          </>
        )}
      </p>
      <div className="mt-4 grid grid-cols-2 divide-line rounded-lg border border-line bg-surface sm:grid-cols-4 sm:divide-x [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-line sm:[&>*:nth-child(-n+2)]:border-b-0">
        <Timer
          label={open ? "Open for" : "Lasted"}
          value={duration(open ? secondsBetween(incident.started_at, now) : d.to_resolve)}
          tone={open ? "warn" : "mint"}
          hint={open ? `${severityLabel(incident.severity)} · ${statusLabel(incident.status)}` : <When at={incident.resolved_at} time />}
        />
        <Timer label="To acknowledge" value={duration(d.to_acknowledge)} hint={incident.acknowledged_at ? <When at={incident.acknowledged_at} time /> : "Not yet"} />
        <Timer label="To mitigate" value={duration(d.to_mitigate)} hint={incident.mitigated_at ? <When at={incident.mitigated_at} time /> : "At monitoring"} />
        <Timer label="To resolve" value={duration(d.to_resolve)} hint={incident.resolved_at ? <When at={incident.resolved_at} time /> : "Still open"} />
      </div>
    </>
  );
}

function UpdateForm({ incident, components, error }: { incident: AdminIncidentDetail; components: { key: string; name: string }[]; error: string | null }) {
  const draft = incident.visibility === "draft";
  const current = new Map(incident.components.map((c) => [c.key, c.impact]));
  return (
    <Section id="update" title={draft ? "Add a note" : "Post an update"} description={draft ? "Drafts take notes and changes; publish it to post publicly." : "A public update goes on the status page; a note stays here."}>
      <form method="post" action="#update" className="space-y-4">
        <input type="hidden" name="intent" value="update" />
        {error && <Notice tone="error">{error}</Notice>}
        {!draft && (
          <fieldset className="flex flex-wrap gap-2" aria-label="Who sees it">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm has-checked:border-accent/60 has-checked:bg-accent/10">
              <input type="radio" name="visibility" value="public" defaultChecked className="accent-[var(--g1t-accent)]" />
              <Globe size={14} aria-hidden="true" /> Public update
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm has-checked:border-line-strong has-checked:bg-raised">
              <input type="radio" name="visibility" value="internal" className="accent-[var(--g1t-accent)]" />
              <Lock size={14} aria-hidden="true" /> Internal note
            </label>
          </fieldset>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Status" hint={draft ? undefined : "Changing it needs a public update."}>
            <Select name="status" defaultValue="">
              <option value="">Keep: {statusLabel(incident.status)}</option>
              {INCIDENT_STATUSES.filter((s) => s.value !== incident.status).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                  {s.value === nextStatus(incident.status) ? " (next)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Severity">
            <Select name="severity" defaultValue="">
              <option value="">Keep: {severityLabel(incident.severity)}</option>
              {INCIDENT_SEVERITIES.filter((s) => s.value !== incident.severity).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <details className="group rounded-md">
          <summary className="cursor-pointer text-sm text-muted select-none hover:text-fg">Change the parts' impact</summary>
          <div className="mt-2">
            <ImpactPicker components={components} current={current} blank />
          </div>
        </details>
        <Field label="Message">
          <Textarea name="message" rows={4} maxLength={4000} placeholder={draft ? "What you found, for the team." : "What changed, in a sentence or two, for the people affected."} />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {!draft ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="notify" defaultChecked={notifyByDefault(incident.severity)} className="accent-[var(--g1t-accent)]" />
              Email subscribers (public updates only)
            </label>
          ) : (
            <span />
          )}
          <Button type="submit" variant="lavender">
            Post
          </Button>
        </div>
      </form>
    </Section>
  );
}

export default function Incident({ loaderData, actionData }: Route.ComponentProps) {
  const { incident, components, error, done, staff, now } = loaderData;
  const failed = actionData as ActionData | undefined;
  const errorFor = (intent: string) => (failed?.intent === intent ? failed.error : null);
  if (!incident) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
        <BackLink to="/incidents">Incidents</BackLink>
        <div className="mt-4">
          <Notice tone="warn">The status worker did not answer: {error}</Notice>
        </div>
      </main>
    );
  }
  const names = new Map(components.map((c) => [c.key, c.name]));
  const open = incident.resolved_at == null;
  const isPublic = incident.visibility === "public";
  const affected = incident.components.filter((c) => c.impact !== "operational");
  const timeline = [...incident.timeline].reverse();

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <BackLink to={incident.visibility === "draft" ? "/incidents?tab=drafts" : open ? "/incidents" : "/incidents?tab=resolved"}>Incidents</BackLink>
      <Header incident={incident} now={now} />

      <div className="mt-4 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {failed && !["update", "roles", "followup_add", "followup_set", "resolve", "publish", "dismiss"].includes(failed.intent) && <Notice tone="error">{failed.error}</Notice>}
      </div>

      {incident.visibility === "draft" && (
        <section className="mt-5 rounded-lg border border-warn/35 bg-warn/6 p-4 sm:p-5">
          <h2 className="font-semibold">This is a draft</h2>
          <p className="mt-1 text-sm text-muted">
            {incident.source === "detected"
              ? "The checks failed or were slow on four of five checks in a row and made this. Nobody outside sees it until you publish it. If it was a blip, dismiss it; if no one picks it up and its parts stay healthy for 10 minutes, it is dismissed on its own. Left unacknowledged, the alert goes out again after 45 minutes, then every 6 hours."
              : "Nobody outside sees it until you publish it."}
          </p>
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="publish" />
              {errorFor("publish") && <Notice tone="error">{errorFor("publish")}</Notice>}
              <Field label="Public title">
                <Input name="title" defaultValue={incident.title.replace(/^Detected: /, "")} maxLength={120} required />
              </Field>
              <Field label="First public update">
                <Textarea name="message" rows={3} required maxLength={4000} placeholder="We are looking into reports that…" />
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="notify" defaultChecked={notifyByDefault(incident.severity)} className="accent-[var(--g1t-accent)]" />
                  Email subscribers
                </label>
                <Button type="submit" variant="lavender">
                  Publish to the status page
                </Button>
              </div>
            </form>
            <form method="post" className="space-y-3 lg:border-l lg:border-warn/20 lg:pl-4">
              <input type="hidden" name="intent" value="dismiss" />
              {errorFor("dismiss") && <Notice tone="error">{errorFor("dismiss")}</Notice>}
              <Field label="Not an incident?">
                <Input name="reason" maxLength={500} placeholder="A blip: answered again within minutes" />
              </Field>
              <Button type="submit" variant="quiet">
                Dismiss draft
              </Button>
            </form>
          </div>
        </section>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {incident.visibility !== "dismissed" && <UpdateForm incident={incident} components={components} error={errorFor("update")} />}
          {(incident.checks?.length ?? 0) > 0 && (
            <Section
              id="checks"
              title="Checks"
              description="How long each check of its parts took, from 30 minutes before it began to 30 minutes after it ended (at most a day), with the data centre each ran from. Kept for 7 days."
            >
              <IncidentChecks checks={incident.checks} names={names} />
            </Section>
          )}
          <Section title="Timeline" description="Newest first. Public updates are what the status page shows; everything else is for staff.">
            <ol className="space-y-2">
              {timeline.map((entry) => (
                <EntryLine key={entry.id} entry={entry} />
              ))}
            </ol>
          </Section>
        </div>

        <aside className="min-w-0 space-y-6">
          {open && isPublic && (
            <Section id="resolve" title="Resolve" description="Closes it, posts a last public update, and stops colouring the parts.">
              <form method="post" action="#resolve" className="space-y-3">
                <input type="hidden" name="intent" value="resolve" />
                {errorFor("resolve") && <Notice tone="error">{errorFor("resolve")}</Notice>}
                <Textarea name="message" rows={3} required maxLength={4000} aria-label="Resolution update" placeholder="Pushes work again. A bad deploy was rolled back; nothing was lost." />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="notify" defaultChecked={notifyByDefault(incident.severity)} className="accent-[var(--g1t-accent)]" />
                  Email subscribers
                </label>
                <Button type="submit" variant="lavender" className="w-full">
                  <CheckCircle2 size={15} aria-hidden="true" /> Resolve incident
                </Button>
              </form>
            </Section>
          )}

          {!open && isPublic && (
            <Section title="Postmortem" description={incident.postmortem_published_at ? "Published on the incident's page." : incident.postmortem ? "Drafted, not published." : "Not started."}>
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/incidents/${incident.id}/postmortem`} className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
                  <FileText size={14} aria-hidden="true" />
                  {incident.postmortem ? "Edit the postmortem" : "Write the postmortem"}
                </Link>
                {incident.postmortem_published_at && <Badge tone="mint">Published</Badge>}
              </div>
            </Section>
          )}

          <Section title="Parts" description={open ? "What the status page shows for each while it is open." : "What it did to each."}>
            {affected.length === 0 ? (
              <p className="text-sm text-muted">None marked.</p>
            ) : (
              <ul className="space-y-2">
                {affected.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{names.get(c.key) ?? c.key}</span>
                    <ImpactBadge impact={c.impact} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="roles" title="Roles">
            <form method="post" action="#roles" className="space-y-3">
              <input type="hidden" name="intent" value="roles" />
              {errorFor("roles") && <Notice tone="error">{errorFor("roles")}</Notice>}
              <Field label="Incident commander">
                <Input name="commander" type="email" list="staff" defaultValue={incident.commander ?? ""} placeholder="Nobody" />
              </Field>
              <Field label="Communications">
                <Input name="communications" type="email" list="staff" defaultValue={incident.communications ?? ""} placeholder="Nobody" />
              </Field>
              <Button type="submit" variant="quiet">
                Save roles
              </Button>
            </form>
          </Section>

          <Section id="followups" title="Follow-ups" description="What to change so it does not happen again.">
            {errorFor("followup_set") && (
              <div className="mb-3">
                <Notice tone="error">{errorFor("followup_set")}</Notice>
              </div>
            )}
            {incident.followups.length > 0 && (
              <ul className="mb-4 space-y-1.5">
                {incident.followups.map((f) => (
                  <li key={f.id}>
                    <form method="post" action="#followups" className="flex items-start gap-2">
                      <input type="hidden" name="intent" value="followup_set" />
                      <input type="hidden" name="followup" value={f.id} />
                      <input type="hidden" name="done" value={f.done_at ? "0" : "1"} />
                      <button
                        type="submit"
                        aria-label={f.done_at ? `Mark “${f.title}” not done` : `Mark “${f.title}” done`}
                        className="mt-0.5 shrink-0 rounded text-faint hover:text-accent"
                      >
                        {f.done_at ? <CheckCircle2 size={16} className="text-success" /> : <Circle size={16} />}
                      </button>
                      <span className="min-w-0 text-sm">
                        <span className={f.done_at ? "text-faint line-through" : ""}>{f.title}</span>
                        {f.owner && <span className="block font-mono text-xs text-faint">{f.owner}</span>}
                      </span>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <form method="post" action="#followups" className="space-y-2">
              <input type="hidden" name="intent" value="followup_add" />
              {errorFor("followup_add") && <Notice tone="error">{errorFor("followup_add")}</Notice>}
              <Input name="title" required maxLength={200} placeholder="Alert on push errors above 1%" aria-label="Follow-up" />
              <div className="flex gap-2">
                <Input name="owner" type="email" list="staff" placeholder="Owner (optional)" aria-label="Owner" />
                <Button type="submit" variant="quiet">
                  Add
                </Button>
              </div>
            </form>
          </Section>

          <Section title="Links">
            <ul className="space-y-1.5 text-sm">
              {isPublic ? (
                <li>
                  <a href={incident.url} className="inline-flex items-center gap-1.5 text-accent hover:underline">
                    Status page permalink <ExternalLink size={13} aria-hidden="true" />
                  </a>
                  <span className="block truncate font-mono text-xs text-faint">{incident.url}</span>
                </li>
              ) : (
                <li className="text-muted">No public page until it is published.</li>
              )}
              <li>
                <Link to="/audit" className="text-muted hover:text-fg hover:underline">
                  Audit log
                </Link>
              </li>
            </ul>
          </Section>
          <datalist id="staff">
            {staff.map((email) => (
              <option key={email} value={email} />
            ))}
          </datalist>
        </aside>
      </div>
    </main>
  );
}
