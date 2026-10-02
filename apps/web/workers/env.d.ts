import type { EventsApi, IdentityApi, ReposApi, WorkApi } from "@g1t/contracts";

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: IdentityApi;
      /** Also serves git over HTTPS through `fetch`. */
      REPOS: ReposApi & { fetch(request: Request): Promise<Response> };
      WORK: WorkApi;
      EVENTS: EventsApi;
    }
  }
  interface Env extends Cloudflare.Env {}
}
