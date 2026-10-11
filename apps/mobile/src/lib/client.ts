import { type Credentials, saveCredentials } from "./credentials";
import { SignedOut, refresh } from "./oauth";
import type { Server } from "./server";

/**
 * Every request the app makes, with its credentials: `api` for the REST
 * API (api.g1t.sh), `site` for the site's own JSON routes, which Chat
 * lives behind (`/<workspace>/-/chat/api`). Both take
 * `Authorization: Bearer g1t_…`.
 *
 * An OAuth access token is refreshed a minute before it expires, and on a
 * 401 once; requests that need a refresh at the same time share it,
 * because a refresh token works once.
 */

export type ErrorCode =
  /** Signed out: the session is over and the app returns to sign-in. */
  | "signed_out"
  /**
   * The site refused the token: an OAuth token, or a personal one without
   * "Use the website as you". The API still works; Chat does not.
   */
  | "website_refused"
  | "not_found"
  | "forbidden"
  | "offline"
  | "failed";

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export type Session = {
  server: Server;
  credentials: Credentials;
  /** Told when credentials change (a refresh) or end (signed out). */
  onCredentials: (next: Credentials | null) => void;
};

const REFRESH_EARLY_MS = 60_000;

export class Client {
  private refreshing: Promise<Credentials> | null = null;

  constructor(private session: Session) {}

  get server(): Server {
    return this.session.server;
  }

  get credentials(): Credentials {
    return this.session.credentials;
  }

  /** A REST API call: `client.api<Repo[]>("/repos")`. */
  api<T>(path: string, init?: RequestInit): Promise<T> {
    return this.json<T>(this.session.server.api + path, init, "api");
  }

  /**
   * One of the site's JSON routes. They answer `{ ok, value }` or
   * `{ ok: false, error }`, the services' own shape, which this unwraps.
   */
  async site<T>(path: string, init?: RequestInit): Promise<T> {
    const answer = await this.json<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>(
      this.session.server.site + path,
      init,
      "site",
    );
    if (!answer.ok) {
      const code: ErrorCode = answer.error.code === "not_found" ? "not_found" : answer.error.code === "forbidden" ? "forbidden" : "failed";
      throw new ApiError(code, answer.error.message);
    }
    return answer.value;
  }

  /** The current access token, refreshed first when it is about to expire. */
  async token(): Promise<string> {
    const credentials = this.session.credentials;
    if (credentials.kind === "oauth" && credentials.expiresAt - REFRESH_EARLY_MS < Date.now()) {
      return (await this.refreshOnce()).accessToken;
    }
    return credentials.accessToken;
  }

  private refreshOnce(): Promise<Credentials> {
    const credentials = this.session.credentials;
    if (credentials.kind !== "oauth") return Promise.resolve(credentials);
    this.refreshing ??= refresh(this.session.server, credentials)
      .then(async (next) => {
        this.session = { ...this.session, credentials: next };
        await saveCredentials(next);
        this.session.onCredentials(next);
        return next;
      })
      .catch((error) => {
        if (error instanceof SignedOut) this.session.onCredentials(null);
        throw error instanceof SignedOut ? new ApiError("signed_out", error.message, 401) : error;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async json<T>(url: string, init: RequestInit | undefined, target: "api" | "site", retried = false): Promise<T> {
    const token = await this.token();
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...init?.headers,
          authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw new ApiError("offline", "Could not reach g1t. Check your connection.");
    }
    if (response.status === 401) {
      // An expired or revoked OAuth token gets one refresh; the site refusing
      // a token it will never take is not that.
      const refusedBySite = target === "site" && (await this.siteRefusesToken(response));
      if (refusedBySite) {
        throw new ApiError(
          "website_refused",
          this.session.credentials.kind === "oauth"
            ? "Chat is not open to the app's sign-in on this g1t yet. Sign in with an access token that can use the website, from You → Sign in another way."
            : "This access token cannot use the website. Turn on “Use the website as you” for it in Settings → Access tokens.",
          401,
        );
      }
      if (!retried && this.session.credentials.kind === "oauth") {
        await this.refreshOnce();
        return this.json<T>(url, init, target, true);
      }
      this.session.onCredentials(null);
      throw new ApiError("signed_out", "You were signed out. Sign in again.", 401);
    }
    if (response.status === 404) throw new ApiError("not_found", "Not found.", 404);
    if (response.status === 403) throw new ApiError("forbidden", await messageOf(response, "You do not have access to this."), 403);
    if (!response.ok) throw new ApiError("failed", await messageOf(response, `g1t answered ${response.status}.`), response.status);
    return (await response.json()) as T;
  }

  /**
   * Whether a 401 from the site is it refusing the token itself (its
   * `WWW-Authenticate` names `invalid_token`; apps/web lib/website-token.ts).
   * The token may still be good for the API: check before signing out.
   */
  private async siteRefusesToken(response: Response): Promise<boolean> {
    if (!/invalid_token/.test(response.headers.get("www-authenticate") ?? "")) return false;
    try {
      const check = await fetch(`${this.session.server.api}/user`, {
        headers: { authorization: `Bearer ${this.session.credentials.accessToken}` },
      });
      return check.ok;
    } catch {
      return false;
    }
  }
}

async function messageOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: string; error?: { message?: string }; error_description?: string };
    return body.message ?? body.error?.message ?? body.error_description ?? fallback;
  } catch {
    const text = await response.text().catch(() => "");
    return text.trim().slice(0, 300) || fallback;
  }
}
