import { ArrowLeft } from "lucide-react";
import { Form, Link } from "react-router";

import type { AccessToken } from "@g1t/contracts";

import type { Route } from "./+types/token-new";
import { page } from "../../lib/meta";
import { EmptyState, ErrorText, SubmitButton } from "../../components/ui";
import { TokenForm } from "../../components/token-form";
import { TokenCreated } from "../../components/token-list";
import { tokenFromForm } from "../../lib/access-tokens";
import { workspaceRepos } from "../../lib/access-tokens.server";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

// A new token for the workspace: the same form as a person's, owned by the
// workspace. Owners only.

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New access token · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const owner = roleIn(viewer, slug) === "owner";
  return { slug, owner, repos: owner ? await workspaceRepos(viewer, slug) : [] };
}

type ActionResult = { secret: string; token: AccessToken; error: null } | { secret: null; token: null; error: string };

export async function action({ request, params, context }: Route.ActionArgs): Promise<ActionResult> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const input = tokenFromForm(await request.formData(), { workspaceOwned: true, owner: slug });
  if (!input.ok) return { secret: null, token: null, error: input.error };
  const created = await identity.createToken(user, input.value);
  if (!created.ok) return { secret: null, token: null, error: created.error.message };
  return { secret: created.value.token, token: created.value.info, error: null };
}

export default function NewWorkspaceToken({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, owner, repos } = loaderData;
  const back = `/${slug}/-/tokens`;
  return (
    <section className="max-w-2xl space-y-6">
      <div>
        <Link to={back} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
          <ArrowLeft size={13} /> Access tokens
        </Link>
        <h2 className="mt-2 text-lg font-semibold tracking-tight">New token for {slug}</h2>
      </div>
      {!owner ? (
        <EmptyState title="Owners only">Only an owner of {slug} can make its tokens.</EmptyState>
      ) : actionData?.secret ? (
        <TokenCreated secret={actionData.secret} token={actionData.token} back={back} />
      ) : (
        <Form method="post" className="space-y-6">
          <TokenForm workspaceOwned slug={slug} repos={repos} preset="ci" />
          <ErrorText>{actionData?.error}</ErrorText>
          <SubmitButton pending="Generating…">Generate token</SubmitButton>
        </Form>
      )}
    </section>
  );
}
