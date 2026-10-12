import { ArrowLeft } from "lucide-react";
import { Form, Link, data, redirect } from "react-router";

import type { AdminRunner, IngestToken } from "@g1t/contracts";

import type { Route } from "./+types/workspace-abuse";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Section, When } from "~/components/ui";
import { parseSlug, text } from "~/lib/forms";
import { admin, identity, runnersAdmin, telemetry, workspaceProjects } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";
import { SUSPEND_WORKSPACE_ABOUT, isSuspensionHold, parseReason, suspensionHold } from "~/lib/suspension";

export const meta: Route.MetaFunction = ({ params }) => [
  { title: `Suspend and clean up · ${params.slug} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

function slugOf(raw: string): string {
  const parsed = parseSlug(raw);
  if (!parsed.ok) throw data("That is not a workspace slug.", { status: 404 });
  return parsed.value;
}

/** Each project's ingest tokens, the ones people made (g1t's own for deployments are not listed). */
async function telemetryTokens(slug: string): Promise<{ project: { id: string; slug: string; name: string }; tokens: IngestToken[] }[]> {
  const projects = await workspaceProjects(slug);
  if (!projects.ok) throw new Error(projects.error.message);
  return Promise.all(
    projects.value.map(async (project) => ({
      project: { id: project.id, slug: project.slug, name: project.name },
      tokens: await telemetry.tokens({ project_id: project.id }).catch(() => [] as IngestToken[]),
    })),
  );
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const slug = slugOf(params.slug);
  const [detail, runners, tokens] = await Promise.all([
    settle(identity.workspace(slug)),
    settle(runnersAdmin.list(slug)),
    settle(telemetryTokens(slug)),
  ]);
  if (detail.ok && !detail.value) throw data(`There is no workspace called ${slug}.`, { status: 404 });
  const done = new URL(request.url).searchParams.get("done");
  const DONE: Record<string, string> = {
    suspended: `Suspended ${slug}, and put a hold on its compute.`,
    lifted: `Lifted the suspension of ${slug}, and the hold it put on.`,
    runners: "Removed the runners. What they were running failed; their credentials stopped at once.",
    tokens: "Revoked the tokens. Anything sending with them is refused from now on.",
  };
  return {
    slug,
    suspended: detail.ok ? (detail.value?.suspended ?? null) : null,
    runners: runners.ok ? runners.value : ([] as AdminRunner[]),
    runnersError: runners.ok ? null : runners.error,
    tokens: tokens.ok ? tokens.value : [],
    tokensError: tokens.ok ? null : tokens.error,
    error: detail.ok ? null : detail.error,
    done: done ? (DONE[done] ?? null) : null,
  };
}

/** Puts the suspension's hold on, or takes it off, keeping every other allowance. */
async function setHold(slug: string, hold: string | null, staff: string, note: string): Promise<string | null> {
  const account = await admin.account(slug);
  if (!account.ok) return account.error.message;
  const { allowances, id, kind } = account.value.summary.account;
  if (kind === "enterprise") return null;
  const current = allowances?.hold ?? null;
  // Lifting takes off only a hold a suspension put there.
  if (hold === null && !isSuspensionHold(current)) return null;
  const set = await admin.setAllowances(id, { plan: false, ossRepoMicros: null, trialMicros: null, ...allowances, hold }, note, staff);
  return set.ok ? null : set.error.message;
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const slug = slugOf(params.slug);
  const form = await request.formData();
  const intent = text(form, "intent");
  const back = (done: string) => redirect(`/workspaces/${encodeURIComponent(slug)}/abuse?done=${done}`);
  if (intent === "suspend") {
    const reason = parseReason(text(form, "reason"));
    if (!reason.ok) return data({ error: reason.error, section: "suspend" }, { status: 422 });
    const result = await identity.suspendWorkspace(slug, true, reason.value, staff.email);
    if (!result.ok) return data({ error: result.error.message, section: "suspend" }, { status: 422 });
    const held = await setHold(slug, suspensionHold(reason.value), staff.email, `Suspended: ${reason.value}`);
    if (held) return data({ error: `Suspended, but the hold on its compute was not set: ${held}`, section: "suspend" }, { status: 422 });
    throw back("suspended");
  }
  if (intent === "lift") {
    const result = await identity.suspendWorkspace(slug, false, "", staff.email);
    if (!result.ok) return data({ error: result.error.message, section: "suspend" }, { status: 422 });
    const held = await setHold(slug, null, staff.email, "Suspension lifted");
    if (held) return data({ error: `Lifted, but the hold on its compute was not taken off: ${held}`, section: "suspend" }, { status: 422 });
    throw back("lifted");
  }
  if (intent === "remove-runners") {
    const id = text(form, "id") || null;
    const result = await runnersAdmin.remove(slug, id, staff.email);
    if (!result.ok) return data({ error: result.error.message, section: "runners" }, { status: 422 });
    throw back("runners");
  }
  if (intent === "revoke-tokens") {
    const project = text(form, "project");
    const only = text(form, "id");
    const tokens = await telemetry.tokens({ project_id: project });
    for (const token of tokens.filter((token) => !only || token.id === only)) {
      await telemetry.revokeToken({ project_id: project, id: token.id });
    }
    console.log(`sudo: ${staff.email} revoked ingest tokens of ${slug}'s project ${project}`);
    throw back("tokens");
  }
  return data({ error: "Unknown action.", section: "top" }, { status: 400 });
}

