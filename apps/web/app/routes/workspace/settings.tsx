import { Form, data, redirect } from "react-router";

import type { Route } from "./+types/settings";
import { page } from "../../lib/meta";
import { AvatarField } from "../../components/avatar-field";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import { readAvatarUpload } from "../../lib/avatar-upload";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Settings · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  // Owners only; to anyone else the page does not exist.
  if (roleIn(getViewer(context), params.owner) !== "owner") {
    throw data(null, { status: 404 });
  }
  const workspace = await identity.getWorkspace(params.owner);
  if (!workspace) throw data(null, { status: 404 });
  return { workspace };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = form.get("intent");
  // The icon: identity checks the owner and the image's bytes again.
  if (intent === "avatar" || intent === "remove-avatar") {
    let image: string | null = null;
    if (intent === "avatar") {
      const upload = await readAvatarUpload(form);
      if ("error" in upload) return { avatarError: upload.error };
      image = upload.image;
    }
    const result = await identity.setWorkspaceAvatar(user, params.owner, image);
    if (!result.ok) return { avatarError: result.error.message };
    return { saved: "avatar" as const };
  }
  const result = await identity.updateWorkspace(user, params.owner, {
    name: String(form.get("displayName") ?? ""),
    description: String(form.get("description") ?? ""),
  });
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${result.value.slug}`);
}

export default function WorkspaceSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { workspace } = loaderData;
  return (
    <div className="max-w-lg space-y-10">
      <section>
        <h2 className="font-medium">Icon</h2>
        <div className="mt-4">
          <AvatarField
            name={workspace.slug}
            image={workspace.avatar}
            square
            error={actionData && "avatarError" in actionData ? actionData.avatarError : undefined}
            about="Shown beside the workspace's name everywhere on g1t, and on its link previews. Without one, g1t draws its first letter."
          />
        </div>
      </section>

      <section>
        <h2 className="font-medium">Workspace details</h2>
        <Form method="post" className="mt-5 space-y-4">
          <Field
            label="Display name"
            hint="How people see the workspace: in the sidebar, at the top of its page and in link previews. Up to 80 characters; spaces and capitals are fine."
          >
            <Input name="displayName" maxLength={80} defaultValue={workspace.name} placeholder={workspace.slug} />
          </Field>
          <Field label="Description" hint="One line, shown at the top of the workspace's page.">
            <Input name="description" maxLength={160} defaultValue={workspace.description ?? ""} />
          </Field>
          <ErrorText>{actionData && "error" in actionData ? actionData.error : undefined}</ErrorText>
          <Button type="submit">Save</Button>
        </Form>
      </section>

      <section>
        <h2 className="font-medium">Address</h2>
        <p className="mt-3 font-mono text-sm text-fg">g1t.sh/{workspace.slug}</p>
        <p className="mt-1.5 text-xs text-faint">
          The workspace's slug: lowercase, in every repository's address and every clone URL. It cannot be
          changed, so links and clones keep working. Change the display name instead.
        </p>
      </section>
    </div>
  );
}
