/** Explicit Markdown negotiation; ordinary browsers and wildcard clients keep HTML. */
export function pageRepresentation(accept: string | null): "html" | "markdown" | "none" {
  if (!accept?.trim()) return "html";
  const ranges = accept
    .toLowerCase()
    .split(",")
    .map((part) => {
      const [type, ...parameters] = part
        .trim()
        .split(";")
        .map((value) => value.trim());
      const quality = parameters.find((value) => value.startsWith("q="))?.slice(2) ?? "1";
      const q = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality) ? Number(quality) : 0;
      return { type, q };
    });
  function weight(type: string) {
    for (const [specificity, candidate] of [
      [2, type],
      [1, "text/*"],
      [0, "*/*"],
    ] as const) {
      const matches = ranges.filter((range) => range.type === candidate);
      if (matches.length) return { q: Math.max(...matches.map((range) => range.q)), specificity };
    }
    return { q: 0, specificity: -1 };
  }
  const html = weight("text/html");
  const markdown = weight("text/markdown");
  if (html.q === 0 && markdown.q === 0) return "none";
  return markdown.q > html.q || (markdown.q === html.q && markdown.specificity > html.specificity) ? "markdown" : "html";
}

export function varyAccept(headers: Headers) {
  const values = (headers.get("vary") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value === "*" || value.toLowerCase() === "accept")) values.push("Accept");
  headers.set("vary", values.join(", "));
}

export function developerResource(path: string, addresses: { api: string; mcp: string }): string | null {
  const resources: Record<string, string> = {
    "/developers": "https://docs.g1t.sh/reference/developers/",
    "/openapi.json": `${addresses.api}/openapi.json`,
    "/mcp": addresses.mcp,
  };
  return resources[path] ?? null;
}

/** Called only for document responses, after routing and authorization decide the status. */
export function agentPage(request: Request, status: number, headers: Headers): Response | null {
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  if (status !== 404 && !(status === 200 && url.pathname === "/")) return null;
  varyAccept(headers);
  const representation = pageRepresentation(request.headers.get("accept"));
  if (representation === "html") return null;
  headers.set("content-type", representation === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8");
  headers.delete("content-length");
  const body =
    representation === "none"
      ? "This page is available as text/html or text/markdown.\n"
      : status === 404
        ? `# Page not found\n\nThe requested page does not exist or is not available to you.\n\nSee [g1t agent instructions](${url.origin}/llms.txt) or the [sitemap](${url.origin}/sitemap.xml) to find a public resource.\n`
        : `# g1t\n\ng1t is an open-source workspace for repositories, work items, pull requests, reviews, required checks, a merge queue, deployments, team chat and Artifacts documents. Bring the coding agents you already use through MCP, REST or the CLI.\n\n## When to use g1t\n\nUse g1t to inspect a repository's code and issues, prepare and review pull requests, follow checks and deployment status, and coordinate agent work in a shared repository. Use the API or MCP for structured reads and changes; use git for cloning and pushing code.\n\n## Developer resources\n\n- [Agent instructions](${url.origin}/llms.txt)\n- [g1t documentation](https://docs.g1t.sh/)\n- [REST API and versioning](https://docs.g1t.sh/reference/api/)\n- [OpenAPI](https://api.g1t.sh/openapi.json)\n- [Authentication and scopes](https://docs.g1t.sh/guides/authentication/)\n- [MCP server](https://mcp.g1t.sh)\n- [CLI installation](https://docs.g1t.sh/guides/cli/)\n- [Pricing](${url.origin}/pricing)\n\nPublic repositories can be read without credentials. Writes and private data require authorization; request only the scopes your task needs. Never ask a user to paste their password.\n`;
  return new Response(request.method === "HEAD" ? null : body, { status: representation === "none" ? 406 : status, headers });
}
