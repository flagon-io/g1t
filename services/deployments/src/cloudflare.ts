/**
 * Cloudflare's API, behind the calls deployments need: open an upload of
 * an app's files, put the app in the dispatch namespace, take it down, and
 * count what each app used.
 *
 * The token is the service's own, scoped to Workers scripts and analytics on
 * g1t's account. It never leaves this Worker: a sandbox only ever gets an
 * upload session's key, which can upload one manifest's files and nothing
 * else.
 */

import { TAIL_CONSUMERS } from "./telemetry";
import { APP_CLASS, APP_WORKER, REGISTRY_HOST, applicationName, applicationRequest, pushLoginRequest, rolloutRequest } from "./containers";
import { redirectScript } from "./redirect";

const API = "https://api.cloudflare.com/client/v4";

export type Manifest = Record<string, { hash: string; size: number }>;

/** A module of a Worker, as the sandbox sends it. */
export type Module = { name: string; contentBase64: string; contentType: string };

/** What the sandbox built: the Worker's code and settings. */
export type BuiltWorker = {
  mainModule?: string;
  modules?: Module[];
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  vars?: Record<string, unknown>;
  assetsBinding?: string | null;
  htmlHandling?: string | null;
  notFoundHandling?: string | null;
  _headers?: string;
  _redirects?: string;
};

/** Serves the site's files, for an app that brings no code of its own. */
const ASSETS_ONLY = `export default { fetch(request, env) { return env.ASSETS.fetch(request); } };\n`;

/** What an app answers between being taken down and being gone. */
const PAUSED = `export default {
  fetch() {
    return new Response("<!doctype html><meta charset=utf-8><meta name=robots content=noindex><title>Paused</title><body style='font:16px system-ui;background:#121214;color:#ececf1;display:grid;place-items:center;min-height:100vh;margin:0;padding:0 16px'><main style='max-width:32rem'><h1>This app is paused</h1><p style='color:#9a9aa6'>The workspace it belongs to reached its usage limit on g1t. It comes back by itself once the workspace is under it again.</p></main>", { status: 402, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" } });
  },
};`;

const TAKEN_DOWN = `export default {
  fetch() {
    return new Response("<!doctype html><meta charset=utf-8><meta name=robots content=noindex><title>Not up</title><body style='font:16px system-ui;background:#121214;color:#ececf1;display:grid;place-items:center;min-height:100vh;margin:0'><main><h1>This app is not up</h1><p style='color:#9a9aa6'>It was taken down. Deploying it again brings it back.</p></main>", { status: 404, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" } });
  },
};
`;

const HTML_HANDLING =["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"];
const NOT_FOUND_HANDLING = ["single-page-application", "404-page", "none"];

export class Cloudflare {
  constructor(
    private readonly token: string,
    private readonly account: string,
    readonly namespace: string,
  ) {}

  private async call<T>(method: string, path: string, body?: BodyInit, contentType?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (contentType) headers["content-type"] = contentType;
    const response = await fetch(`${API}${path}`, { method, headers, body });
    const answer = (await response.json().catch(() => null)) as {
      success?: boolean;
      result?: T;
      errors?: { code: number; message: string }[];
    } | null;
    if (!response.ok || !answer?.success) {
      const why = answer?.errors?.map((error) => `${error.message} (${error.code})`).join("; ");
      throw new Error(`Cloudflare answered ${response.status}: ${why || "no reason given"}`);
    }
    return answer.result as T;
  }

  private scriptPath(script: string): string {
    return `/accounts/${this.account}/workers/dispatch/namespaces/${this.namespace}/scripts/${encodeURIComponent(script)}`;
  }

  /** Where a sandbox sends the files an upload session asks for. */
  get uploadUrl(): string {
    return `${API}/accounts/${this.account}/workers/assets/upload?base64=true`;
  }

