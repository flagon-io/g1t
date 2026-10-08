import { ExternalLink } from "lucide-react";
import { redirect } from "react-router";

import type { PostmortemFields } from "@g1t/contracts";

import type { Route } from "./+types/incident-postmortem";
import { BackLink, SeverityBadge } from "~/components/incidents";
import { Badge, Button, Field, Notice, PageHeader, Section, Textarea, When } from "~/components/ui";
import { duration } from "~/lib/incidents";
import { POSTMORTEM_SECTIONS, proseBlocks } from "~/lib/postmortem";
import { statusAdmin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `Postmortem: ${loaderData?.incident?.title ?? "incident"} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ params, request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const incident = await settle(statusAdmin.incident(params.id));
  if (incident.ok && !incident.value) throw new Response("No such incident.", { status: 404 });
  const done = new URL(request.url).searchParams.get("done");
  return {
    incident: incident.ok ? incident.value : null,
    error: incident.ok ? null : incident.error,
    done: done === "saved" ? "Draft saved. The preview shows it." : done === "published" ? "Published on the incident's page." : done === "unpublished" ? "Taken down from the status page." : null,
  };
}

type ActionData = { error: string; values?: PostmortemFields };

export async function action({ params, request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const values = Object.fromEntries(POSTMORTEM_SECTIONS.map((s) => [s.key, String(form.get(s.key) ?? "")])) as PostmortemFields;
  if (intent === "save" || intent === "save_publish") {
    const saved = await settle(statusAdmin.savePostmortem(params.id, { ...values, by: staff.email }));
    if (!saved.ok) return { error: saved.error, values } satisfies ActionData;
    if (!saved.value.ok) return { error: saved.value.error.message, values } satisfies ActionData;
    if (intent === "save") return redirect(`/incidents/${params.id}/postmortem?done=saved#preview`);
  }
  if (intent === "save_publish" || intent === "publish" || intent === "unpublish") {
    const publish = intent !== "unpublish";
    const result = await settle(statusAdmin.publishPostmortem(params.id, { publish, by: staff.email }));
    if (!result.ok) return { error: result.error } satisfies ActionData;
    if (!result.value.ok) return { error: result.value.error.message } satisfies ActionData;
    return redirect(`/incidents/${params.id}/postmortem?done=${publish ? "published" : "unpublished"}`);
  }
  return { error: "Unknown action." } satisfies ActionData;
}

function Preview({ fields }: { fields: PostmortemFields }) {
  const shown = POSTMORTEM_SECTIONS.filter((s) => fields[s.key].trim());
  if (!shown.length) return <p className="text-sm text-muted">Nothing written yet.</p>;
  return (
    <div className="space-y-5">
      {shown.map((s) => (
        <section key={s.key}>
          <h3 className="text-sm font-semibold">{s.title}</h3>
          <div className="mt-1 space-y-2 text-sm text-fg-soft">
            {proseBlocks(fields[s.key]).map((block, i) =>
              block.kind === "list" ? (
                <ul key={i} className="list-disc space-y-1 pl-5">
                  {block.items.map((item, j) => (
                    <li key={j}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p key={i} className="whitespace-pre-line">
                  {block.text}
                </p>
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function PostmortemEditor({ loaderData, actionData }: Route.ComponentProps) {
  const { incident, error, done } = loaderData;
  const failed = actionData as ActionData | undefined;
  if (!incident) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Notice tone="warn">The status worker did not answer: {error}</Notice>
      </main>
    );
  }
  const saved = incident.postmortem;
  const fields: PostmortemFields = failed?.values ?? saved ?? incident.postmortem_draft;
  const published = saved?.published_at != null;
  const resolved = incident.resolved_at != null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <BackLink to={`/incidents/${incident.id}`}>{incident.title}</BackLink>
      <div className="mt-3">
        <PageHeader
          title="Postmortem"
          description={
            <>
              <SeverityBadge severity={incident.severity} /> <span className="ml-1">{incident.title}</span> · lasted {duration(incident.durations.to_resolve)}
            </>
          }
          actions={
            published ? (
              <a href={`${incident.url}#postmortem`} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
                On the status page <ExternalLink size={13} aria-hidden="true" />
              </a>
            ) : undefined
          }
        />
      </div>
      <div className="mt-4 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {failed && <Notice tone="error">{failed.error}</Notice>}
        {!resolved && <Notice tone="info">The incident is still open. Draft away; it can be published once it is resolved.</Notice>}
        {!saved && (
          <Notice tone="info">
            Started for you: the impact from its parts and times, the timeline from the incident's own, and the follow-ups as action items. The timeline includes internal notes: edit out anything that should stay inside.
          </Notice>
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <form method="post" className="min-w-0 space-y-4">
          <Section title="Write" description="Plain text. A blank line starts a paragraph; lines starting with “- ” become a list.">
            <div className="space-y-4">
              {POSTMORTEM_SECTIONS.map((s) => (
                <Field key={s.key} label={s.title} hint={s.hint}>
                  <Textarea name={s.key} rows={s.rows} maxLength={20000} defaultValue={fields[s.key]} className="font-[inherit]" />
                </Field>
              ))}
            </div>
          </Section>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" name="intent" value="save" variant="quiet">
              Save draft
            </Button>
            {resolved && !published && (
              <Button type="submit" name="intent" value="save_publish" variant="lavender">
                Save and publish
              </Button>
            )}
            {saved && (
              <span className="text-xs text-faint">
                Saved <When at={saved.updated_at} time /> by <span className="font-mono">{saved.updated_by}</span>
              </span>
            )}
          </div>
        </form>

        <div className="min-w-0 space-y-4 lg:sticky lg:top-6 lg:self-start">
          <Section
            id="preview"
            title="Preview"
            description={saved ? "As the status page shows it, from the last save." : "As the status page would show it."}
            actions={published ? <Badge tone="mint">Published</Badge> : <Badge>Not published</Badge>}
          >
            <Preview fields={saved ?? fields} />
          </Section>
          {saved && (
            <form method="post" className="flex flex-wrap items-center gap-3">
              {published ? (
                <>
                  <input type="hidden" name="intent" value="unpublish" />
                  <Button type="submit" variant="danger">
                    Take down
                  </Button>
                  <span className="text-xs text-faint">
                    Published <When at={saved.published_at} time />
                  </span>
                </>
              ) : (
                <>
                  <input type="hidden" name="intent" value="publish" />
                  <Button type="submit" variant="lavender" disabled={!resolved}>
                    Publish the saved draft
                  </Button>
                  <span className="text-xs text-faint">Needs a summary and a root cause.</span>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
