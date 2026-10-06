import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),
  // An invite link: who sent it, then sign-up or joining. `invite` is reserved.
  route("invite/:code", "routes/invite.tsx"),
  route("logout", "routes/logout.tsx"),
  route("verify", "routes/verify.tsx"),
  route("forgot", "routes/forgot.tsx"),
  route("reset", "routes/reset.tsx"),
  route("device", "routes/device.tsx"),
  route("oauth/authorize", "routes/oauth-authorize.tsx"),
  route("new", "routes/new.tsx"),
  // GitHub: signing in with it, and bringing repositories across through
  // g1t's GitHub App. `auth` and `integrations` are reserved names.
  route("new/github", "routes/new-github.tsx"),
  route("auth/github", "routes/auth-github.ts"),
  route("auth/github/callback", "routes/auth-github-callback.tsx"),
  route("auth/github/username", "routes/auth-github-username.tsx"),
  route("integrations/github/install", "routes/github-install.ts"),
  route("integrations/github/setup", "routes/github-setup.tsx"),
  route("settings", "routes/settings.tsx"),
  // People, apart from workspaces: `u` is a reserved name.
  route("u/:username", "routes/user.tsx"),
  route("explore", "routes/explore.tsx", { id: "explore" }),
  route("pricing", "routes/pricing.tsx"),
  route("search", "routes/search.tsx"),
  // What the command palette shows as someone types.
  route("search.json", "routes/search-json.ts"),
  route("workspaces/new", "routes/workspace/new.tsx"),
  // Trust pages: reserved names, like the rest above.
  route("policies", "routes/policies.tsx"),
  route("policies/:policy", "routes/policy.tsx"),
  route("security", "routes/security.tsx"),
  route("support", "routes/support.tsx"),
  route("status", "routes/status.tsx"),
  // What /status shows and the footer's dot reads, as JSON.
  route("status.json", "routes/status-json.ts"),
  route(".well-known/security.txt", "routes/security-txt.ts"),
  // A workspace's own pages sit under `-`, which no repository can be named.
  route(":owner", "routes/workspace/layout.tsx", [
    index("routes/workspace/overview.tsx"),
    route("-/people", "routes/workspace/people.tsx"),
    route("-/tokens", "routes/workspace/tokens.tsx"),
    route("-/usage", "routes/workspace/usage.tsx"),
    route("-/billing", "routes/workspace/billing.tsx"),
    route("-/billing/entries", "routes/workspace/statement-entries.ts"),
    route("-/billing/statement.csv", "routes/workspace/statement-csv.ts"),
    route("-/integrations", "routes/workspace/integrations.tsx"),
    route("-/webhooks", "routes/workspace/webhooks.tsx"),
    route("-/secrets", "routes/workspace/secrets.tsx"),
    route("-/settings", "routes/workspace/settings.tsx"),
    route("-/repositories", "routes/workspace/repositories.tsx"),
    route("-/agents", "routes/workspace/agents.tsx"),
    route("-/memory", "routes/workspace/memory.tsx"),
    route("-/context", "routes/workspace/context.tsx"),
    route("-/security", "routes/workspace/security.tsx"),
    route("-/audit", "routes/workspace/audit.tsx"),
    route("-/audit/export", "routes/workspace/audit-export.ts"),
    route("-/guardrails", "routes/workspace/guardrails.tsx"),
    // What the workspace will have across its projects.
    route("-/soon/:feature", "routes/workspace/soon.tsx"),
  ]),
  // Why a line is the way it is, fetched by the blame view.
  route(":owner/:repo/why/:hash", "routes/repo/why.ts"),
  // A project's agent runs as JSON, and stopping or messaging one.
  route(":owner/:repo/agents.json", "routes/repo/agents-live.ts"),
  // What a project's agent runs did, from the audit log, for the Agent panel.
  route(":owner/:repo/audit.json", "routes/repo/audit-live.ts"),
  // An invitation to a repository, answered by someone who cannot see it yet.
  route(":owner/:repo/invitations", "routes/repo/invitations.tsx"),
  // A screenshot of a project's production, for its overview.
  route(":owner/:repo/production.jpg", "routes/repo/production-screenshot.ts"),
  // A project: its overview first, its repository's code under Code. The
  // 1:1 project of a repository has the repository's name, so every
  // repository address below keeps working.
  route(":owner/:repo", "routes/repo/layout.tsx", [
    index("routes/repo/overview.tsx"),
    route("code", "routes/repo/code.tsx"),
    route("tree/:ref/*", "routes/repo/tree.tsx"),
    route("blob/:ref/*", "routes/repo/blob.tsx"),
    route("commits", "routes/repo/commits.tsx"),
    route("commit/:hash", "routes/repo/commit.tsx"),
    route("issues", "routes/repo/issues.tsx"),
    route("issues/new", "routes/repo/issue-new.tsx"),
    route("issues/:number", "routes/repo/issue.tsx"),
    route("pulls", "routes/repo/pulls.tsx"),
    route("pulls/new", "routes/repo/pull-new.tsx"),
    route("pull/:number", "routes/repo/pull.tsx"),
    route("queue", "routes/repo/queue.tsx"),
    route("agents", "routes/repo/agents.tsx"),
    route("agents/runs/:id", "routes/repo/agents-run.tsx"),
    route("sessions", "routes/repo/sessions.tsx"),
    route("sessions/:number", "routes/repo/session.tsx"),
    route("memory", "routes/repo/memory.tsx"),
    route("actions", "routes/repo/actions.tsx"),
    route("actions/runs/:id", "routes/repo/actions-run.tsx"),
    route("actions/runs/:id/artifacts/:name", "routes/repo/actions-artifact.ts"),
    route("actions/jobs/:job/log", "routes/repo/actions-log.ts"),
    route("deployments", "routes/repo/deployments.tsx"),
    route("deployments/:id", "routes/repo/deployment.tsx"),
    route("security", "routes/repo/security.tsx"),
    route("plans", "routes/repo/plans.tsx"),
    route("plans/:id", "routes/repo/plan.tsx"),
    route("settings", "routes/repo/settings.tsx"),
    route("settings/repository", "routes/repo/settings-repository.tsx"),
    route("settings/access", "routes/repo/settings-access.tsx"),
    route("settings/branches", "routes/repo/settings-branches.tsx"),
    route("settings/webhooks", "routes/repo/webhooks.tsx"),
    route("settings/secrets", "routes/repo/secrets.tsx"),
    route("settings/deployments", "routes/repo/settings-deployments.tsx"),
    route("settings/domains", "routes/repo/settings-domains.tsx"),
    route("settings/dependencies", "routes/repo/settings-dependencies.tsx"),
    route("settings/guardrails", "routes/repo/settings-guardrails.tsx"),
    route("settings/agents", "routes/repo/settings-agents.tsx"),
    // What the project will have: one page for each Soon in its menu.
    route("soon/:feature", "routes/repo/soon.tsx"),
  ]),
  // Anything else: a 404 that still knows who is signed in.
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
