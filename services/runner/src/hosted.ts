/**
 * Who may use g1t's hosted models. Pure, so it is tested on its own.
 *
 * While billing takes no real money (no card processor, or one with a test
 * key), a card check proves nothing: test cards pass it. So until billing
 * is live, hosted models are open only to the workspaces g1t lists
 * (`HOSTED_AGENT_WORKSPACES`), and no trial opens them; every other
 * workspace uses its own model provider. Once billing is live they are open
 * to every workspace, paid from its trial credit or its account.
 */

/** The workspaces `HOSTED_AGENT_WORKSPACES` names, lowercased; `*` is every one. */
export function listedWorkspaces(setting: string): string[] {
  return setting
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether g1t's hosted models are open to `namespace`. */
export function hostedOpen(namespace: string, setting: string, billing: { enabled: boolean; live: boolean }): boolean {
  if (billing.enabled && billing.live) return true;
  const listed = listedWorkspaces(setting);
  return listed.includes("*") || listed.includes(namespace.toLowerCase());
}
