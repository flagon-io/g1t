// Stand-ins for identity, events, security and billing, so the repos
// service answers anonymous git requests with `wrangler dev` (repos.jsonc).
//
// - Identity knows one person, `dev` (secret `dev-push-secret`), the owner
//   of the `acme` workspace, so pushes can be tried (push-check.mjs); any
//   other credentials name no one, and no workspace was renamed or
//   aliased. Public repositories can be cloned without signing in.
// - Events takes every event and audit entry and logs them.
// - Security has allowed no secrets; billing says every workspace is free.

export default {
  async fetch(request) {
    const method = new URL(request.url).pathname.replace(/^\/rpc\//, "");
    const args = await request.json().catch(() => ({}));
    const json = (value) => Response.json(value);
    switch (method) {
      case "user_for_git_credentials":
        return json(
          args.username === "dev" && args.secret === "dev-push-secret"
            ? { id: "usr_dev", username: "dev", kind: "user", verified: true, workspaces: [{ slug: "acme", role: "owner" }] }
            : null,
        );
      case "resolve_slug":
      case "resolve_alias":
        return json(null);
      case "is_free":
      case "plan":
        return json({ free: true });
      default:
        console.log(`stub ${method}`, JSON.stringify(args).slice(0, 200));
        return json(null);
    }
  },
};
