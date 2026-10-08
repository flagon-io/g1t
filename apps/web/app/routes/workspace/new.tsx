import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/new";
import { page } from "../../lib/meta";
import { planHref } from "../../components/start-plan";
import { ButtonLink, ErrorText, Field, Input, SubmitButton } from "../../components/ui";
import { billing, identity } from "../../lib/services.server";
import { assertSameOrigin, nextPath, requireUser } from "../../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "New workspace · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const owned = (user.workspaces ?? []).filter((membership) => membership.role === "owner").map((membership) => membership.slug);
  // A person owns at most one free workspace; identity refuses a second
  // either way, so a failure here only leaves the form up.
  const free = owned.length > 0 ? await billing.freeWorkspaces(owned).catch(() => [] as string[]) : [];
  return { user, first: (user.workspaces ?? []).length === 0, free };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
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
  const { user, first, free } = loaderData;
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-xl font-semibold">
        {first ? "Create your workspace" : "New workspace"}
      </h1>
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
          {!user.verified && (
            <p className="mt-4 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm">
              Confirm your email address first. We sent you a link.
            </p>
          )}
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
            <ErrorText>{actionData?.error}</ErrorText>
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
    <section className="mt-8 rounded-xl border border-line bg-surface p-5">
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
  );
}
