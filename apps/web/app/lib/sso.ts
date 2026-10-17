/**
 * The parts of a workspace's single sign-on that the site itself decides:
 * the cookies that bind a trip to the provider to this browser, where to
 * go afterwards, and the one address the Worker answers before React
 * Router (a SAML response, posted from the provider's site).
 */

import { safeNext } from "./next.ts";

/** The OAuth state of a trip to a workspace's provider, for ten minutes. */
export const SSO_STATE_COOKIE = "g1t_sso_state";
/** Why a SAML sign-in did not work, shown once on the page it lands on. */
export const SSO_ERROR_COOKIE = "g1t_sso_error";

/** The workspace a `POST /auth/sso/<slug>/saml` is for, or null. */
export function samlPath(pathname: string): string | null {
  const match = /^\/auth\/sso\/([a-z0-9](?:[a-z0-9-]{0,38}))\/saml\/?$/i.exec(pathname);
  return match ? match[1].toLowerCase() : null;
}

/** Where to go once signed in through a workspace's provider. */
export function afterSso(finished: { slug: string; next: string }): string {
  const next = safeNext(finished.next);
  return next === "/" ? `/${finished.slug}` : next;
}

/** A `Set-Cookie` value carrying `message`, for a minute: Lax, HttpOnly. */
export function errorCookie(message: string): string {
  const value = encodeURIComponent(message.slice(0, 600));
  return `${SSO_ERROR_COOKIE}=${value}; Path=/auth/sso; HttpOnly; Secure; SameSite=Lax; Max-Age=60`;
}

/** Clears that cookie. */
export function clearErrorCookie(): string {
  return `${SSO_ERROR_COOKIE}=; Path=/auth/sso; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** The message in that cookie, or null. */
export function readErrorCookie(header: string | null): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== SSO_ERROR_COOKIE) continue;
    try {
      return decodeURIComponent(rest.join("=")) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** How each protocol is named on the page. */
export const PROTOCOL_NAMES = { oidc: "OpenID Connect", oauth2: "OAuth 2.0", saml: "SAML 2.0" } as const;
