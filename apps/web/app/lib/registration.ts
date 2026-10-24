import { useRouteLoaderData } from "react-router";

import { signUpCopy } from "./invites";

/**
 * Whether g1t is in private preview (sign-up takes an invite), from the
 * root loader. Invite-only when the root loader has not answered: no page
 * should offer an open sign-up that is not there.
 */
export function useInviteOnly(): boolean {
  const root = useRouteLoaderData("root") as { inviteOnly?: boolean } | undefined;
  return root?.inviteOnly ?? true;
}

/** What the sign-up buttons say on this page: Sign up, or Request access in private preview. */
export function useSignUpCopy() {
  return signUpCopy(useInviteOnly());
}
