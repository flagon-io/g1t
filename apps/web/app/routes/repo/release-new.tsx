import { Form, data, redirect } from "react-router";

import { MAX_RELEASE_BODY_CHARS, MAX_RELEASE_NAME_CHARS } from "@g1t/contracts";

import type { Route } from "./+types/release-new";
import { encodeTag } from "../../components/releases";
import { ErrorText, Field, Input, SubmitButton, Textarea } from "../../components/ui";
import { requireRepo } from "../../lib/access.server";
import { page } from "../../lib/meta";
import { repos } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New release · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { viewer, repo } = await requireRepo(context, params, "push");
  const path = { namespace: params.owner, name: params.repo };
  const [tags, branches] = await Promise.all([
    repos.tags(path, viewer).then((found) => (found.ok ? found.value.map((tag) => tag.name) : [])).catch(() => []),
    repos.branches(path, viewer).then((found) => (found.ok ? found.value.map((branch) => branch.name) : [])).catch(() => []),
  ]);
  return { tags, branches, defaultBranch: repo.defaultBranch };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const tagName = text("tag");
  if (!tagName) return data({ error: "Choose a tag, or name a new one." }, { status: 400 });
  const created = await repos.createRelease(user, { namespace: params.owner, name: params.repo }, {
    tagName,
    target: text("target") || null,
    name: text("name") || null,
    body: String(form.get("body") ?? ""),
    draft: form.get("intent") === "draft",
    prerelease: form.get("prerelease") === "on",
  });
  if (!created.ok) return data({ error: created.error.message }, { status: 400 });
  throw redirect(`/${params.owner}/${params.repo}/releases/tag/${encodeTag(created.value.tagName)}`);
}

export default function NewRelease({ loaderData, actionData }: Route.ComponentProps) {
  const { tags, branches, defaultBranch } = loaderData;
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">New release</h2>
        <p className="mt-1 text-sm text-muted">
          Publish a tag with a title and notes. A tag that does not exist yet is made at the branch or commit you choose.
        </p>
      </div>
      <Form method="post" className="space-y-4 rounded-xl border border-line bg-surface p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tag" hint={tags.length > 0 ? "An existing tag, or a new one such as v1.0.0." : "A new tag, such as v1.0.0."}>
            <Input name="tag" list="release-tags" required placeholder="v1.0.0" />
          </Field>
          <Field label="Target" hint="Where a new tag is made. Ignored for a tag that exists.">
            <Input name="target" list="release-targets" placeholder={defaultBranch} />
          </Field>
        </div>
        <datalist id="release-tags">
          {tags.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
        <datalist id="release-targets">
          {branches.map((branch) => (
            <option key={branch} value={branch} />
          ))}
        </datalist>
        <Field label="Title">
          <Input name="name" maxLength={MAX_RELEASE_NAME_CHARS} placeholder="What this release is" />
        </Field>
        <Field label="Notes" hint="Markdown: what changed, and anything people need to do.">
          <Textarea name="body" rows={12} maxLength={MAX_RELEASE_BODY_CHARS} placeholder={"## What changed\n\n- "} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="prerelease" className="size-4" />
          Set as a pre-release: not ready for everyone, never the latest
        </label>
        {actionData?.error && <ErrorText>{actionData.error}</ErrorText>}
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton name="intent" value="publish" pending="Publishing…">
            Publish release
          </SubmitButton>
          <SubmitButton variant="quiet" name="intent" value="draft" pending="Saving…">
            Save draft
          </SubmitButton>
        </div>
      </Form>
    </div>
  );
}