export default function WorkspaceAbuse({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, suspended, runners, runnersError, tokens, tokensError, error, done } = loaderData;
  const errorFor = (section: string) => (actionData && "section" in actionData && actionData.section === section ? actionData.error : null);
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
      <Link to={`/workspaces/${slug}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> {slug}
      </Link>
      <PageHeader title="Suspend and clean up" description={`What staff can stop in ${slug} after abuse: the workspace itself, its self-hosted runners, and its projects' telemetry tokens.`} />
      <div className="mt-5 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="warn">Identity did not answer: {error}</Notice>}
      </div>

      <Section id="suspend" title="Suspension" description={SUSPEND_WORKSPACE_ABOUT} className="mt-6">
        {suspended ? (
          <Form method="post" className="space-y-3">
            <Notice tone="error">
              Suspended <When at={suspended.at} /> by {suspended.by}: {suspended.reason}
            </Notice>
            {errorFor("suspend") && <Notice tone="error">{errorFor("suspend")}</Notice>}
            <Button type="submit" name="intent" value="lift" variant="quiet">
              Lift the suspension
            </Button>
          </Form>
        ) : (
          <Form method="post" className="space-y-3">
            <Field label="Why" hint="Kept with the suspension and in the audit log.">
              <Input name="reason" required maxLength={500} placeholder="e.g. Mining on self-hosted runners" />
            </Field>
            {errorFor("suspend") && <Notice tone="error">{errorFor("suspend")}</Notice>}
            <Button type="submit" name="intent" value="suspend" variant="danger">
              Suspend {slug}
            </Button>
          </Form>
        )}
      </Section>

      <Section id="runners" title="Self-hosted runners" description="Removing a runner fails what it was running and stops its credential at once. Removing all of them also ends the registration tokens the workspace has out." className="mt-6">
        {runnersError && <Notice tone="warn">Actions did not answer: {runnersError}</Notice>}
        {errorFor("runners") && <Notice tone="error">{errorFor("runners")}</Notice>}
        {runners.length === 0 ? (
          <EmptyState title="No runners">{slug} has no self-hosted runners.</EmptyState>
        ) : (
          <div className="space-y-2">
            {runners.map((runner) => (
              <Form method="post" key={runner.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-mono">{runner.name}</span>
                  {runner.repo && <span className="text-muted"> · {runner.repo}</span>}
                  <span className="block text-xs text-faint">
                    {runner.os} · {runner.version} · last seen {runner.lastSeenAt ? <When at={runner.lastSeenAt} /> : "never"}
                    {runner.createdBy ? ` · added by ${runner.createdBy}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {runner.busy && <Badge tone="warn">Running a job</Badge>}
                  <input type="hidden" name="id" value={runner.id} />
                  <Button type="submit" name="intent" value="remove-runners" variant="danger">
                    Remove
                  </Button>
                </span>
              </Form>
            ))}
            <Form method="post">
              <Button type="submit" name="intent" value="remove-runners" variant="danger">
                Remove all {runners.length} and end registration tokens
              </Button>
            </Form>
          </div>
        )}
      </Section>

      <Section id="telemetry" title="Telemetry ingest tokens" description="Tokens people made to send OpenTelemetry to a project. Revoking one refuses anything sent with it from then on. g1t's own token for its deployments is not listed." className="mt-6">
        {tokensError && <Notice tone="warn">Projects or telemetry did not answer: {tokensError}</Notice>}
        {tokens.every((row) => row.tokens.length === 0) ? (
          <EmptyState title="No ingest tokens">No project in {slug} has one.</EmptyState>
        ) : (
          <div className="space-y-4">
            {tokens
              .filter((row) => row.tokens.length > 0)
              .map((row) => (
                <div key={row.project.id} className="rounded-lg border border-line bg-surface p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{row.project.name}</span>
                    <Form method="post">
                      <input type="hidden" name="project" value={row.project.id} />
                      <Button type="submit" name="intent" value="revoke-tokens" variant="danger">
                        Revoke all {row.tokens.length}
                      </Button>
                    </Form>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {row.tokens.map((token) => (
                      <li key={token.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {token.name} <span className="font-mono text-xs text-faint">{token.hint}</span>
                        </span>
                        <Form method="post">
                          <input type="hidden" name="project" value={row.project.id} />
                          <input type="hidden" name="id" value={token.id} />
                          <Button type="submit" name="intent" value="revoke-tokens" variant="quiet">
                            Revoke
                          </Button>
                        </Form>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </Section>
    </main>
  );
}
