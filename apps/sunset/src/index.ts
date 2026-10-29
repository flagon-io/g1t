/**
 * g1t has ended. Through November 30, 2026 this Worker is all of g1t.sh
 * and its other hostnames: it hands `git clone` and `git fetch` to the
 * repos service, refuses pushes, and answers everything else with the
 * statement below. The rest of g1t is no longer deployed.
 */
import { gitLimited } from "../../web/app/lib/front-door-limits";
import { servicePath } from "../../web/app/lib/registry-paths";

type Env = {
  REPOS: Fetcher;
  GIT_ANONYMOUS_LIMIT?: RateLimit;
  GIT_SIGNED_LIMIT?: RateLimit;
};

const LAST_DAY = "November 30, 2026";

const ENDED = `g1t has shut down. Pushes are no longer accepted.
You can still clone and fetch your repositories until ${LAST_DAY}.
After that, g1t and everything on it is deleted.
https://g1t.sh
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "g1t.sh" && servicePath(url.pathname) === "git") {
      if (isPush(url)) return plain(ENDED, 403);
      return (await gitLimited(env, request)) ?? env.REPOS.fetch(new Request(request, { redirect: "manual" }));
    }
    if (url.pathname === "/robots.txt") return plain("User-agent: *\nAllow: /\n", 200);
    if (!wantsPage(request)) {
      // The API, MCP, registries, the CLI's install script and the like.
      return plain(ENDED, 410);
    }
    return new Response(request.method === "HEAD" ? null : PAGE, {
      status: url.pathname === "/" ? 200 : 410,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  },
} satisfies ExportedHandler<Env>;

/** `info/refs?service=git-receive-pack` and the push itself. */
function isPush(url: URL): boolean {
  return url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
}

function wantsPage(request: Request): boolean {
  return (request.method === "GET" || request.method === "HEAD") && (request.headers.get("accept") ?? "").includes("text/html");
}

function plain(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>g1t has shut down</title>
<meta name="description" content="g1t has shut down. Clone your repositories before ${LAST_DAY}.">
<style>
  :root { color-scheme: light dark; --bg: #fafaf9; --fg: #1c1917; --muted: #57534e; --rule: #e7e5e4; --code: #f0efed; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0c0a09; --fg: #f5f5f4; --muted: #a8a29e; --rule: #292524; --code: #1c1917; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 64px 16px 96px; }
  h1 { font-size: 32px; line-height: 1.2; margin: 0 0 24px; letter-spacing: -0.01em; }
  h2 { font-size: 17px; margin: 40px 0 8px; }
  p, ul { margin: 0 0 16px; }
  ul { padding-left: 20px; }
  .muted { color: var(--muted); }
  pre { background: var(--code); padding: 12px 14px; border-radius: 6px; overflow-x: auto; font-size: 14px; line-height: 1.5; margin: 0 0 16px; }
  code { font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 40px 0 24px; }
</style>
</head>
<body>
<main>
<h1>g1t has shut down</h1>
<p>g1t was an experiment: a git platform for teams whose code is written by people and their coding agents together. The experiment is over, and g1t is closing for good.</p>
<p><strong>You can clone your repositories until ${LAST_DAY}.</strong> After that, g1t and everything on it is deleted, and none of it can be recovered.</p>

<h2>Get your code</h2>
<p>Clone over HTTPS, as before:</p>
<pre><code>git clone https://g1t.sh/&lt;workspace&gt;/&lt;repository&gt;.git</code></pre>
<p>To keep every branch and tag and move the repository somewhere else:</p>
<pre><code>git clone --mirror https://g1t.sh/&lt;workspace&gt;/&lt;repository&gt;.git
cd &lt;repository&gt;.git
git push --mirror &lt;your new remote&gt;</code></pre>
<p>For a private repository, use the credentials you already have: a g1t access token as the password, or the sign-in the g1t CLI saved for git. New tokens can no longer be made.</p>

<h2>What has stopped</h2>
<ul>
  <li>Pushes, and everything else that changes a repository</li>
  <li>The website, sign-in, the API and the MCP server</li>
  <li>Work items, pull requests, sessions and chat</li>
  <li>Workflows and runners, security scans and version updates</li>
  <li>Deployments on g1t.page, packages and notifications</li>
</ul>
<p>Nobody is being billed for g1t.</p>

<hr>
<p class="muted">Thank you to everyone who tried it.</p>
</main>
</body>
</html>
`;
