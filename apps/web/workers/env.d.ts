import type { EventsApi, RunnerApi, ServiceBinding } from "@g1t/contracts";

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: ServiceBinding;
      /** Also serves git over HTTPS through `fetch`. */
      REPOS: ServiceBinding & { fetch(request: Request): Promise<Response> };
      WORK: ServiceBinding;
      EVENTS: EventsApi;
      RUNNER: RunnerApi;
    }
  }
  interface Env extends Cloudflare.Env {}
}
