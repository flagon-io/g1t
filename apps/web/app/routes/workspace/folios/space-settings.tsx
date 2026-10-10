import { DOC_ROLES, DOC_ROLE_LABELS, DOC_ROLE_SUMMARIES, type DocRole, type DocSpace, type DocSpaceMember } from "@g1t/contracts";
import { Archive, Share2 } from "lucide-react";
import { useState } from "react";
import { Link, data, useNavigate } from "react-router";

import type { Route } from "./+types/space-settings";
import { memberKey } from "../../../components/folios/share-dialog";
import { useFoliosAction, useFoliosData } from "../../../components/folios/actions";
import { Face, SectionTitle } from "../../../components/folios/parts";
import { SpaceForm, initialSpace, spaceInput } from "../../../components/folios/space-form";
import { ErrorText } from "../../../components/ui";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { SelectField } from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { spacePath } from "../../../lib/folios";
import { page } from "../../../lib/meta";
import { docs, identity } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Settings · ${loaded?.space.name ?? "Space"} · Artifacts · ${params.owner} · g1t` });
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

/** A space's settings: what it is, who it's for, its members and their roles, whether editors can share, and how agents work in it. */
export default function SpaceSettings({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { space, members, teams } = loaderData;
  const layout = useFoliosData();
  const navigate = useNavigate();
  const settings = useFoliosAction(slug);
  const people = useFoliosAction(slug);
  const sharing = useFoliosAction(slug);
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
        <Link to={spacePath(slug, space.slug)} className="hover:text-fg">
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
            if (saved.ok && saved.value.slug !== space.slug) navigate(`${spacePath(slug, saved.value.slug)}/settings`, { replace: true });
          }}
        />
      </div>

      <section className="mt-12">
        <SectionTitle>Sharing</SectionTitle>
        <Card asChild className="flex items-start gap-3 px-4 py-3">
          <label>
            <Share2 size={16} className="mt-0.5 shrink-0 text-faint" />
            <span className="min-w-0 grow">
              <span className="block text-sm text-fg">Editors can share</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-faint">People who can edit what's in this space can also share it with others, up to Can edit. Off: only people with full access can share.</span>
            </span>
            <Switch
              checked={space.editors_can_share}
              disabled={sharing.busy}
              onCheckedChange={(on) => sharing.send("update_space", { space_id: space.id, space_change: { editors_can_share: on } })}
              aria-label="Editors can share"
            />
          </label>
        </Card>
        {sharing.error && (
          <div className="mt-2">
            <ErrorText>{sharing.error}</ErrorText>
          </div>
        )}
      </section>

      <section className="mt-12">
        <SectionTitle>Members</SectionTitle>
        <p className="mb-4 text-xs leading-relaxed text-faint">
          {space.kind === "private"
            ? "Only the people, agents and teams here can open this space."
            : "Everyone the space is for already has its base role; add people here to give them more. Workspace owners always have full access."}{" "}
          An agent added here still never does more than the person it works for.
        </p>
        <Card asChild divided className="overflow-hidden">
          <ul>
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
                <Button type="button" onClick={() => people.send("set_member", { space_id: space.id, member: m.key, role: null })} variant="link" size="inline" className="text-xs text-faint hover:text-danger font-normal">
                  Remove
                </Button>
              </li>
            ))}
            {members.length === 0 && <li className="px-4 py-3 text-sm text-muted">Nobody added yet.</li>}
          </ul>
        </Card>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SelectField aria-label="Person, agent or team" value={adding} onValueChange={setAdding} placeholder="Add a person, agent or team" options={candidates} className="h-9 min-w-64 grow" />
          <SelectField aria-label="Their role" value={addRole} onValueChange={(r) => setAddRole(r as DocRole)} options={ROLE_OPTIONS} className="h-9 w-40" />
          <Button
            type="button"
            variant="outline"
            disabled={!adding || people.busy}
            onClick={async () => {
              // People are named by username here; the service keys them by id.
              const member = adding.startsWith("username:") ? await memberKey(slug, adding.slice(9)) : adding;
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
          <p className="mt-1 text-xs leading-relaxed text-muted">It leaves the sidebar and search. What's in it, its history and comments are kept.</p>
          <Button type="button" variant="destructive" onClick={() => setArchiving(true)} className="mt-3">
            <Archive size={14} /> Archive space
          </Button>
        </section>
      )}
      <AlertDialog open={archiving} onOpenChange={setArchiving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {space.name}?</AlertDialogTitle>
            <AlertDialogDescription>Nobody will see it in Artifacts until it is brought back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const done = await settings.send("update_space", { space_id: space.id, space_change: { archived: true } });
                if (done.ok) navigate(`/${slug}/-/artifacts`);
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
