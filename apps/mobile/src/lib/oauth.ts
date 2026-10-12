import { encodeOAuthClient } from "@g1t/contracts/oauth";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import type { Credentials } from "./credentials";
import { OAUTH_CALLBACK_PATH } from "./links";
import type { Server } from "./server";

/**
 * Signing in with g1t's OAuth 2.1, as any public client does
 * (docs.g1t.sh/guides/authentication/#signing-in-with-oauth): the
 * authorization code flow with PKCE (S256), no client secret, and a client
 * id that encodes the app's name and where it is sent back, so nothing is
 * registered first.
 *
 * The person approves on the site, in the system's browser, which keeps
 * their g1t session (and passkeys, password managers, two-factor) out of
 * the app. The site sends them back to `g1t://oauth/callback`.
 *
 * The app appears in Settings → Connected applications as "g1t for
 * Android" or "g1t for iOS", where its access can be narrowed or ended.
 */

// Lets the browser hand its result back when the app was in the background.
WebBrowser.maybeCompleteAuthSession();

/**
 * What the app asks for: what Chat and Code show and do. The
 * person can untick any of these on the approval page. `chat:*` opens
 * Chat's routes and live sockets on the site, and `notifications:*` the
 * phone's registration for pushes (`/-/notify`), and nothing else there.
 */
export const SCOPES = [
  "chat:read",
  "chat:write",
  "account:read",
  "workspace:read",
  "repo:read",
  "code:read",
  "issues:read",
  "issues:write",
  "pull_requests:read",
  "pull_requests:write",
  "checks:read",
  "workflows:read",
  "notifications:read",
  "notifications:write",
  "memory:read",
  "artifacts:read",
];

/** Whether the app is running inside Expo Go, while developing. */
export const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** The name shown on the approval page and in Connected applications. */
const CLIENT_NAME = IN_EXPO_GO ? "g1t in Expo Go" : Platform.OS === "ios" ? "g1t for iOS" : "g1t for Android";

/**
 * Where the site sends the person back: `g1t://oauth/callback` in a build
 * of the app, and Expo Go's own address while developing in it
 * (`exp://192.168.1.20:8081/--/oauth/callback`), which g1t accepts as an
 * application's own scheme. Since the client id encodes it, Go's id
 * changes with the computer's address; credentials keep the id they were
 * issued to, for refreshing.
 */
export function redirectUri(): string {
  return AuthSession.makeRedirectUri({ scheme: "g1t", path: OAUTH_CALLBACK_PATH.slice(1) });
}

export function clientId(redirect: string): string {
  const id = encodeOAuthClient({ name: CLIENT_NAME, redirectUris: [redirect] });
  if (!id) throw new Error(`g1t does not accept ${redirect} as a place to send you back.`);
  return id;
}

type Metadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
};

/** The server's OAuth metadata (RFC 8414), from its API. */
async function metadata(server: Server): Promise<Metadata> {
  const response = await fetch(`${server.api}/.well-known/oauth-authorization-server`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${server.api} did not say how to sign in (${response.status}).`);
  return (await response.json()) as Metadata;
}

function discovery(meta: Metadata): AuthSession.DiscoveryDocument {
  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    revocationEndpoint: meta.revocation_endpoint,
  };
}

export class SignInCancelled extends Error {
  constructor() {
    super("Sign-in was cancelled.");
  }
}

/**
 * Opens the site's approval page and, once the person approves, trades the
 * code for tokens. Throws {@link SignInCancelled} when they close the page
 * or deny.
 */
export async function signInWithOAuth(server: Server): Promise<Credentials> {
  const meta = await metadata(server);
  const redirect = redirectUri();
  const id = clientId(redirect);
  const request = new AuthSession.AuthRequest({
    clientId: id,
    redirectUri: redirect,
    scopes: SCOPES,
    usePKCE: true,
    codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
  });
  const result = await request.promptAsync(discovery(meta));
  if (result.type === "cancel" || result.type === "dismiss") throw new SignInCancelled();
  if (result.type !== "success") {
    const denied = result.type === "error" && result.params.error === "access_denied";
    if (denied) throw new SignInCancelled();
    throw new Error(result.type === "error" ? (result.params.error_description ?? result.params.error ?? "Sign-in failed.") : "Sign-in failed.");
  }
  // RFC 9207: the code must come from the server the app asked.
  if (result.params.iss && result.params.iss.replace(/\/$/, "") !== meta.issuer.replace(/\/$/, "")) {
    throw new Error("The sign-in came back from a different server than the one asked. Try again.");
  }
  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId: id,
      code: result.params.code,
      redirectUri: redirect,
      extraParams: { code_verifier: request.codeVerifier ?? "" },
    },
    discovery(meta),
  );
  return fromTokenResponse(tokens, id);
}

function fromTokenResponse(tokens: AuthSession.TokenResponse, clientId: string): Credentials {
  if (!tokens.refreshToken) throw new Error("g1t did not return a refresh token.");
  return {
    kind: "oauth",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: (tokens.issuedAt + (tokens.expiresIn ?? 30 * 24 * 3600)) * 1000,
    scope: tokens.scope ?? "",
    clientId,
  };
}

/** Raised when the refresh token no longer works: the person must sign in again. */
export class SignedOut extends Error {
  constructor(message = "You were signed out. Sign in again.") {
    super(message);
  }
}

/**
 * The next pair of tokens. A refresh token works once: the old access
 * token stops working, so callers share one refresh at a time
 * (lib/client.ts).
 */
export async function refresh(server: Server, credentials: Extract<Credentials, { kind: "oauth" }>): Promise<Credentials> {
  const meta = await metadata(server);
  const id = credentials.clientId ?? clientId(redirectUri());
  try {
    const tokens = await AuthSession.refreshAsync({ clientId: id, refreshToken: credentials.refreshToken }, discovery(meta));
    return fromTokenResponse(tokens, id);
  } catch (error) {
    // invalid_grant: used, expired or revoked in Connected applications.
    if (error instanceof AuthSession.TokenError) throw new SignedOut();
    throw error;
  }
}
