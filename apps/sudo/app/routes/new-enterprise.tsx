import { ArrowLeft, Building2 } from "lucide-react";
import { data, Link, redirect } from "react-router";

import type { Route } from "./+types/new-enterprise";
import { Avatar, Button, Field, Input, Notice, Section, Textarea } from "~/components/ui";
import { fields, parseSlugList, text } from "~/lib/forms";
import { admin } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "New enterprise · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ context }: Route.LoaderArgs) {
  requireStaff(context);
  return null;
}

type ActionData =
  | { error: string; values: Record<string, string> }
  | { review: { name: string; workspaces: string[]; values: Record<string, string> } };

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const values = fields(form, "name", "workspaces");
  const fail = (error: string) => data<ActionData>({ error, values }, { status: 422 });

  const name = values.name.replace(/\s+/g, " ");
  if (!name) return fail("Give the enterprise a name.");
  if (name.length > 100) return fail("Keep the name under 100 characters.");
  const workspaces = parseSlugList(values.workspaces);
  if (!workspaces.ok) return fail(workspaces.error);
  if (workspaces.value.length === 0) return fail("Name at least one workspace for it to pay for.");
  if (workspaces.value.length > 100) return fail("At most 100 workspaces at once.");

  // Moving workspaces onto it changes who pays for them: confirm first.
  if (text(form, "confirm") !== "yes") {
    return { review: { name, workspaces: workspaces.value, values } } satisfies ActionData;
  }
  const result = await admin.createEnterprise(name, workspaces.value, staff.email);
  if (!result.ok) return fail(result.error.message);
  return redirect(`/accounts/${encodeURIComponent(result.value.id)}?done=created#top`);
}

export default function NewEnterprise({ actionData }: Route.ComponentProps) {
  const result = actionData as ActionData | undefined;
  const review = result && "review" in result ? result.review : null;
  const error = result && "error" in result ? result : null;
  const values = review?.values ?? error?.values;

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:py-10">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Accounts
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">New enterprise</h1>
      <p className="mt-1 text-sm text-muted">
        One account that pays for several workspaces, as GitHub Enterprise does: one bill, one limit, one set of terms. Set its terms
        once it exists.
      </p>

      {review && (
        <section id="review" className="mt-6 scroll-mt-20 rounded-lg border border-merged/40 bg-merged/5 p-4 sm:p-5">
          <h2 className="font-semibold tracking-tight">Create {review.name}?</h2>
          <p className="mt-1 text-sm text-muted">
            These workspaces will be billed through it from now on, under its limit and terms instead of their own:
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {review.workspaces.map((slug) => (
              <li key={slug} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 font-mono text-xs">
                <Avatar name={slug} size={14} />
                {slug}
              </li>
            ))}
          </ul>
          <form method="post" action="/enterprises/new" className="mt-4 flex flex-wrap items-center gap-2">
            <input type="hidden" name="name" value={review.values.name} />
            <input type="hidden" name="workspaces" value={review.values.workspaces} />
            <input type="hidden" name="confirm" value="yes" />
            <Button type="submit" variant="lavender">
              <Building2 size={14} />
              Create enterprise
            </Button>
            <Link to="/enterprises/new" className="px-2 text-sm text-muted hover:text-fg">
              Cancel
            </Link>
          </form>
        </section>
      )}

      <Section title="Enterprise" className="mt-6">
        <form method="post" action="/enterprises/new#review" className="space-y-4">
          {error && <Notice tone="error">{error.error}</Notice>}
          <Field label="Name" hint="As it should appear on the bill.">
            <Input name="name" required maxLength={100} placeholder="Acme Corporation" defaultValue={values?.name ?? ""} />
          </Field>
          <Field label="Workspaces" hint="Slugs, separated by commas or one per line.">
            <Textarea name="workspaces" required rows={4} placeholder={"acme\nacme-labs"} defaultValue={values?.workspaces ?? ""} className="font-mono" />
          </Field>
          <div className="flex justify-end">
            <Button type="submit">Review</Button>
          </div>
        </form>
      </Section>
    </main>
  );
}
