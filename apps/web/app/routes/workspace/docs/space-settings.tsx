import { DOC_ROLES, DOC_ROLE_LABELS, DOC_ROLE_SUMMARIES, type DocRole, type DocSpace, type DocSpaceMember } from "@g1t/contracts";
import { Archive } from "lucide-react";
import { useState } from "react";
import { Link, data, useNavigate } from "react-router";

import type { Route } from "./+types/space-settings";
import { useDocsAction, useDocsData } from "../../../components/docs/actions";
import { Face, SectionTitle } from "../../../components/docs/parts";
import { SpaceForm, initialSpace, spaceInput } from "../../../components/docs/space-form";
import { Button, ErrorText } from "../../../components/ui";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { SelectField } from "../../../components/ui/select";
import { page } from "../../../lib/meta";
import { docs, identity } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Settings · ${loaded?.space.name ?? "Space"} · Docs · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ space: DocSpace; members: DocSpaceMember[]; teams: { slug: string; name: string }[] }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [found, teams] = await Promise.all([docs.space(slug, params.space, viewer), identity.listTeams(viewer, slug).catch(() => null)]);
  if (!found.ok) throw data(null, { status: 404 });
  if (found.value.space.viewer_role !== "manage") throw data(null, { status: 403 });
  return { space: found.value.space, members: found.value.members, teams: teams?.ok ? teams.value.map((t) => ({ slug: t.slug, name: t.name })) : [] };
}

const ROLE_OPTIONS = DOC_ROLES.map((r) => ({ value: r, label: DOC_ROLE_LABELS[r], description: DOC_ROLE_SUMMARIES[r] }));

/** A space's settings: what it is, who it's for, its members and their roles, and how agents work in it. */
export default function SpaceSettings({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { space, members, teams } = loaderData;
  const layout = useDocsData();
  const navigate = useNavigate();
  const settings = useDocsAction(slug);
  const people = useDocsAction(slug);
  const [adding, setAdding] = useState("");
  const [addRole, setAddRole] = useState<DocRole>("edit");
  const [archiving, setArchiving] = useState(false);
  const listed = new Set(members.map((m) => m.key));
  const candidates = [
    ...(layout?.mentionables ?? []).map((m) => ({ value: m.kind === "agent" ? `agent:${m.id}` : `username:${m.name}`, label: m.kind === "agent" ? `${m.display_name} (agent)` : `${m.display_name} (@${m.name})` })),
    ...teams.map((t) => ({ value: `team:${t.slug}`, label: `${t.name} (team)` })),
  ].filter((c) => !listed.has(c.value));
  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-xs text-faint">
        <Link to={`/${slug}/-/docs/${space.slug}`} className="hover:text-fg">
          {space.name}
        </Link>{" "}
        / Settings
      </p>
      <h1 className="mt-1 text-xl font-semibold tracking-tight">Space settings</h1>
      <div className="mt-8">
        <SpaceForm
          initial={initialSpace(space)}
          teams={teams}
          isDefault={space.is_default}
          submitLabel="Save"
          busy={settings.busy}
          error={settings.error}
          onSubmit={async (value) => {
            const saved = await settings.send<DocSpace>("update_space", { space_id: space.id, space_change: spaceInput(value) });
            if (saved.ok && saved.value.slug !== space.slug) navigate(`/${slug}/-/docs/${saved.value.slug}/settings`, { replace: true });
          }}
        />
      </div>

      <section className="mt-12">
        <SectionTitle>Members</SectionTitle>
        <p className="mb-4 text-xs leading-relaxed text-faint">
          {space.kind === "private"
            ? "Only the people, agents and teams here can open this space."
            : "Everyone the space is for already has its base role; add people here to give them more. Workspace owners always have full access."}{" "}
          An agent added here still never does more than the person it works for.
        </p>
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {members.map((m) => (
            <li key={m.key} className="flex items-center gap-3 px-4 py-2.5">
              {m.kind === "team" ? (
                <span className="flex size-6 items-center justify-center rounded-full bg-raised text-xs">@</span>
              ) : (
                <Face who={{ kind: m.kind, id: m.key.slice(m.key.indexOf(":") + 1), name: m.name, avatar: m.avatar, avatar_seed: m.avatar_seed ?? null }} size={24} />
              )}
              <span className="min-w-0 grow">
                <span className="block truncate text-sm">{m.display_name}</span>
                <span className="block text-xs text-faint">{m.kind === "team" ? "Team" : m.kind === "agent" ? "Agent" : `@${m.name}`}</span>
              </span>
              <SelectField aria-label={`${m.display_name}'s role`} value={m.role} onValueChange={(role) => people.send("set_member", { space_id: space.id, member: m.key, role })} options={ROLE_OPTIONS} className="h-8 w-40" />
              <button type="button" onClick={() => people.send("set_member", { space_id: space.id, member: m.key, role: null })} className="text-xs text-faint hover:text-danger">
                Remove
              </button>
            </li>
          ))}
          {members.length === 0 && <li className="px-4 py-3 text-sm text-muted">Nobody added yet.</li>}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SelectField aria-label="Person, agent or team" value={adding} onValueChange={setAdding} placeholder="Add a person, agent or team" options={candidates} className="h-9 min-w-64 grow" />
          <SelectField aria-label="Their role" value={addRole} onValueChange={(r) => setAddRole(r as DocRole)} options={ROLE_OPTIONS} className="h-9 w-40" />
          <Button
            type="button"
            variant="quiet"
            disabled={!adding || people.busy}
            onClick={async () => {
              // People are named by username here; the service keys them by id.
              const member = adding.startsWith("username:") ? await memberKeyFor(slug, adding.slice(9)) : adding;
              if (!member) return people.setError("That person isn't in the workspace.");
              const done = await people.send("set_member", { space_id: space.id, member, role: addRole });
              if (done.ok) setAdding("");
            }}
          >
            Add
          </Button>
        </div>
        {people.error && (
          <div className="mt-2">
            <ErrorText>{people.error}</ErrorText>
          </div>
        )}
      </section>

      {!space.is_default && (
        <section className="mt-12 rounded-xl border border-danger/30 p-5">
          <h2 className="text-sm font-semibold">Archive this space</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">It leaves the sidebar and search. Its pages, history and comments are kept.</p>
          <Button type="button" variant="danger" onClick={() => setArchiving(true)} className="mt-3">
            <Archive size={14} /> Archive space
          </Button>
        </section>
      )}
      <AlertDialog open={archiving} onOpenChange={setArchiving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {space.name}?</AlertDialogTitle>
            <AlertDialogDescription>Nobody will see it in Docs until it is brought back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const done = await settings.send("update_space", { space_id: space.id, space_change: { archived: true } });
                if (done.ok) navigate(`/${slug}/-/docs`);
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A person's member key (`user:<id>`), from their username, as the site resolves it. */
async function memberKeyFor(slug: string, username: string): Promise<string | null> {
  try {
    const r = await fetch(`/${slug}/-/docs/api?person=${encodeURIComponent(username)}`, { headers: { accept: "application/json" } });
    const result = (await r.json()) as { ok: boolean; value?: string };
    return result.ok && result.value ? result.value : null;
  } catch {
    return null;
  }
}
