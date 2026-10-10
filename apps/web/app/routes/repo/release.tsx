import { ChevronLeft, Trash2 } from "lucide-react";
import { Form, Link, data, redirect } from "react-router";

import type { Route } from "./+types/release";
import { ReleaseCard } from "../../components/releases";
import { ErrorText, SubmitButton } from "../../components/ui";
import { requireRepo } from "../../lib/access.server";
import { page } from "../../lib/meta";
import { repos } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";

export function meta({ params, loaderData, ...args }: Route.MetaArgs) {
  const title = loaderData?.release.name || params["*"];
  return page(args, { title: `${title} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { viewer, access } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  const release = unwrap(await repos.release(path, viewer, { tag: params["*"] ?? "" }));
  return { release, canPush: access.can.push };
}

/** Publishing a draft, or deleting the release (its tag stays). */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const id = String(form.get("id") ?? "");
  if (form.get("intent") === "publish") {
    const published = await repos.updateRelease(user, path, id, { draft: false });
    if (!published.ok) return data({ error: published.error.message }, { status: 400 });
    return { error: null };
  }
  if (form.get("intent") !== "delete") return data({ error: "Nothing to do." }, { status: 400 });
  const deleted = await repos.deleteRelease(user, path, id);
  if (!deleted.ok) return data({ error: deleted.error.message }, { status: 400 });
  throw redirect(`/${params.owner}/${params.repo}/releases`);
}

export default function ReleasePage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { release, canPush } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to={`${base}/releases`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-accent">
          <ChevronLeft size={15} />
          Releases
        </Link>
        {canPush && (
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="id" value={release.id} />
            {release.draft && (
              <SubmitButton name="intent" value="publish" pending="Publishing…">
                Publish release
              </SubmitButton>
            )}
            <SubmitButton variant="destructive" name="intent" value="delete" pending="Deleting…">
              <Trash2 size={14} />
              Delete release
            </SubmitButton>
          </Form>
        )}
      </div>
      {actionData?.error && <ErrorText>{actionData.error}</ErrorText>}
      <ReleaseCard release={release} repo={{ namespace: params.owner, name: params.repo }} linkTitle={false} />
      {canPush && <p className="text-xs text-faint">Deleting a release keeps its tag. Delete the tag with git: <code className="font-mono">git push origin :refs/tags/{release.tagName}</code></p>}
    </div>
  );
}
