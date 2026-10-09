import { data, useNavigate } from "react-router";

import type { Route } from "./+types/space-new";
import { useFoliosAction } from "../../../components/folios/actions";
import { SpaceForm, initialSpace, spaceInput } from "../../../components/folios/space-form";
import { spacePath } from "../../../lib/folios";
import { page } from "../../../lib/meta";
import { identity } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New space · Artifacts · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const teams = await identity.listTeams(viewer, params.owner.toLowerCase()).catch(() => null);
  return { teams: teams?.ok ? teams.value.map((t) => ({ slug: t.slug, name: t.name })) : [] };
}

/** A new space: for everyone, a team, or only its members. Whoever makes it has full access. */
export default function NewSpace({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const navigate = useNavigate();
  const { send, busy, error } = useFoliosAction(slug);
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight">New space</h1>
      <p className="mt-1 mb-8 text-sm text-muted">A space holds artifacts for a team, a project or a topic. What goes in it follows its access.</p>
      <SpaceForm
        initial={initialSpace()}
        teams={loaderData.teams}
        submitLabel="Create space"
        busy={busy}
        error={error}
        onSubmit={async (value) => {
          const made = await send<{ slug: string }>("create_space", { space: spaceInput(value) });
          if (made.ok) navigate(spacePath(slug, made.value.slug));
        }}
      />
    </div>
  );
}
