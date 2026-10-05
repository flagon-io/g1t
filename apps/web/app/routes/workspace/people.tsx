import { Form } from "react-router";

import type { Route } from "./+types/people";
import { page } from "../../lib/meta";
import { Avatar, Button, ErrorText, Field, Input, Pill } from "../../components/ui";
import { identity } from "../../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  roleIn,
  unwrap,
} from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `People · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  return {
    role: roleIn(viewer, params.owner),
    members: unwrap(await identity.listMembers(params.owner, viewer)),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const username = String(form.get("member") ?? "");
  const result =
    form.get("action") === "remove"
      ? await identity.removeMember(user, params.owner, username)
      : await identity.addMember(user, params.owner, username);
  return result.ok ? null : { error: result.error.message };
}

export default function WorkspacePeople({ loaderData, actionData }: Route.ComponentProps) {
  const { role, members } = loaderData;
  return (
    <div className="max-w-2xl">
      <ul className="divide-y divide-line rounded-xl border border-line">
        {members.map((member) => (
          <li key={member.username} className="flex items-center gap-3 px-4 py-3">
            <Avatar name={member.username} size={28} />
            <span className="grow font-mono text-sm">{member.username}</span>
            <Pill>{member.role}</Pill>
            {role === "owner" && member.role !== "owner" && (
              <Form method="post">
                <input type="hidden" name="action" value="remove" />
                <input type="hidden" name="member" value={member.username} />
                <Button variant="quiet" type="submit">
                  Remove
                </Button>
              </Form>
            )}
          </li>
        ))}
      </ul>
      {role === "owner" && (
        <Form method="post" className="mt-6 flex items-end gap-3">
          <div className="grow">
            <Field label="Add a member" hint="Their g1t username. They join as a member.">
              <Input name="member" required maxLength={39} />
            </Field>
          </div>
          <div className="pb-6">
            <Button type="submit">Add</Button>
          </div>
        </Form>
      )}
      <ErrorText>{actionData?.error}</ErrorText>
    </div>
  );
}
