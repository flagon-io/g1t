import { Form } from "react-router";

import type { WorkspaceInvitation } from "@g1t/contracts";

import { ErrorText, SubmitButton } from "./ui";
import { Avatar } from "./ui/avatar";
import { Card } from "./ui/card";
import { UserCard } from "./user-card";
import { invitationLine } from "../lib/invitations";

/**
 * The workspace invitations waiting for the person's answer, each with
 * Accept and Decline. Accepting joins with the role it names; declining
 * tells whoever sent it. `next` is where accepting goes, when not to the
 * workspace itself.
 */
export function InvitationList({
  invitations,
  error,
  errorFor,
  next,
}: {
  invitations: WorkspaceInvitation[];
  error?: string | null;
  errorFor?: string | null;
  next?: string | null;
}) {
  return (
    <Card asChild tone="plain" divided>
      <ul>
        {invitations.map((invitation) => (
          <li key={invitation.id} className="px-4 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <Avatar name={invitation.workspace.slug} image={invitation.workspace.avatar} size={32} square />
              <div className="min-w-0 grow basis-48">
                <p className="text-sm font-medium">
                  {invitation.workspace.name}{" "}
                  <span className="font-mono text-xs font-normal text-faint">{invitation.workspace.slug}</span>
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {invitation.invitedBy ? (
                    <>
                      <UserCard username={invitation.invitedBy.username}>
                        <span className="font-mono text-fg/90">@{invitation.invitedBy.username}</span>
                      </UserCard>{" "}
                    </>
                  ) : (
                    "The g1t team "
                  )}
                  {invitationLine(invitation)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Form method="post">
                  <input type="hidden" name="intent" value="decline-invitation" />
                  <input type="hidden" name="id" value={invitation.id} />
                  <input type="hidden" name="workspace" value={invitation.workspace.name} />
                  <SubmitButton variant="outline" match={{ intent: "decline-invitation", id: invitation.id }} pending="Declining…">
                    Decline
                  </SubmitButton>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="accept-invitation" />
                  <input type="hidden" name="id" value={invitation.id} />
                  {next && <input type="hidden" name="next" value={next} />}
                  <SubmitButton match={{ intent: "accept-invitation", id: invitation.id }} pending="Joining…">
                    Accept
                  </SubmitButton>
                </Form>
              </div>
            </div>
            {errorFor === invitation.id && (
              <div className="mt-2">
                <ErrorText>{error}</ErrorText>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
