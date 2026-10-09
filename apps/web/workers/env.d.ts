import type { RateLimitBinding, RunnerApi, ServiceBinding } from "@g1t/contracts";

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: ServiceBinding;
      /** Also serves git over HTTPS through `fetch`. */
      REPOS: ServiceBinding & { fetch(request: Request): Promise<Response> };
      /** Also serves the container registry (`/v2/`) through `fetch`. */
      PACKAGES: ServiceBinding & { fetch(request: Request): Promise<Response> };
      WORK: ServiceBinding;
      RUNNER: RunnerApi;
      BILLING: ServiceBinding;
      EVENTS: ServiceBinding;
      INTEGRATIONS: ServiceBinding;
      WEBHOOKS: ServiceBinding;
      ACTIONS: ServiceBinding;
      DEPLOYMENTS: ServiceBinding;
      PROJECTS: ServiceBinding;
      SECURITY: ServiceBinding;
      /** The context hub: catalog, search and scorecards. */
      CONTEXT: ServiceBinding;
      /** Search across all of g1t, and Explore. */
      SEARCH: ServiceBinding;
      /**
       * Chat: channels, messages and read state over RPC, and the live
       * socket, forwarded as it is (app/lib/chat-live.server.ts).
       */
      CHAT: ServiceBinding & { fetch(request: Request): Promise<Response> };
      /** Docs (services/docs): RPC, each page's live socket, and files in pages. */
      DOCS: ServiceBinding & { fetch(request: Request | string, init?: RequestInit): Promise<Response> };
      /** The workspace's own agents: definitions, templates and desks. */
      AGENTS: ServiceBinding;
      /**
       * Live notifications, counts and browser push (services/notify): RPC,
       * and each tab's feed socket, forwarded as it is (routes/notify/live.ts).
       * Absent where it is not deployed: pages work without it.
       */
      NOTIFY?: ServiceBinding & { fetch(request: Request): Promise<Response> };
      /** Production screenshots, from the og service's `Screenshots` entrypoint. */
      SCREENSHOTS?: {
        image(input: { host: string; commit: string; since?: string }): Promise<{
          body: ArrayBuffer;
          contentType: string;
          commit: string;
          capturedAt: string;
        } | null>;
      };
      BLOBS: KVNamespace;
      /** Uploaded avatars by SHA-256, with `{ contentType }`; written by identity. */
      AVATARS: KVNamespace;
      /** The self-hosted runner's releases (scripts/runner-release.mjs). Absent when self-hosted. */
      DOWNLOADS?: R2Bucket;
      /** The site's own origin. Unset on g1t.sh, which is https://g1t.sh (app/lib/addresses.server.ts). */
      SITE_URL?: string;
      /** The REST API's origin, which is also the OAuth issuer. Unset on g1t.sh. */
      API_URL?: string;
      /** The MCP server's URL, as agents are told to add it. Unset on g1t.sh. */
      MCP_URL?: string;
      /** The social-card image service; an empty string for none. Unset on g1t.sh. */
      OG_URL?: string;
      /** The front door's rate limits (app/lib/front-door-limits.ts). Absent when self-hosted. */
      WEB_ANONYMOUS_LIMIT?: RateLimitBinding;
      WEB_HEAVY_LIMIT?: RateLimitBinding;
      WEB_SESSION_LIMIT?: RateLimitBinding;
      WEB_ADDRESS_LIMIT?: RateLimitBinding;
      GIT_ANONYMOUS_LIMIT?: RateLimitBinding;
      GIT_SIGNED_LIMIT?: RateLimitBinding;
      /**
       * Where repository files and avatars are served (app/lib/usercontent.ts).
       * Unset on g1t.sh, which is https://g1tusercontent.com; unset on another
       * site, `<SITE_URL>/-/usercontent`.
       */
      USERCONTENT_URL?: string;
      /** Signs the short-lived addresses of private repositories' files. A secret. */
      USERCONTENT_KEY?: string;
    }
  }
  interface Env extends Cloudflare.Env {}
}
