/**
 * The dispatcher for g1t.page: every app deployed by g1t is served here.
 *
 * The hostname's first label is the app's script name in the Workers for
 * Platforms namespace (`web-git-fix-login-acme.g1t.page` is the fix-login
 * branch's preview of acme's web project), so a request needs no lookup:
 * the app is fetched by name and runs only for as long as it answers. An app no one visits
 * runs nothing and costs nothing.
 *
 * Kept apart from g1t.sh, so apps share no cookies or origin with the site
 * people sign in to.
 */

type Env = {
  APPS: DispatchNamespace;
};

const DOMAIN = "g1t.page";

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · g1t.page</title>
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
<body><main><h1>${title}</h1>${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = new URL(request.url).hostname.toLowerCase();
    if (host === DOMAIN) {
      return page(
        200,
        "g1t.page",
        `<p>Apps deployed by <a href="https://g1t.sh">g1t</a>: every pull request's preview, and each repository's production.</p>
         <p><a href="https://docs.g1t.sh/guides/deployments/">How deployments work</a></p>`,
      );
    }
    const label = host.endsWith(`.${DOMAIN}`) ? host.slice(0, -DOMAIN.length - 1) : "";
    if (!/^[a-z0-9-]{1,63}$/.test(label)) {
      return page(404, "Nothing here", "<p>This is not the address of an app on g1t.page.</p>");
    }
    let app: Fetcher;
    try {
      app = env.APPS.get(label);
    } catch {
      return missing(label);
    }
    let response: Response;
    try {
      response = await app.fetch(request);
    } catch (error) {
      if (/worker not found|script not found|does not exist/i.test(String(error))) return missing(label);
      return page(
        502,
        "The app failed",
        `<p>The app at <code>${escape(host)}</code> threw an error before it could answer.</p>`,
      );
    }
    // Previews are for the people reviewing a change, not search engines.
    if (isPreview(label)) {
      response = new Response(response.body, response);
      response.headers.set("x-robots-tag", "noindex");
    }
    return response;
  },
} satisfies ExportedHandler<Env>;

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
