// Stand-ins for identity, repos and events, so the packages service runs
// on its own with `wrangler dev` (see packages.jsonc beside it).
//
// - Identity knows one person, `dev`, an owner of the workspace `acme`,
//   whose token is DEV_TOKEN, a member, `mo` (MEMBER_TOKEN), and one
//   outsider, `bo` (OUTSIDER_TOKEN).
// - Repos knows two repositories of acme: `web` (private) and `site`
//   (public).
// - Repos also keeps a small git store for `lib` (rep_lib), a private PHP
//   library: tags v1.0.0 and v1.1.0, branches main and feature, for the
//   Composer registry (refs, raw_file, raw_blobs, list_files, all_ids).
//   Signing in with the password `g1t_push` (any request with Basic
//   credentials) tags v1.2.0 on a new commit, as a push would; then call
//   `sync_composer` as the git.push event would.
// - Events takes every event and audit entry and logs them.
// - Billing says acme is free, with FREE_PRIVATE_BYTES of private package
//   storage and 10 GB public.

const REPOS = {
  web: { isPrivate: true },
  site: { isPrivate: false },
  lib: { isPrivate: true },
};

// The library's commits: each its files. Hashes are made up, 40 hex each.
const composerJson = JSON.stringify(
  {
    name: "acme/lib",
    description: "Greets people",
    type: "library",
    license: "MIT",
    require: { php: ">=8.1" },
    autoload: { "psr-4": { "Acme\\Lib\\": "src/" } },
    "require-dev": { "phpunit/phpunit": "^11" },
  },
  null,
  2,
);
const greeter = (body) => `<?php\n\nnamespace Acme\\Lib;\n\nfinal class Greeter\n{\n${body}\n}\n`;
const COMMITS = {
  ["1".repeat(40)]: {
    "composer.json": composerJson,
    "src/Greeter.php": greeter('    public function hello(string $name): string { return "Hello, $name!"; }'),
    "README.md": "# acme/lib\n\nGreets people.\n",
    ".gitattributes": "/tests export-ignore\n",
    "tests/GreeterTest.php": "<?php // not in the archive\n",
  },
  ["2".repeat(40)]: {
    "composer.json": composerJson,
    "src/Greeter.php": greeter(
      '    public function hello(string $name): string { return "Hello, $name!"; }\n    public function bye(string $name): string { return "Bye, $name."; }',
    ),
    "README.md": "# acme/lib\n\nGreets people, and says goodbye.\n",
    ".gitattributes": "/tests export-ignore\n",
    "tests/GreeterTest.php": "<?php // not in the archive\n",
  },
  ["3".repeat(40)]: { "composer.json": composerJson, "src/Greeter.php": greeter("    // a feature in progress") },
  ["4".repeat(40)]: {
    "composer.json": composerJson,
    "src/Greeter.php": greeter(
      '    public function hello(string $name): string { return "Hi, $name!"; }\n    public function bye(string $name): string { return "Bye, $name."; }',
    ),
    "README.md": "# acme/lib\n\nv1.2.\n",
  },
};
const REFS = [
  { name: "refs/heads/main", commit: "2".repeat(40) },
  { name: "refs/heads/feature", commit: "3".repeat(40) },
  { name: "refs/tags/v1.0.0", commit: "1".repeat(40) },
  { name: "refs/tags/v1.1.0", commit: "2".repeat(40) },
];
const blobHash = (commit, path) => `${commit.slice(0, 8)}${Buffer.from(path).toString("hex")}`;
const base64 = (text) => Buffer.from(text).toString("base64");
function blob(hash) {
  for (const [commit, files] of Object.entries(COMMITS)) {
    for (const [path, text] of Object.entries(files)) if (blobHash(commit, path) === hash) return text;
  }
  return null;
}
const libRepo = () => ({
  id: "rep_lib",
  namespace: "acme",
  name: "lib",
  description: null,
  isPrivate: true,
  ownerId: "usr_dev",
  defaultBranch: "main",
  forkOf: null,
  createdAt: "2026-10-01T00:00:00.000Z",
});

function push() {
  if (!REFS.some((r) => r.name === "refs/tags/v1.2.0")) {
    REFS.push({ name: "refs/tags/v1.2.0", commit: "4".repeat(40) });
    REFS[0].commit = "4".repeat(40);
  }
}

function user(env, secret) {
  if (secret === "g1t_push") {
    push();
    return null;
  }
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
      case "refs":
        return json(args.repoId === "rep_lib" ? { repo: libRepo(), refs: REFS } : null);
      case "raw_file": {
        const commit = REFS.find((r) => r.name === args.ref || r.name === `refs/heads/${args.ref}`)?.commit ?? args.ref;
        const text = args.repoId === "rep_lib" ? COMMITS[commit]?.[args.path] : undefined;
        return json(text === undefined ? null : { size: text.length, data: base64(text) });
      }
      case "list_files": {
        const files = args.repoId === "rep_lib" ? COMMITS[args.ref] : undefined;
        return json({
          commit: files ? args.ref : null,
          files: Object.keys(files ?? {}).map((path) => ({ path, hash: blobHash(args.ref, path) })),
          truncated: false,
        });
      }
      case "raw_blobs":
        return json(
          (args.hashes ?? []).map((hash) => {
            const text = blob(hash);
            return { hash, size: text?.length ?? 0, data: text === null ? null : base64(text) };
          }),
        );
      case "all_ids":
        return json(args.after ? { ids: [], next: null } : { ids: ["rep_web", "rep_lib"], next: null });
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
