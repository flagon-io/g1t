import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Form, Link, data, redirect } from "react-router";

import { TEAM_VISIBILITY_SUMMARIES, teamSlug } from "@g1t/contracts";

import type { Route } from "./+types/team-new";
import { page } from "../../lib/meta";
import { ErrorText, Field, Input, SubmitButton } from "../../components/ui";
import { Textarea } from "../../components/ui/textarea";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { newTeamFromForm, parentChoices, teamPath } from "../../lib/teams";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn, unwrap } from "../../lib/session.server";

/** The parent select's value for "no parent": Radix selects have no empty value. */
const NO_PARENT = "-";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New team · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const teams = unwrap(await identity.listTeams(viewer, params.owner));
  // A new team goes under a team its creator may manage.
  const parents = parentChoices(teams, null).filter((team) => team.can_manage);
  const wanted = new URL(request.url).searchParams.get("parent");
  return { parents, parent: parents.some((team) => team.slug === wanted) ? wanted : null };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const team = newTeamFromForm(form);
  if (team.parent === NO_PARENT) team.parent = null;
  const made = await identity.createTeam(user, params.owner, team);
  if (!made.ok) return { error: made.error.message };
  throw redirect(teamPath(made.value.workspace, made.value.slug));
}

export default function NewTeam({ loaderData, actionData, params }: Route.ComponentProps) {
  const { parents, parent } = loaderData;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [visibility, setVisibility] = useState("visible");
  const handle = slug || teamSlug(name) || "team";
  return (
    <div className="max-w-2xl">
      <Link to={`/${params.owner}/-/teams`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Teams
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">New team</h1>
      <p className="mt-1.5 text-sm text-muted">
        A group of {params.owner}'s members, given roles on repositories together. You become its maintainer.
      </p>

      <Form method="post" className="mt-8 space-y-6">
        <Field label="Name">
          <Input name="name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Backend" />
        </Field>
        <Field label="Slug" hint={`Mentioned as @${params.owner}/${handle}. Made from the name unless you choose one.`}>
          <Input
            name="slug"
            maxLength={60}
            value={slug}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
            placeholder={teamSlug(name) ?? "backend"}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
          />
        </Field>
        <Field label="Description" hint="What the team does, in a line.">
          <Textarea name="description" rows={2} maxLength={280} />
        </Field>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-muted">Visibility</legend>
          <RadioGroup name="visibility" value={visibility} onValueChange={setVisibility} className="space-y-3">
            <RadioOption value="visible" label="Visible" description={TEAM_VISIBILITY_SUMMARIES.visible} />
            <RadioOption value="secret" label="Secret" description={TEAM_VISIBILITY_SUMMARIES.secret} />
          </RadioGroup>
        </fieldset>

        {visibility === "visible" && parents.length > 0 && (
          <div>
            <span className="mb-1.5 block text-sm font-medium text-muted">Parent team</span>
            <Select name="parent" defaultValue={parent ?? NO_PARENT}>
              <SelectTrigger aria-label="Parent team" className="sm:max-w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PARENT}>No parent</SelectItem>
                {parents.map((team) => (
                  <SelectItem key={team.slug} value={team.slug}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="mt-1.5 block text-xs text-faint">
              A child team has its parent's roles on repositories, and hears what is asked of its parent.
            </span>
          </div>
        )}

        <Field label="Members" hint="Usernames of members of the workspace, separated by spaces or commas. You can add more later.">
          <Input name="members" placeholder="ana bo" />
        </Field>

        <ErrorText>{actionData?.error ?? null}</ErrorText>
        <SubmitButton pending="Creating…">Create team</SubmitButton>
      </Form>
    </div>
  );
}
