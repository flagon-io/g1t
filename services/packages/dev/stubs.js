// Stand-ins for identity, repos and events, so the packages service runs
// on its own with `wrangler dev` (see packages.jsonc beside it).
//
// - Identity knows one person, `dev`, an owner of the workspace `acme`,
//   whose token is DEV_TOKEN, a member, `mo` (MEMBER_TOKEN), and one
//   outsider, `bo` (OUTSIDER_TOKEN).
// - Repos knows two repositories of acme: `web` (private) and `site`
//   (public).
// - Events takes every event and audit entry and logs them.
// - Billing says acme is free, with FREE_PRIVATE_BYTES of private package
//   storage and 10 GB public.

const REPOS = {
  web: { isPrivate: true },
  site: { isPrivate: false },
};

function user(env, secret) {
  if (secret === env.DEV_TOKEN) {
    return {
      id: "usr_dev",
      username: "dev",
      kind: "user",
      verified: true,
      workspaces: [{ slug: "acme", role: "owner" }],
      token: { token_id: "tok_dev" },
    };
  }
  if (secret === env.MEMBER_TOKEN) {
    return {
      id: "usr_mo",
      username: "mo",
      kind: "user",
      verified: true,
      workspaces: [{ slug: "acme", role: "member" }],
      token: { token_id: "tok_mo" },
    };
  }
  if (secret === env.OUTSIDER_TOKEN) {
    return { id: "usr_bo", username: "bo", kind: "user", verified: true, workspaces: [], token: { token_id: "tok_bo" } };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const method = new URL(request.url).pathname.replace(/^\/rpc\//, "");
    const args = await request.json().catch(() => ({}));
    const json = (value) => Response.json(value);
    switch (method) {
      case "user_for_git_credentials":
        return json(user(env, args.secret));
      case "get": {
        const repo = args.path?.namespace === "acme" ? REPOS[args.path.name] : undefined;
        if (!repo) return json({ ok: false, error: { code: "not_found", message: "Repository not found." } });
        return json({
          ok: true,
          value: {
            id: `rep_${args.path.name}`,
            namespace: "acme",
            name: args.path.name,
            description: null,
            isPrivate: repo.isPrivate,
            ownerId: "usr_dev",
            defaultBranch: "main",
            forkOf: null,
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        });
      }
      case "publish":
        for (const event of args.events ?? []) console.log(`event ${event.type} ${JSON.stringify(event.data)}`);
        return json(null);
      case "entitlements":
        return json({
          workspace: args.workspace,
          plan: "free",
          hasPlan: false,
          packagePublicFreeBytes: 10_000_000_000,
          packagePrivateFreeBytes: Number(env.FREE_PRIVATE_BYTES),
        });
      case "audit_record":
        for (const entry of args.entries ?? []) console.log(`audit ${entry.action} by ${entry.actor} on ${entry.path}`);
        return json((args.entries ?? []).length);
      default:
        return new Response(`stub: no method ${method}`, { status: 404 });
    }
  },
};
