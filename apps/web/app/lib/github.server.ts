import { env } from "cloudflare:workers";

import { githubAppClient, githubSignInClient } from "@g1t/contracts";

/** Signing in with GitHub, kept by the identity service. */
export const githubSignIn = githubSignInClient(env.IDENTITY);
/** g1t's GitHub App: installations, imports and mirrors, kept by integrations. */
export const githubApp = githubAppClient(env.INTEGRATIONS);

/**
 * Whether this g1t offers signing in with GitHub. False when no app is
 * configured, or identity cannot say: the button is then left out.
 */
export async function githubSignInEnabled(): Promise<boolean> {
  return githubSignIn.enabled().catch(() => false);
}

/** Where GitHub returns after sign-in: registered on the app, exactly. */
export function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/auth/github/callback`;
}
