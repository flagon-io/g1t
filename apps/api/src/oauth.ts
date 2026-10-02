import { Hono } from "hono";

import {
  type IdentityApi,
  decodeOAuthClient,
  encodeOAuthClient,
} from "@g1t/contracts";

/**
 * The OAuth 2.1 endpoints an application calls directly. The page where a
 * person approves is on the site, at g1t.sh/oauth/authorize.
 *
 * Applications sign people in with the authorization code flow and PKCE.
 * They are public clients: none holds a secret.
 */
const ISSUER = "https://api.g1t.sh";
const MCP_RESOURCE = "https://mcp.g1t.sh";

/** Authorization server metadata (RFC 8414). */
const SERVER_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: "https://g1t.sh/oauth/authorize",
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  service_documentation: "https://docs.g1t.sh/guides/authentication/",
};

/** What an MCP client is told when it must sign in first (RFC 9728). */
export const MCP_CHALLENGE = `Bearer resource_metadata="${MCP_RESOURCE}/.well-known/oauth-protected-resource"`;

type Fields = Record<string, unknown>;

function oauthError(error: string, description: string, status: 400 | 401 = 400) {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** The request body as fields, whether sent as a form or as JSON. */
async function fields(request: Request): Promise<Fields> {
  try {
    if (request.headers.get("content-type")?.includes("json")) return await request.json();
    return Object.fromEntries(await request.formData());
  } catch {
    return {};
  }
}

export const oauth = new Hono<{ Variables: { services: { IDENTITY: IdentityApi } } }>();

oauth.get("/.well-known/oauth-authorization-server", (c) => c.json(SERVER_METADATA));

// Served for the MCP server, with or without its path appended.
oauth.get("/.well-known/oauth-protected-resource/*", protectedResource);
oauth.get("/.well-known/oauth-protected-resource", protectedResource);

function protectedResource() {
  return Response.json({
    resource: MCP_RESOURCE,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://docs.g1t.sh/guides/bring-your-own-agent/",
  });
}

// Dynamic client registration (RFC 7591). Nothing is stored: the client id
// returned is the registration itself, encoded.
oauth.post("/oauth/register", async (c) => {
  const body = await fields(c.req.raw);
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  const name = typeof body.client_name === "string" ? body.client_name : "";
  const clientId = encodeOAuthClient({ name, redirectUris });
  if (!clientId) {
    return oauthError(
      "invalid_redirect_uri",
      "Give one to five redirect_uris: https addresses, http on localhost, or the application's own scheme.",
    );
  }
  const client = decodeOAuthClient(clientId)!;
  return c.json(
    {
      client_id: clientId,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
});

oauth.post("/oauth/token", async (c) => {
  const body = await fields(c.req.raw);
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
  const identity = c.get("services").IDENTITY;

  let result;
  switch (text("grant_type")) {
    case "authorization_code":
      if (!text("code") || !text("code_verifier") || !text("client_id")) {
        return oauthError("invalid_request", "code, code_verifier and client_id are required.");
      }
      result = await identity.oauthExchange(
        text("code"),
        text("code_verifier"),
        text("client_id"),
        text("redirect_uri"),
      );
      break;
    case "refresh_token":
      if (!text("refresh_token") || !text("client_id")) {
        return oauthError("invalid_request", "refresh_token and client_id are required.");
      }
      result = await identity.oauthRefresh(text("refresh_token"), text("client_id"));
      break;
    default:
      return oauthError(
        "unsupported_grant_type",
        "grant_type must be authorization_code or refresh_token.",
      );
  }
  if (!result.ok) return oauthError("invalid_grant", result.error.message);
  return c.json(
    {
      access_token: result.value.accessToken,
      token_type: "Bearer",
      expires_in: result.value.expiresIn,
      refresh_token: result.value.refreshToken,
    },
    200,
    { "cache-control": "no-store" },
  );
});
