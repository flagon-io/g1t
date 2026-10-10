import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/new";
import { page } from "../../lib/meta";
import { planHref } from "../../components/start-plan";
import { ButtonLink, ErrorText, Field, Input, SubmitButton } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { billing, identity } from "../../lib/services.server";
import { InvitationList } from "../../components/invitation-list";
import { answerInvitation, loadInvitations } from "../../lib/invitations.server";
import { declinedLine } from "../../lib/invitations";
import { assertSameOrigin, nextPath, requireUser } from "../../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "New workspace · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const owned = (user.workspaces ?? []).filter((membership) => membership.role === "owner").map((membership) => membership.slug);
  // A person owns at most one free workspace; identity refuses a second
  // either way, so a failure here only leaves the form up.
  const first = (user.workspaces ?? []).length === 0;
  const [free, invitations] = await Promise.all([
    owned.length > 0 ? billing.freeWorkspaces(owned).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    // Someone without a workspace may have been invited to one.
    first ? loadInvitations(user) : Promise.resolve([]),
  ]);
  const next = nextPath(request);
  return { user, first, free, invitations, next: next === "/" ? null : next };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  // Accepting or declining an invitation shown here (lib/invitations.server.ts).
  const answered = await answerInvitation(user, form, request);
  if (answered) return answered;
  const result = await identity.createWorkspace(
    user,
    String(form.get("slug") ?? ""),
    String(form.get("displayName") ?? ""),
  );
  if (!result.ok) return { error: result.error.message };
  // Someone sent here on their way elsewhere carries on to it.
  const next = nextPath(request);
  throw redirect(next === "/" ? `/${result.value.slug}` : next);
}

export default function NewWorkspace({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { user, first, free, invitations, next } = loaderData;
  const said = actionData as { error?: string; invitationError?: string; invitationId?: string; declined?: string } | undefined;
  return (
    <main className="mx-auto max-w-lg pt-8">
      <h1 className="text-xl font-semibold">
        {first ? "Create your workspace or ask to join one" : "New workspace"}
      </h1>
      {first && (
        <section className="mt-4">
          {said?.declined !== undefined && (
            <p className="mb-3 text-sm text-muted" role="status">
              {declinedLine(said.declined)}
            </p>
          )}
          {invitations.length > 0 ? (
            <>
              <h2 className="text-sm font-medium">You are invited</h2>
              <p className="mt-1 mb-3 text-sm text-muted">Accept an invitation to join that workspace, or decline it.</p>
              <InvitationList invitations={invitations} error={said?.invitationError} errorFor={said?.invitationId} next={next} />
            </>
          ) : (
            <p className="text-sm text-muted">
              To join a team that is on g1t already, ask one of its workspace's owners to invite you by your username,{" "}
              <span className="font-mono text-fg">{user.username}</span>. Their invitation shows here and in your notifications.
            </p>
          )}
          <h2 className="mt-8 text-sm font-medium">Or create your own</h2>
        </section>
      )}
      <p className="mt-2 text-sm text-muted">
        {first && "Everything on g1t lives in a workspace, so this comes first. "}
        A workspace holds repositories, the people who work on them and the
        access tokens that automate them, and is the first part of every
        address: <span className="font-mono text-fg">g1t.sh/workspace/repo</span>.
        Use one for yourself, and one for each team or company you work with.
      </p>
      {free.length > 0 ? (
        <OneFreeWorkspace free={free} />
      ) : (
        <>
          <Form method="post" className="mt-8 space-y-4">
            <Field
              label="Name in URLs"
              hint="Lowercase letters, digits and single hyphens. An owner can change it later; old addresses redirect for 90 days."
            >
              <div className="flex items-center gap-2 font-mono text-sm">
                <span className="text-muted">g1t.sh/</span>
                <Input
                  name="slug"
                  required
                  autoFocus
                  maxLength={39}
                  defaultValue={first ? user.username : ""}
                  pattern="[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*"
                />
              </div>
            </Field>
            <Field label="Display name (optional)">
              <Input name="displayName" maxLength={80} />
            </Field>
            <p className="text-xs text-faint">
              A new workspace is free. Each person can own one free workspace; more need the plan on the ones you have.
            </p>
            <ErrorText>{said?.error}</ErrorText>
            <SubmitButton pending="Creating…">Create workspace</SubmitButton>
          </Form>
        </>
      )}
    </main>
  );
}

/** Why there is no form: the person owns a free workspace already. */
function OneFreeWorkspace({ free }: { free: string[] }) {
  const [first] = free;
  return (
    <Card asChild className="mt-8 p-5">
      <section>
        <h2 className="font-medium">You already own a free workspace</h2>
        <p className="mt-2 text-sm text-muted">
          Each person can own one workspace that is not on the g1t plan.{" "}
          {free.length === 1 ? (
            <>
              Yours is <span className="font-mono text-fg">{first}</span>.
            </>
          ) : (
            <>
              You own {free.length} from before (
              {free.map((slug, i) => (
                <span key={slug}>
                  {i > 0 && ", "}
                  <span className="font-mono text-fg">{slug}</span>
                </span>
              ))}
              ), and keep them all.
            </>
          )}{" "}
          A new workspace starts free, so to make one, start the plan on {free.length === 1 ? "it" : "each of them"}, or delete{" "}
          {free.length === 1 ? "it" : "the ones"} you no longer use.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <ButtonLink to={planHref(first)}>Start the plan on {first}</ButtonLink>
          <Link to={`/${first}/-/settings`} className="text-sm text-muted hover:text-fg">
            Workspace settings
          </Link>
        </div>
        <p className="mt-4 text-xs text-faint">
          The plan is one price for everyone in the workspace, never per person.{" "}
          <Link to="/pricing" className="underline underline-offset-2 hover:text-fg">
            Pricing
          </Link>
        </p>
      </section>
    </Card>
  );
}