  /**
   * Opens an upload of exactly these files. Cloudflare answers with a key
   * that can upload only them, and the files it does not already have, in
   * buckets; with no buckets, the key itself completes the upload.
   */
  async openUpload(script: string, manifest: Manifest): Promise<{ jwt: string; buckets: string[][] }> {
    const result = await this.call<{ jwt: string; buckets?: string[][] }>(
      "POST",
      `${this.scriptPath(script)}/assets-upload-session`,
      JSON.stringify({ manifest }),
      "application/json",
    );
    return { jwt: result.jwt, buckets: result.buckets ?? [] };
  }

  /** Puts an app in the namespace, replacing what was there. */
  async putScript(
    script: string,
    worker: BuiltWorker,
    completionJwt: string | null,
    tags: string[],
    /** The repository's entries for running apps, over the project's own `vars`. */
    runtime: { secrets: Record<string, string>; variables: Record<string, string> } = { secrets: {}, variables: {} },
  ): Promise<void> {
    const form = new FormData();
    const modules = worker.modules?.length ? worker.modules : null;
    const assetsBinding = worker.assetsBinding || "ASSETS";
    const vars: Record<string, unknown> = { ...(worker.vars ?? {}), ...runtime.variables };
    for (const name of Object.keys(runtime.secrets)) delete vars[name];
    const bindings: object[] = Object.entries(vars).map(([name, value]) =>
      typeof value === "string"
        ? { type: "plain_text", name, text: value }
        : { type: "json", name, json: value },
    );
    for (const [name, text] of Object.entries(runtime.secrets)) bindings.push({ type: "secret_text", name, text });
    if (completionJwt) bindings.push({ type: "assets", name: assetsBinding });
    const assetsConfig: Record<string, string> = {};
    if (worker.htmlHandling && HTML_HANDLING.includes(worker.htmlHandling)) {
      assetsConfig.html_handling = worker.htmlHandling;
    }
    if (worker.notFoundHandling && NOT_FOUND_HANDLING.includes(worker.notFoundHandling)) {
      assetsConfig.not_found_handling = worker.notFoundHandling;
    }
    if (worker._headers) assetsConfig._headers = worker._headers;
    if (worker._redirects) assetsConfig._redirects = worker._redirects;
    const mainModule = modules ? worker.mainModule ?? modules[0].name : "index.js";
    form.append(
      "metadata",
      JSON.stringify({
        main_module: mainModule,
        compatibility_date: worker.compatibilityDate ?? "2026-09-26",
        compatibility_flags: worker.compatibilityFlags ?? [],
        bindings,
        tags,
        // Each request it answers, with its logs, goes to observability (src/telemetry.ts).
        tail_consumers: TAIL_CONSUMERS,
        ...(completionJwt ? { assets: { jwt: completionJwt, config: assetsConfig } } : {}),
      }),
    );
    if (modules) {
      for (const module of modules) {
        const bytes = Uint8Array.from(atob(module.contentBase64), (c) => c.charCodeAt(0));
        form.append(module.name, new File([bytes], module.name, { type: module.contentType }));
      }
    } else {
      if (!completionJwt) throw new Error("The build produced neither code nor files to serve.");
      form.append(
        "index.js",
        new File([ASSETS_ONLY], "index.js", { type: "application/javascript+module" }),
      );
    }
    await this.call("PUT", this.scriptPath(script), form);
  }

  // ---- Container apps (containers.ts) ---------------------------------

  /**
   * A login to Cloudflare's registry for this account: push only (never
   * pull, so a build cannot read another app's image), for minutes.
   */
  async registryLogin(permissions: ("push" | "pull")[] = ["push"]): Promise<{ username: string; password: string }> {
    const body = permissions.includes("pull") ? { permissions, expiration_minutes: 5 } : pushLoginRequest();
    const result = await this.call<{ username: string; password?: string }>(
      "POST",
      `/accounts/${this.account}/containers/registries/${REGISTRY_HOST}/credentials`,
      JSON.stringify(body),
      "application/json",
    );
    if (!result.password) throw new Error("Cloudflare's registry gave no password.");
    return { username: result.username, password: result.password };
  }

