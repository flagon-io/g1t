/**
 * Suspending accounts and workspaces, and blocking email domains: the
 * forms' rules and words. No Workers imports, so it can be tested under
 * Node. Identity checks everything again.
 */

/** The billing hold sudo puts on a suspended workspace, so its compute, deploys, new runners and telemetry stop. */
export const SUSPENSION_HOLD_PREFIX = "Suspended: ";

export function suspensionHold(reason: string): string {
  return `${SUSPENSION_HOLD_PREFIX}${reason.trim()}`;
}

/** Whether a billing hold is one a suspension put there, so lifting the suspension lifts it too. */
export function isSuspensionHold(hold: string | null | undefined): boolean {
  return (hold ?? "").startsWith(SUSPENSION_HOLD_PREFIX);
}

/** The reason a suspension or a block needs: 3 to 500 characters. */
export function parseReason(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const reason = raw.trim().replace(/\s+/g, " ");
  if (reason.length < 3) return { ok: false, error: "Say why. It is kept with it, and in the audit log." };
  if (reason.length > 500) return { ok: false, error: "Keep the reason under 500 characters." };
  return { ok: true, value: reason };
}

/** What a suspension does, for the forms. */
export const SUSPEND_ACCOUNT_ABOUT =
  "A suspended account cannot sign in, with a password or GitHub, and is signed out everywhere at once. Its tokens, SSH keys and git passwords stop working until the suspension is lifted; then they work as before. Nothing is deleted.";
export const SUSPEND_WORKSPACE_ABOUT =
  "A suspended workspace's own tokens stop working, and a hold goes on its compute in billing: no new runs, checks, deploys or self-hosted runners, and its telemetry is not taken. Its members can still sign in and read it. Lifting the suspension lifts the hold. Nothing is deleted.";
