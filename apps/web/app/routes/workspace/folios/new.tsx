import { FOLIO_KIND_NOUNS, isFolioKind, type FolioKind } from "@g1t/contracts";
import { Form, data, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/new";
import { FOLIO_KIND_UI, KindIcon } from "../../../components/folios/kinds";
import { ErrorText } from "../../../components/ui";
import { Button } from "../../../components/ui/button";
import { page } from "../../../lib/meta";
import { folios } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New ${isFolioKind(params.kind) ? FOLIO_KIND_NOUNS[params.kind] : "artifact"} · ${params.owner} · g1t` });
}

/** The kinds that can be made now; the rest aren't found until their phase ships. */
function kindOf(value: string | undefined): FolioKind {
  if (!isFolioKind(value) || !FOLIO_KIND_UI[value].ready) throw data(null, { status: 404 });
  return value;
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  return { kind: kindOf(params.kind) };
}

/**
 * Makes an artifact, then goes to it: `POST -/artifacts/new/<kind>` with
 * optional `space`, `parent` and `template` (form fields, or the
 * address's search). Only a post makes one, so a prefetched or repeated
 * link never does; the form's button is busy until it lands.
 */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const kind = kindOf(params.kind);
  const form = await request.formData().catch(() => new FormData());
  const search = new URL(request.url).searchParams;
  const field = (name: string) => String(form.get(name) ?? search.get(name) ?? "").trim() || null;
  const made = await folios.create(params.owner.toLowerCase(), viewer, { kind, space_id: field("space"), parent_id: field("parent"), template_id: field("template") });
  if (!made.ok) return { error: made.error.message };
  throw redirect(made.value.path);
}

/** Opened as a link (from outside a page that posts): one button, so nothing is made by just visiting. */
export default function NewFolio({ loaderData, actionData }: Route.ComponentProps) {
  const { kind } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center text-center">
      <KindIcon kind={kind} size={22} box={48} />
      <h1 className="mt-4 text-xl font-semibold tracking-tight">New {FOLIO_KIND_NOUNS[kind]}</h1>
      <p className="mt-1 text-sm text-muted">It starts in your Private, where only you can see it, unless you chose a space.</p>
      {actionData?.error && (
        <div className="mt-4">
          <ErrorText>{actionData.error}</ErrorText>
        </div>
      )}
      <Form method="post" className="mt-6">
        <Button type="submit" disabled={busy} variant="accent" className="px-4 disabled:opacity-60">
          {busy ? "Starting…" : `Start the ${FOLIO_KIND_NOUNS[kind]}`}
        </Button>
      </Form>
    </div>
  );
}