  /**
   * Whether `repository` holds the image `digest`: asked of the registry
   * itself, with a pull login of g1t's own, through the token exchange
   * registries use (`WWW-Authenticate: Bearer`).
   */
  async hasImage(repository: string, digest: string): Promise<boolean> {
    const login = await this.registryLogin(["pull"]);
    const basic = `Basic ${btoa(`${login.username}:${login.password}`)}`;
    const url = `https://${REGISTRY_HOST}/v2/${repository}/manifests/${digest}`;
    const accept = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json";
    let response = await fetch(url, { method: "HEAD", headers: { authorization: basic, accept } });
    const challenge = response.headers.get("www-authenticate") ?? "";
    if (response.status === 401 && /^bearer /i.test(challenge)) {
      const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      const token = new URL(params.realm);
      if (params.service) token.searchParams.set("service", params.service);
      token.searchParams.set("scope", params.scope ?? `repository:${repository}:pull`);
      const answer = (await (await fetch(token, { headers: { authorization: basic } })).json().catch(() => null)) as {
        token?: string;
        access_token?: string;
      } | null;
      const bearer = answer?.token ?? answer?.access_token;
      if (!bearer) return false;
      response = await fetch(url, { method: "HEAD", headers: { authorization: `Bearer ${bearer}`, accept } });
    }
    return response.ok;
  }

  /** Puts a container app's Worker (`APP_WORKER`, g1t's own) in the namespace, with `metadata`. */
  async putContainerWorker(script: string, metadata: Record<string, unknown>): Promise<void> {
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    form.append("index.js", new File([APP_WORKER], "index.js", { type: "application/javascript+module" }));
    await this.call("PUT", this.scriptPath(script), form);
  }

  /** The Durable Object namespace of a container app's Worker: what its Container application is attached to. */
  async appNamespace(script: string): Promise<string> {
    for (let page = 1; page <= 20; page++) {
      const namespaces = await this.call<{ id: string; class: string; script: string; dispatch_namespace?: string }[]>(
        "GET",
        `/accounts/${this.account}/workers/durable_objects/namespaces?per_page=1000&page=${page}`,
      );
      const found = namespaces.find((n) => n.class === APP_CLASS && n.script === script && n.dispatch_namespace === this.namespace);
      if (found) return found.id;
      if (namespaces.length < 1000) break;
    }
    throw new Error(`The app's Durable Object namespace was not found for ${script}.`);
  }

  /** The Container application named `name`, if there is one. */
  async containerApplication(name: string): Promise<{ id: string } | null> {
    const apps = await this.call<{ id: string; name: string }[]>("GET", `/accounts/${this.account}/containers/applications`);
    return apps.find((app) => app.name === name) ?? null;
  }

  /**
   * Runs `image` at `instanceType` for the app `script`: its Container
   * application is made the first time, and rolled out to after.
   */
  async runContainer(script: string, image: string, instanceType: string, description: string): Promise<string> {
    const name = applicationName(script);
    const existing = await this.containerApplication(name);
    if (existing) {
      await this.call(
        "POST",
        `/accounts/${this.account}/containers/applications/${existing.id}/rollouts`,
        JSON.stringify(rolloutRequest(image, instanceType, description)),
        "application/json",
      );
      return existing.id;
    }
    const namespaceId = await this.appNamespace(script);
    const created = await this.call<{ id: string }>(
      "POST",
      `/accounts/${this.account}/containers/applications`,
      JSON.stringify(applicationRequest(name, image, instanceType, namespaceId)),
      "application/json",
    );
    return created.id;
  }

  /** Deletes the app's Container application, and its instances with it. Already gone is fine. */
  async deleteContainer(script: string, id?: string | null): Promise<void> {
    const found = id ? { id } : await this.containerApplication(applicationName(script)).catch(() => null);
    if (!found) return;
    try {
      await this.call("DELETE", `/accounts/${this.account}/containers/applications/${found.id}`);
    } catch (error) {
      if (!/404|not found/i.test(String(error))) throw error;
    }
  }

