import { Mail } from "lucide-react";
import { Form, Link } from "react-router";

import type { Invite, InvitesOverview } from "@g1t/contracts";

import { CopyLine, ErrorText, Field, Input, SubmitButton, TimeAgo } from "./ui";
import { inviteFor, inviteLink, inviteState, moreInvitesMailto, remainingLine } from "../lib/invites";

const TONE: Record<"pending" | "done" | "dead", string> = {
  pending: "border-accent/40 text-accent",
  done: "border-merged/40 text-merged",
  dead: "border-line text-faint",
};

function InviteRow({ invite, origin }: { invite: Invite; origin: string }) {
  const state = inviteState(invite);
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${TONE[state.tone]}`}>{state.label}</span>
        <span className="min-w-0 truncate text-sm">{inviteFor(invite)}</span>
        {invite.status === "pending" && (
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

/**
 * Settings → Invites (`/settings/invites`): what is left, making one (for anyone with the
 * link, or for one address), copying links, and revoking.
 */
export function InvitesSection({
  overview,
  created,
  error,
  origin = "https://g1t.sh",
}: {
  overview: InvitesOverview | null;
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
  const out = allowance.remaining === 0 && workspaces.every((workspace) => workspace.allowance.remaining === 0);
  return (
    <section id="invites" className="scroll-mt-20">
      <p className="text-sm text-muted">
        {overview.mode === "invite"
          ? "g1t is invite-only for now. Each invite lets one person make an account. "
          : "Anyone can make an account, but an invite still says who sent it. "}
        A revoked or expired invite that was never used comes back to you.
      </p>
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
        <Form method="post" key={created?.id ?? ""} className="mt-4 space-y-3">
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
                <select
                  name="charge"
                  className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none hover:border-line-strong focus:border-accent-dim sm:w-auto"
                >
                  <option value="mine">Your invites</option>
                  {workspaces
                    .filter((workspace) => workspace.allowance.remaining !== 0)
                    .map((workspace) => (
                      <option key={workspace.slug} value={workspace.slug}>
                        {workspace.slug}'s invites
                      </option>
                    ))}
                </select>
              </label>
            )}
            <SubmitButton match={{ intent: "create-invite" }} pending="Creating…">
              Create invite
            </SubmitButton>
          </div>
          <p className="text-xs text-faint">
            With an email, the invite is sent there and only that address can use it.
          </p>
        </Form>
      )}
      <div className="mt-2">
        <ErrorText>{error}</ErrorText>
      </div>

      {invites.length > 0 && (
        <ul className="mt-4 divide-y divide-line rounded-md border border-line">
          {invites.map((invite) => (
            <InviteRow key={invite.id} invite={invite} origin={origin} />
          ))}
        </ul>
      )}
    </section>
  );
}
