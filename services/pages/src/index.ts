/**
 * The dispatcher for g1t.page: every app deployed by g1t is served here.
 *
 * The hostname's first label is the app's script name in the Workers for
 * Platforms namespace (`web-git-fix-login-acme.g1t.page` is the fix-login
 * branch's preview of acme's web project), so the app is fetched by name
 * and runs only for as long as it answers. An app no one visits runs
 * nothing and costs nothing. The one lookup is for an address an app
 * had before its project moved: `DOMAINS` holds a redirect under the old
 * hostname for as long as the old name is held, and it is followed before
 * anything the old script would answer (such as a paused notice).
 *
 * Any other hostname is a project's custom domain, reaching here through
 * Cloudflare for SaaS: the `DOMAINS` KV namespace, written by the
 * deployments service, names its app, or the hostname it redirects to.
 *
 * Kept apart from g1t.sh, so apps share no cookies or origin with the site
 * people sign in to.
 */

import { DOMAIN, FALLBACK, parseEntry, redirectTo, route, type DomainEntry } from "./route.ts";

type Env = {
  APPS: DispatchNamespace;
  /** Custom hostname, or an app's old g1t.page hostname, to `{ script, redirect }`. */
  DOMAINS?: KVNamespace;
};

/** How long a custom hostname's entry is kept in this isolate and at the edge. */
const ENTRY_TTL_MS = 60 * 1000;
const entries = new Map<string, { at: number; entry: DomainEntry | null }>();

function page(status: number, title: string, body: string, site = DOMAIN): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} · ${escape(site)}</title>
<style>
  :root { color-scheme: dark; --bg: #121214; --fg: #ececf1; --muted: #9a9aa6; --accent: #b4a7f5; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 0 16px; }
  main { max-width: 32rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; letter-spacing: -.01em; }
  p { color: var(--muted); margin: .5rem 0; }
  a { color: var(--accent); }
  code { font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); }
</style>
</head>
<body><main><h1>${escape(title)}</h1>${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" },
  });
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A custom hostname's entry: from this isolate, else KV (cached at the edge too). */
async function lookup(env: Env, hostname: string): Promise<DomainEntry | null> {
  const cached = entries.get(hostname);
  if (cached && Date.now() - cached.at < ENTRY_TTL_MS) return cached.entry;
  const value = env.DOMAINS ? await env.DOMAINS.get(hostname, { type: "json", cacheTtl: ENTRY_TTL_MS / 1000 }) : null;
  const entry = parseEntry(value);
  entries.set(hostname, { at: Date.now(), entry });
  if (entries.size > 5000) entries.delete(entries.keys().next().value!);
  return entry;
}

/** Runs the app `script` for the request; `shown` is the address named in its error pages. */
async function dispatch(env: Env, request: Request, script: string, shown: string, missing: () => Response): Promise<Response> {
  let app: Fetcher;
  try {
    app = env.APPS.get(script);
  } catch {
    return missing();
  }
  try {
    return await app.fetch(request);
  } catch (error) {
    if (/worker not found|script not found|does not exist/i.test(String(error))) return missing();
    return page(
      502,
      "The app failed",
      `<p>The app at <code>${escape(shown)}</code> threw an error before it could answer.</p>`,
      shown,
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = new URL(request.url).hostname;
    const where = route(host);
    switch (where.kind) {
      case "home":
        return page(
          200,
          "g1t.page",
          `<p>Apps deployed by <a href="https://g1t.sh">g1t</a>: every pull request's preview, and each repository's production.</p>
           <p><a href="https://docs.g1t.sh/guides/deployments/">How deployments work</a></p>`,
        );
      case "fallback":
        return page(
          200,
          "Custom domains on g1t",
          `<p>Point a custom domain here, with a CNAME to <code>${FALLBACK}</code>, to serve a project's production on it. Add the domain first, under the project's Settings, Deployments, on g1t.</p>
           <p><a href="https://docs.g1t.sh/guides/deployments/#custom-domains">How custom domains work</a></p>`,
        );
      case "invalid":
        return page(404, "Nothing here", "<p>This is not the address of an app on g1t.page.</p>");
      case "custom":
        return custom(request, env, where.hostname);
      case "app": {
        const label = where.label;
        // An address the app had before its project moved (its workspace or
        // repository was renamed or transferred) redirects to where it is
        // now, whatever the app it named answers, paused or not.
        const moved = await appRedirect(request, env, label);
        if (moved) return moved;
        let response = await dispatch(env, request, label, `${label}.${DOMAIN}`, () => missing(label));
        // Previews are for the people reviewing a change, not search engines.
        if (isPreview(label)) {
          response = new Response(response.body, response);
          response.headers.set("x-robots-tag", "noindex");
        }
        return response;
      }
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * The redirect for an app's old address, if the deployments service left
 * one (in `DOMAINS`, under the old hostname, as `{ script, redirect }`),
 * else null. A lookup that fails serves the app as it is rather than an
 * error.
 */
async function appRedirect(request: Request, env: Env, label: string): Promise<Response | null> {
  const hostname = `${label}.${DOMAIN}`;
  let entry: DomainEntry | null;
  try {
    entry = await lookup(env, hostname);
  } catch (error) {
    console.error("could not read redirect", label, error);
    return null;
  }
  if (!entry?.redirect || entry.redirect === hostname) return null;
  return new Response(null, {
    status: 301,
    headers: {
      location: redirectTo(request.url, entry.redirect),
      "x-robots-tag": "noindex",
      "cache-control": "public, max-age=3600",
    },
  });
}

/** A custom domain: its app, or a 308 to the hostname it is paired with. */
async function custom(request: Request, env: Env, hostname: string): Promise<Response> {
  let entry: DomainEntry | null;
  try {
    entry = await lookup(env, hostname);
  } catch (error) {
    console.error("could not read domain", hostname, error);
    return page(503, "Try again in a moment", `<p><code>${escape(hostname)}</code> could not be looked up just now.</p>`, hostname);
  }
  if (!entry) {
    return page(
      404,
      "This domain is not set up",
      `<p><code>${escape(hostname)}</code> points at g1t, but no project serves it. Its owner adds it under the project's Settings, Deployments, on <a href="https://g1t.sh">g1t</a>.</p>`,
      hostname,
    );
  }
  if (entry.redirect && entry.redirect !== hostname) {
    return new Response(null, {
      status: 308,
      headers: { location: redirectTo(request.url, entry.redirect), "cache-control": "public, max-age=300" },
    });
  }
  return dispatch(env, request, entry.script, hostname, () =>
    page(
      404,
      "Nothing deployed here yet",
      `<p><code>${escape(hostname)}</code> serves a project's production, and it is not up. Deploying the project brings it here.</p>`,
      hostname,
    ),
  );
}

/** A branch's preview: `<project>-git-<branch>-<workspace>`. */
function isPreview(label: string): boolean {
  return label.includes("-git-");
}

function missing(label: string): Response {
  const preview = isPreview(label);
  return page(
    404,
    preview ? "This preview is not up" : "Nothing deployed here",
    preview
      ? `<p>A preview comes down when its pull request is closed or merged, or after its project's idle days without a visit. Pushing to the branch, or redeploying it from the project's Deployments page, brings it back.</p>`
      : `<p>No app is deployed at <code>${escape(label)}.${DOMAIN}</code>. Deployments are turned on per project, from its Settings on g1t.</p>`,
  );
}