  /** Every app in the namespace, with when it was last changed. */
  async listScripts(): Promise<{ id: string; modified_on: string }[]> {
    return this.call<{ id: string; modified_on: string }[]>(
      "GET",
      `/accounts/${this.account}/workers/dispatch/namespaces/${this.namespace}/scripts`,
    );
  }

  /**
   * Takes an app down. Already gone is fine.
   *
   * A deleted app can keep answering for a while where Cloudflare still has
   * it warm. So it is first replaced by a notice that it is down, which
   * reaches the edge as fast as any deploy, and deleted after.
   */
  async deleteScript(script: string): Promise<void> {
    await this.placeholder(script, TAKEN_DOWN, "taken-down").catch(() => undefined);
    try {
      await this.call("DELETE", `${this.scriptPath(script)}?force=true`);
    } catch (error) {
      if (!/404|not found|10007/i.test(String(error))) throw error;
    }
  }

  /**
   * Replaces an app with a notice that it is paused: its workspace reached
   * its limit. The notice costs next to nothing to answer with, and the app
   * comes back by being deployed again.
   */
  async pauseScript(script: string): Promise<void> {
    await this.placeholder(script, PAUSED, "paused");
  }

  /**
   * Replaces an app with a redirect to `targetHost`, path and query kept:
   * what an app's old address answers after its workspace is renamed.
   */
  async redirectScript(script: string, targetHost: string): Promise<void> {
    await this.placeholder(script, redirectScript(targetHost), "redirect");
  }

  private async placeholder(script: string, code: string, tag: string): Promise<void> {
    const form = new FormData();
    form.append(
      "metadata",
      JSON.stringify({ main_module: "index.js", compatibility_date: "2026-09-26", bindings: [], tags: [tag] }),
    );
    form.append("index.js", new File([code], "index.js", { type: "application/javascript+module" }));
    await this.call("PUT", this.scriptPath(script), form);
  }

  /**
   * Requests and CPU time per app over a period, from Workers analytics.
   * Apps with no traffic are absent.
   */
  async usage(
    scripts: string[],
    since: string,
    until: string,
  ): Promise<Map<string, { requests: number; cpuMs: number }>> {
    const totals = new Map<string, { requests: number; cpuMs: number }>();
    if (scripts.length === 0) return totals;
    const query = (withCpu: boolean) => `query ($account: string!, $since: Time!, $until: Time!, $scripts: [string!]) {
      viewer { accounts(filter: { accountTag: $account }) {
        workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until, scriptName_in: $scripts }) {
          sum { requests${withCpu ? " cpuTimeUs" : ""} }
          dimensions { scriptName }
        }
      } }
    }`;
    type Row = { sum: { requests: number; cpuTimeUs?: number }; dimensions: { scriptName: string } };
    const ask = async (withCpu: boolean) => {
      const response = await fetch(`${API}/graphql`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          query: query(withCpu),
          variables: { account: this.account, since, until, scripts },
        }),
      });
      return (await response.json()) as {
        data?: { viewer: { accounts: { workersInvocationsAdaptive: Row[] }[] } };
        errors?: { message: string }[] | null;
      };
    };
    let answer = await ask(true);
    // CPU time is counted where analytics offers it; requests always.
    if (answer.errors?.length) answer = await ask(false);
    if (answer.errors?.length || !answer.data) {
      throw new Error(`Workers analytics refused: ${answer.errors?.map((e) => e.message).join("; ")}`);
    }
    for (const row of answer.data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []) {
      const seen = totals.get(row.dimensions.scriptName) ?? { requests: 0, cpuMs: 0 };
      seen.requests += row.sum.requests;
      seen.cpuMs += Math.ceil((row.sum.cpuTimeUs ?? 0) / 1000);
      totals.set(row.dimensions.scriptName, seen);
    }
    return totals;
  }
}
