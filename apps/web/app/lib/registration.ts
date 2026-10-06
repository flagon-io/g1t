import { useRouteLoaderData } from "react-router";

import { signUpCopy } from "./invites";

/**
 * Whether g1t.sh is invite-only, from the root loader. Invite-only when the
 * root loader has not answered: no page should offer an open sign-up that
 * is not there.
 */
export function useInviteOnly(): boolean {
  const root = useRouteLoaderData("root") as { inviteOnly?: boolean } | undefined;
  return root?.inviteOnly ?? true;
}

/** What the sign-up buttons say on this page. */
export function useSignUpCopy() {
  return signUpCopy(useInviteOnly());
}
