/**
 * Single sign-on: a workspace's own identity provider, over OpenID
 * Connect, OAuth 2.0 or SAML 2.0, on every paid plan. Mirrors
 * `crates/contracts/src/sso.rs`, which says how it works: it never signs
 * anyone in to g1t; a person signed in to g1t proves themselves to the
 * workspace's provider to use the workspace.
 */
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";
import type { Result } from "./result";

export type SsoProtocol = "oidc" | "oauth2" | "saml";

/** What a connection needs, by protocol; it holds no secret. */
export type SsoConfig = {
  issuer?: string | null;
  client_id?: string | null;
  scopes?: string | null;
  authorization_url?: string | null;
  token_url?: string | null;
  userinfo_url?: string | null;
  subject_claim?: string | null;
  email_claim?: string | null;
  idp_entity_id?: string | null;
  idp_sso_url?: string | null;
  certificates?: string[];
};

export type SsoConnection = {
  id: string;
  protocol: SsoProtocol;
  config: SsoConfig;
  has_client_secret: boolean;
  /** SAML's signing certificates, by SHA-256 fingerprint. */
  certificates: { fingerprint: string }[];
  allow_join: boolean;
  tested_at: string | null;
  /** The username of whoever first signed in through it. */
  tested_by: string | null;
  created_at: string;
  updated_at: string;
};

export type SsoIdentity = {
  username: string;
  display_username?: string | null;
  subject: string;
  email: string | null;
  linked_at: string;
  last_used_at: string;
};

export type SsoSettings = {
  slug: string;
  connection: SsoConnection | null;
  required: boolean;
  /** Whether the owner asking has signed in through it, which requiring it needs. */
  you_linked: boolean;
  identities: SsoIdentity[];
};

export type SsoSummary = {
  enabled: boolean;
  protocol: SsoProtocol | null;
  required: boolean;
  allow_join: boolean;
};

export type SsoFinished = { slug: string; next: string; joined: boolean; first: boolean };

export type SaveSso = {
  protocol: SsoProtocol;
  config: SsoConfig;
  /** Empty keeps the one saved. */
  client_secret?: string | null;
  /** SAML certificates as pasted (PEM); empty keeps the ones saved. */
  certificate?: string | null;
  allow_join: boolean;
};

async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
  return (await response.json()) as T;
}

/** Single sign-on: methods of the identity service. */
export function ssoClient(identity: ServiceBinding) {
  const call = <T>(method: string, args: object) => rpc<T>(identity, method, args);
  return {
    settings: (actor: User, slug: string) => call<Result<SsoSettings>>("sso_settings", { actor, slug }),
    summary: (slug: string) => call<SsoSummary>("sso_summary", { slug }),
    save: (actor: User, slug: string, input: SaveSso) =>
      call<Result<SsoSettings>>("save_sso", { actor, slug, surface: "web", ...input }),
    setRequired: (actor: User, slug: string, required: boolean) =>
      call<Result<boolean>>("set_sso_required", { actor, slug, required, surface: "web" }),
    remove: (actor: User, slug: string) => call<Result<boolean>>("delete_sso", { actor, slug, surface: "web" }),
    unlink: (actor: User, slug: string, username: string) =>
      call<Result<boolean>>("unlink_sso_identity", { actor, slug, username, surface: "web" }),
    start: (input: { user: User; session_token: string; slug: string; redirect_uri: string; entity_id?: string | null; next: string }) =>
      call<Result<{ url: string; state: string | null }>>("sso_start", input),
    finish: (input: { slug: string; session_token: string; state: string; code: string }) =>
      call<Result<SsoFinished>>("sso_finish", input),
    saml: (slug: string, samlResponse: string) => call<Result<SsoFinished>>("sso_saml", { slug, saml_response: samlResponse }),
    metadata: (entityId: string, acsUrl: string) => call<string>("sso_metadata", { entity_id: entityId, acs_url: acsUrl }),
  };
}

/**
 * Where a workspace's provider is pointed, from the site's origin: g1t's
 * entity id (its metadata's address), the assertion consumer service, and
 * the callback for OpenID Connect and OAuth 2.0.
 */
export function ssoAddresses(origin: string, slug: string) {
  const base = `${origin.replace(/\/+$/, "")}/auth/sso/${encodeURIComponent(slug.toLowerCase())}`;
  return { entityId: `${base}/metadata`, metadataUrl: `${base}/metadata`, acsUrl: `${base}/saml`, callbackUrl: `${base}/callback` };
}
