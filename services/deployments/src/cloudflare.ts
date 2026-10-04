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

const HTML_HANDLING = ["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"];
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
  ): Promise<void> {
    const form = new FormData();
    const modules = worker.modules?.length ? worker.modules : null;
    const assetsBinding = worker.assetsBinding || "ASSETS";
    const bindings: object[] = Object.entries(worker.vars ?? {}).map(([name, value]) =>
      typeof value === "string"
        ? { type: "plain_text", name, text: value }
        : { type: "json", name, json: value },
    );
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

  /** Takes an app down. Already gone is fine. */
  async deleteScript(script: string): Promise<void> {
    try {
      await this.call("DELETE", `${this.scriptPath(script)}?force=true`);
    } catch (error) {
      if (!/404|not found|10007/i.test(String(error))) throw error;
    }
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
