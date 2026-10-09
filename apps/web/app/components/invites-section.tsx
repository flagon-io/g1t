import { Mail } from "lucide-react";
import { useState } from "react";
import { Form, Link } from "react-router";

import type { Invite, InvitesOverview } from "@g1t/contracts";

import { CopyLine, ErrorText, Field, Input, SubmitButton, TimeAgo } from "./ui";
import { CheckboxOption } from "./ui/checkbox";
import { Hint } from "./ui/hint";
import { SelectField } from "./ui/select";
import { G1T_INVITES, inviteFor, inviteKind, inviteLink, invitesPage, inviteState, moreInvitesMailto, remainingLine } from "../lib/invites";
import type { BringIntoChoices } from "../lib/invites.server";

const SELECT = "h-auto w-full py-2 sm:w-auto sm:min-w-40";

const TONE: Record<"pending" | "done" | "dead", string> = {
  pending: "border-accent/40 text-accent",
  done: "border-merged/40 text-merged",
  dead: "border-line text-faint",
};

function InviteRow({ invite, origin }: { invite: Invite; origin: string }) {
  const state = inviteState(invite);
  const kind = inviteKind(invite);
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${TONE[state.tone]}`}>{state.label}</span>
        <span className="min-w-0 truncate text-sm">{inviteFor(invite)}</span>
        <Hint
          label={
            kind.kind === "g1t"
              ? "Lets them make an account. It adds them to no workspace."
              : "An invitation to join this workspace, which they accept or decline. Without an account, it lets them make one first."
          }
        >
          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">{kind.label}</span>
        </Hint>
        {(invite.status === "pending" || invite.status === "awaiting_confirmation" || invite.status === "awaiting_answer") && (
          <Form method="post" className="ml-auto">
            <input type="hidden" name="intent" value="revoke-invite" />
            <input type="hidden" name="id" value={invite.id} />
            <SubmitButton variant="quiet" match={{ intent: "revoke-invite", id: invite.id }} pending="Revoking…">
              Revoke
            </SubmitButton>
          </Form>
        )}
      </div>
      <p className="text-xs text-faint">
        <span className="font-mono">{invite.hint}…</span> · made <TimeAgo at={invite.createdAt} />
        {invite.status === "pending" && (
          <>
            {" "}· works until {new Date(invite.expiresAt).toISOString().slice(0, 10)}
          </>
        )}
        {invite.chargedTo === "workspace" && invite.workspace == null && " · from a workspace's invites"}
      </p>
      {invite.status === "pending" && invite.code && <CopyLine text={inviteLink(invite.code, origin)} />}
    </li>
  );
}

/** "To bring someone into a workspace, invite them from that workspace's People page", with those pages. */
function Elsewhere({ people }: { people: BringIntoChoices["people"] }) {
  return (
    <p className="mt-4 text-sm text-muted">
      {G1T_INVITES.elsewhere}
      {people.length > 0 ? ": " : "."}
      {people.map((workspace, index) => (
        <span key={workspace.slug}>
          {index > 0 && ", "}
          <Link to={workspace.to} className="text-fg underline underline-offset-4 hover:text-accent">
            {workspace.name}
          </Link>
        </span>
      ))}
      {people.length > 0 && "."}
    </p>
  );
}

/**
 * Making an invite to g1t: an address (or anyone with the link), whose
 * invites it uses, and, only when its box is ticked, a workspace to invite
 * them to as well. Unticked, nothing about a workspace is sent.
 */
function InviteForm({ overview, bringInto }: { overview: InvitesOverview; bringInto: BringIntoChoices }) {
  const [alsoJoin, setAlsoJoin] = useState(false);
  const { workspaces } = overview;
  return (
    <Form method="post" className="mt-4 space-y-4">
      <input type="hidden" name="intent" value="create-invite" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="grow">
          <Field label="Email (optional)">
            <Input name="email" type="email" maxLength={254} placeholder="Anyone with the link" />
          </Field>
        </div>
        {workspaces.length > 0 && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Use</span>
            <SelectField
              name="charge"
              defaultValue="mine"
              className={SELECT}
              options={[
                { value: "mine", label: "Your invites" },
                ...workspaces
                  .filter((workspace) => workspace.allowance.remaining !== 0)
                  .map((workspace) => ({ value: workspace.slug, label: `${workspace.slug}'s invites` })),
              ]}
            />
          </label>
        )}
        <SubmitButton match={{ intent: "create-invite" }} pending="Creating…">
          Create invite
        </SubmitButton>
      </div>
      <p className="text-xs text-faint">With an email, the invite is sent there and only that address can use it.</p>

      {bringInto.options.length > 0 && (
        <div className="space-y-3 rounded-md border border-line p-3">
          <CheckboxOption
            name="also_join"
            checked={alsoJoin}
            onCheckedChange={(checked) => setAlsoJoin(checked === true)}
            label={G1T_INVITES.alsoJoin}
            description={G1T_INVITES.alsoJoinHint}
          />
          {alsoJoin && (
            <div className="flex flex-col gap-3 pl-6 sm:flex-row sm:items-end">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-muted">Workspace</span>
                <SelectField
                  name="join"
                  required
                  placeholder="Choose a workspace"
                  className={SELECT}
                  options={bringInto.options.map((workspace) => ({
                    value: workspace.slug,
                    label: workspace.name === workspace.slug ? workspace.slug : `${workspace.name} (${workspace.slug})`,
                  }))}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-muted">Role</span>
                <SelectField
                  name="join_role"
                  defaultValue="member"
                  className={SELECT}
                  options={[
                    { value: "member", label: "Member" },
                    { value: "owner", label: "Owner" },
                  ]}
                />
              </label>
            </div>
          )}
          {alsoJoin && bringInto.note && <p className="pl-6 text-xs text-faint">{bringInto.note}</p>}
        </div>
      )}
    </Form>
  );
}

