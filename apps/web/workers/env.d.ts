import type { RunnerApi, ServiceBinding } from "@g1t/contracts";

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: ServiceBinding;
      /** Also serves git over HTTPS through `fetch`. */
      REPOS: ServiceBinding & { fetch(request: Request): Promise<Response> };
      WORK: ServiceBinding;
      RUNNER: RunnerApi;
      BILLING: ServiceBinding;
      EVENTS: ServiceBinding;
      INTEGRATIONS: ServiceBinding;
      WEBHOOKS: ServiceBinding;
      ACTIONS: ServiceBinding;
      BLOBS: KVNamespace;
    }
  }
  interface Env extends Cloudflare.Env {}
}