/**
 * Settings → Invites (`/settings/invites`): invites to g1t. Each lets one
 * person make an account and adds them to no workspace, unless "Also
 * invite them to a workspace" is ticked. They exist only while sign-up
 * takes an invite; once anyone can sign up, the page keeps only the list
 * of invites already made. An invitation to a workspace is made on its
 * People page, which this page points to.
 */
export function InvitesSection({
  overview,
  created,
  error,
  origin = "https://g1t.sh",
  bringInto = { options: [], note: null, people: [] },
}: {
  overview: InvitesOverview | null;
  /** The workspaces an invite can also invite its person to, and the People pages (lib/invites.server.ts). */
  bringInto?: BringIntoChoices;
  created?: Invite;
  error?: string;
  origin?: string;
}) {
  if (!overview) {
    return (
      <section id="invites" className="scroll-mt-20">
        <p className="text-sm text-muted">Confirm your email address to invite people to g1t.</p>
      </section>
    );
  }
  const { allowance, workspaces, invites } = overview;
  const shows = invitesPage(overview.mode, invites.length);
  const out = allowance.remaining === 0 && workspaces.every((workspace) => workspace.allowance.remaining === 0);
  return (
    <section id="invites" className="scroll-mt-20">
      {shows.form ? (
        <>
          <p className="text-sm text-muted">A revoked or expired invite that was never used comes back to you.</p>
          <p className="mt-3 text-sm">
            <span className="font-medium">{remainingLine(allowance)}</span>
            {workspaces.map((workspace) => (
              <span key={workspace.slug} className="text-muted">
                {" "}· {workspace.slug} has {workspace.allowance.remaining ?? "unlimited"} to share
              </span>
            ))}
          </p>

          {created?.code && (
            <div className="mt-4 rounded-md border border-accent/40 bg-surface p-4">
              <p className="text-sm">
                {created.email ? `Invite sent to ${created.email}. ` : ""}Share this link; it works once
                {created.email ? ", for that address only" : ""}.
              </p>
              <div className="mt-2">
                <CopyLine text={inviteLink(created.code, origin)} />
              </div>
            </div>
          )}

          {out ? (
            <div className="mt-4 flex items-start gap-3 rounded-md border border-line bg-surface p-4 text-sm">
              <Mail size={16} className="mt-0.5 shrink-0 text-muted" />
              <p>
                Need more invites?{" "}
                <a href={moreInvitesMailto()} className="text-accent underline underline-offset-4">
                  Contact us
                </a>{" "}
                and say who you would like to bring, or ask on the{" "}
                <Link to="/support" className="underline underline-offset-4">
                  support page
                </Link>
                .
              </p>
            </div>
          ) : (
            // Empty again once the invite is made; kept as filled in when it failed.
            <InviteForm key={created?.id ?? ""} overview={overview} bringInto={bringInto} />
          )}
          <div className="mt-2">
            <ErrorText>{error}</ErrorText>
          </div>
          <Elsewhere people={bringInto.people} />
        </>
      ) : (
        <p className="text-sm text-muted">{G1T_INVITES.open}</p>
      )}

      {invites.length > 0 && (
        <>
          {!shows.form && <h2 className="mt-6 text-sm font-medium">Invites you made</h2>}
          <ul className="mt-4 divide-y divide-line rounded-md border border-line">
            {invites.map((invite) => (
              <InviteRow key={invite.id} invite={invite} origin={origin} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
