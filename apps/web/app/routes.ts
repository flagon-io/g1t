import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  // The second step of signing in, for an account with two-factor authentication.
  route("login/two-factor", "routes/login-two-factor.tsx"),
  route("register", "routes/register.tsx"),
  // An invite link: who sent it, then sign-up or joining. `invite` is reserved.
  route("invite/:code", "routes/invite.tsx"),
  route("logout", "routes/logout.tsx"),
  route("verify", "routes/verify.tsx"),
  // Where an account confirms its email address, with the code from the
  // email; every other page sends it here until it has (lib/confirm-gate.ts).
  route("confirm-email", "routes/confirm-email.tsx"),
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
  // A workspace's single sign-on: setting off to its identity provider,
  // coming back from it (OpenID Connect and OAuth 2.0), what a SAML sign-in
  // that did not work says (the provider's POST is answered before React
  // Router, workers/sso-saml.ts), and g1t's SAML metadata.
  route("auth/sso/:owner", "routes/auth-sso.tsx"),
  route("auth/sso/:owner/callback", "routes/auth-sso-callback.tsx"),
  route("auth/sso/:owner/saml", "routes/auth-sso-saml.tsx"),
  route("auth/sso/:owner/metadata", "routes/auth-sso-metadata.ts"),
  route("integrations/github/install", "routes/github-install.ts"),
  route("integrations/github/setup", "routes/github-setup.tsx"),
  // Your own settings: one page each, so links can name the one they mean.
  // `/settings` goes to the first; an old link's `#anchor` to its page.
  route("settings", "routes/settings/layout.tsx", [
    // Its pages fail inside its frame (routes/page-boundary.tsx).
    layout("routes/page-boundary.tsx", { id: "routes/page-boundary/settings" }, [
      index("routes/settings/index.tsx"),
      route("profile", "routes/settings/profile.tsx"),
      route("emails", "routes/settings/emails.tsx"),
      route("notifications", "routes/settings/notifications.tsx"),
      // Invite a friend: your invites to g1t.
      route("invites", "routes/settings/invites.tsx"),
      route("keys", "routes/settings/keys.tsx"),
      // Your access tokens: the list, a new one, and each one's page.
      route("tokens", "routes/settings/tokens.tsx"),
      route("tokens/new", "routes/settings/token-new.tsx"),
      route("tokens/:id", "routes/settings/token.tsx"),
      route("github", "routes/settings/github.tsx"),
      route("applications", "routes/settings/applications.tsx"),
      route("integrations", "routes/settings/integrations.tsx"),
      route("two-factor", "routes/settings/two-factor.tsx"),
      route("security-log", "routes/settings/security-log.tsx"),
      route("account", "routes/settings/account.tsx"),
    ]),
  ]),
  // The account menu's header: name, primary email and invites left.
  route("settings/menu.json", "routes/settings-menu-json.ts"),
  // People, apart from workspaces: `u` is a reserved name. Their profile's
  // tabs are paths (`/u/ada/pulls`); `?tab=` is sent on (lib/tab-paths.ts).
  route("u/:username/:tab?", "routes/user.tsx"),
  // The card that opens over a person's name or avatar (lib/hovercard.ts).
  // `-` is no workspace's name, so nothing else is ever found here.
  route("-/hovercard/user/:username", "routes/hovercard-user.ts"),
  // A person's picture by username, for avatars drawn from a name alone.
  route("-/avatar/user/:username", "routes/avatar-user.ts"),
  // An image pasted, dropped or chosen in a comment box, kept for its Markdown.
  route("-/attachments", "routes/attachments.ts"),
  // Live notifications: each tab's feed socket, and the person's
  // notification settings as JSON (services/notify).
  route("-/live", "routes/notify/live.ts"),
  // A page opened with an access token asks here for each socket's
  // short-lived ticket (lib/socket-ticket.ts).
  route("-/live/ticket", "routes/notify/ticket.ts"),
  route("-/notify", "routes/notify/api.ts"),
  route("explore", "routes/explore.tsx", { id: "explore" }),
  route("pricing", "routes/pricing.tsx"),
  route("features", "routes/features.tsx"),
  route("search", "routes/search.tsx"),
  // Each person's notifications, what the panel in the top bar fetches,
  // and the address the page once had. Saved and Done are
  // `/notifications/saved` and `/notifications/done`.
  route("notifications/:view?", "routes/notifications.tsx"),
  route("inbox", "routes/inbox-moved.ts"),
  route("inbox.json", "routes/inbox-json.ts"),
  // What the command palette shows as someone types.
  route("search.json", "routes/search-json.ts"),
  route("workspaces/new", "routes/workspace/new.tsx"),
  // Workspace invitations waiting for the person's answer. `invitations` is reserved.
  route("invitations", "routes/invitations.tsx"),
  // People to invite, as the People page's invite form searches them.
  route("-/people.json", "routes/people-json.ts"),
  // The desktop app's runner: its registration token, and its reports (lib/desktop-runner.ts).
  route("-/desktop/runner", "routes/desktop-runner.ts"),
  // Trust pages: reserved names, like the rest above.
  route("policies", "routes/policies.tsx"),
  route("policies/:policy", "routes/policy.tsx"),
  route("security", "routes/security.tsx"),
  route("support", "routes/support.tsx"),
  // Status moved to status.g1t.sh (apps/status); old links go there.
  route("status", "routes/status.tsx"),
  route("status.json", "routes/status-json.ts"),
  route(".well-known/security.txt", "routes/security-txt.ts"),
  // Where this g1t's parts are, for the phone app pointed at it (packages/contracts src/discovery.ts).
  route(".well-known/g1t.json", "routes/well-known-g1t.ts"),
  // For search engines: what may be crawled, and a map of the public pages.
  route("robots.txt", "routes/robots-txt.ts"),
  route("sitemap.xml", "routes/sitemap-xml.ts"),
  // The desktop app: which to install, from its newest release.
  route("download", "routes/download.tsx"),
  // Releases of the desktop app, the self-hosted runner and the g1t CLI, from R2.
  route("downloads/:tool/*", "routes/downloads-runner.ts"),
  // The g1t CLI's install scripts, for Linux and macOS and for Windows. `install` is reserved.
  route("install", "routes/install-script.ts", { id: "routes/install-sh" }),
  route("install.ps1", "routes/install-script.ts", { id: "routes/install-ps1" }),
  // A workspace's own pages sit under `-`, which no repository can be named.
  route(":owner", "routes/workspace/layout.tsx", [
    // Its pages fail inside its frame (routes/page-boundary.tsx).
    layout("routes/page-boundary.tsx", { id: "routes/page-boundary/workspace" }, [
      index("routes/workspace/overview.tsx"),
      // Its pages, each in the sidebar: Overview (above), Projects, People, Insights; Teams and Packages below.
      route("-/projects", "routes/workspace/projects.tsx"),
      // People mode: the directory of people and each one's profile.
      route("-/people", "routes/workspace/people.tsx"),
      route("-/people/:username", "routes/workspace/people/person.tsx"),
      // Workspace mode's Access: who is a member and their roles, the invitations sent, and who may do what.
      route("-/members", "routes/workspace/members.tsx"),
      route("-/members/invitations", "routes/workspace/member-invitations.tsx"),
      route("-/permissions", "routes/workspace/permissions.tsx"),
      // Single sign-on through the workspace's own identity provider.
      route("-/sso", "routes/workspace/sso.tsx"),
      route("-/insights", "routes/workspace/insights.tsx"),
      // Pinning its projects, for the person signed in.
      route("-/pins", "routes/workspace/pins.ts"),
      // Getting started, for its owners: the guide's state, and dismissing
      // it or skipping a step (components/onboarding.tsx).
      route("-/onboarding", "routes/workspace/onboarding.ts"),
      // Code's Overview: Mission control's code panels, for this workspace.
      route("-/overview", "routes/workspace/code-overview.tsx"),
      // The workspace itself, at a glance: members, plan and spend.
      route("-/workspace", "routes/workspace/workspace-overview.tsx"),
      // Teams: the list, a new one, and each team's pages.
      route("-/teams", "routes/workspace/teams.tsx"),
      route("-/teams/new", "routes/workspace/team-new.tsx"),
      route("-/teams/:team", "routes/workspace/team/layout.tsx", [
        index("routes/workspace/team/members.tsx"),
        route("teams", "routes/workspace/team/teams.tsx"),
        route("repositories", "routes/workspace/team/repositories.tsx"),
        route("settings", "routes/workspace/team/settings.tsx"),
      ]),
      // The workspace's own access tokens: the list, a new one, and each one's page.
      route("-/tokens", "routes/workspace/tokens.tsx"),
      route("-/tokens/new", "routes/workspace/token-new.tsx"),
      route("-/tokens/:id", "routes/workspace/token.tsx"),
      // Its rules for members' personal access tokens, and approving them.
      route("-/personal-access-tokens", "routes/workspace/personal-access-tokens.tsx"),
      route("-/usage", "routes/workspace/usage.tsx"),
      route("-/billing", "routes/workspace/billing.tsx"),
      // What the workspace's AI providers say its organization spent, from
      // their own cost reports (services/billing/src/provider_costs.rs).
      route("-/provider-costs", "routes/workspace/provider-costs.tsx"),
      route("-/billing/entries", "routes/workspace/statement-entries.ts"),
      route("-/billing/statement.csv", "routes/workspace/statement-csv.ts"),
      // The workspace's AI: its AI providers, managed or self-hosted, and
      // what Ask answers with. A base setting, not an integration.
      route("-/ai", "routes/workspace/ai.tsx"),
      // The integrations directory, and the setup pages for alerts and
      // trackers (lib/integration-sections).
      route("-/integrations", "routes/workspace/integrations-directory.tsx"),
      route("-/integrations/:section", "routes/workspace/integrations.tsx"),
      // Ask g1t, from the top bar: what it answers with, and each answer,
      // streamed (components/ask-composer).
      route("-/ask", "routes/workspace/ask.ts"),
      route("-/webhooks", "routes/workspace/webhooks.tsx"),
      // The workspace's own emoji, for chat (components/emoji).
      route("-/emoji", "routes/workspace/emoji.tsx"),
      route("-/secrets", "routes/workspace/secrets.tsx"),
      route("-/runners", "routes/workspace/runners.tsx"),
      route("-/actions", "routes/workspace/actions-settings.tsx"),
      route("-/packages", "routes/workspace/packages.tsx"),
      route("-/packages/:ecosystem/*", "routes/workspace/package.tsx"),
      route("-/settings", "routes/workspace/settings.tsx"),
      // What members may do in chat: channels, emoji, default channels.
      route("-/settings/chat", "routes/workspace/chat-settings.tsx"),
      route("-/repositories", "routes/workspace/repositories.tsx"),
      // Chat mode: channels by name, direct messages by id, and what the page
      // calls as it runs: the live socket and the JSON for sending and reading.
      route("-/chat/live", "routes/workspace/chat/live.ts"),
      route("-/chat/api", "routes/workspace/chat/api.ts"),
      // A person's card in Chat: their profile and teams here.
      route("-/chat/person/:username", "routes/workspace/chat/person.ts"),
      // A work item or pull request's card, over its chip in chat and g1t's answers.
      route("-/chat/ref", "routes/workspace/chat/ref.ts"),
      route("-/chat", "routes/workspace/chat/layout.tsx", [
        index("routes/workspace/chat/index.tsx"),
        route("browse", "routes/workspace/chat/browse.tsx"),
        route("dm/:id", "routes/workspace/chat/channel.tsx", { id: "routes/workspace/chat/dm" }),
        route(":channel", "routes/workspace/chat/channel.tsx"),
      ]),
      // Artifacts mode (code says "folio"): what its
      // pages call as they run (an artifact's live socket, JSON, comments,
      // uploads, export), then Home, making one, templates, the trash, the
      // spaces, and each artifact by its address. Addresses are flat and end
      // in the id, so renaming or moving one keeps links working.
      route("-/artifacts/live", "routes/workspace/folios/live.ts"),
      route("-/artifacts/api", "routes/workspace/folios/api.ts"),
      route("-/artifacts/threads/:folio/*", "routes/workspace/folios/threads.ts"),
      route("-/artifacts/upload", "routes/workspace/folios/upload.ts"),
      route("-/artifacts/export", "routes/workspace/folios/export.ts"),
      route("-/artifacts", "routes/workspace/folios/layout.tsx", [
        index("routes/workspace/folios/home.tsx"),
        route("new/:kind", "routes/workspace/folios/new.tsx"),
        route("templates", "routes/workspace/folios/templates.tsx"),
        route("trash", "routes/workspace/folios/trash.tsx"),
        // Artifacts possibly out of date, and a project's docs folder, read-only.
        route("stale", "routes/workspace/folios/stale.tsx"),
        route("spaces", "routes/workspace/folios/spaces.tsx"),
        route("spaces/new", "routes/workspace/folios/space-new.tsx"),
        route("spaces/:space", "routes/workspace/folios/space.tsx"),
        route("spaces/:space/settings", "routes/workspace/folios/space-settings.tsx"),
        route("repo/:repoOwner/:repoName/*", "routes/workspace/folios/repo-file.tsx"),
        route(":folio", "routes/workspace/folios/folio.tsx"),
        route(":folio/history", "routes/workspace/folios/history.tsx"),
      ]),
      // Home, the workspace's front page (`-/today` leads there), where it
      // marks your visit, and every app in it you can use, with pinning them
      // to your rail.
      route("-/home", "routes/workspace/home.tsx"),
      route("-/home/seen", "routes/workspace/home-seen.ts"),
      // Work: the workspace's work items, for every member. It opens on the
      // plan (Now, Next, Later; `-/work` with the list's filters is an old
      // link to the list, and goes there), with one Later group's items and
      // Triage, the new ones nobody has placed. Then the list of all of them
      // (its filters in the address), the board of them as they move, a new
      // one, the labels and milestones they share with pull requests, `#12`
      // read in the workspace, and each item. Sessions are Work's too: what
      // is cooking across the workspace, in every repository of it the
      // viewer may read (live sessions of every kind, the merge queues, what
      // landed and what happened), and one session's page.
      route("-/work", "routes/workspace/work/plan.tsx"),
      route("-/work/plan/later", "routes/workspace/work/plan-later.ts"),
      route("-/work/triage", "routes/workspace/work/triage.tsx"),
      route("-/work/all", "routes/workspace/work/list.tsx"),
      route("-/work/board", "routes/workspace/work/board.tsx"),
      route("-/work/sessions", "routes/workspace/work/sessions/list.tsx"),
      route("-/work/sessions/:id", "routes/workspace/work/sessions/session.tsx"),
      route("-/work/new", "routes/workspace/work/new.tsx"),
      route("-/work/labels", "routes/workspace/work/labels.tsx"),
      route("-/work/milestones", "routes/workspace/work/milestones.tsx"),
      route("-/work/milestones/:number", "routes/workspace/work/milestone.tsx"),
      route("-/work/ref/:number", "routes/workspace/work/ref.ts"),
      route("-/work/:number", "routes/workspace/work/item.tsx"),
      route("-/today", "routes/workspace/moved.ts", { id: "routes/workspace/moved-today" }),
      route("-/apps", "routes/workspace/apps.tsx"),
      // Routines: standing work for @g1t, on a schedule or when something
      // happens. Not on yet: the page shows what it will be, every control off.
      route("-/routines", "routes/workspace/routines.tsx"),
      // What Code's pages say to a member without Code.
      route("-/code-access", "routes/workspace/code-access.tsx"),
      route("-/security", "routes/workspace/security.tsx"),
      route("-/security/patterns", "routes/workspace/security-patterns.tsx"),
      route("-/security/bypass-requests", "routes/workspace/security-bypass.tsx"),
      route("-/security/settings", "routes/workspace/security-settings.tsx"),
      route("-/audit", "routes/workspace/audit.tsx"),
      route("-/audit/export", "routes/workspace/audit-export.ts"),
      route("-/guardrails", "routes/workspace/guardrails.tsx"),
      route("-/rules", "routes/workspace/rules.tsx"),
      route("-/rules/insights", "routes/workspace/rules.tsx", { id: "routes/workspace/rules-insights" }),
      route("-/rules/:id", "routes/workspace/ruleset.tsx"),
      // What the workspace will have across its projects.
      route("-/soon/:feature", "routes/workspace/soon.tsx"),
    ]),
  ]),
  // `#12` read in a repository: where Markdown's `#12` leads, and, as JSON,
  // the card over a `#12` in a commit message or on a timeline.
  route(":owner/:repo/ref/:number", "routes/repo/ref-card.ts"),
  // A repository's issues, labels and milestones moved to its workspace's
  // Work: old links are sent on (routes/repo/moved-work.ts), before the
  // repository's own pages.
  route(":owner/:repo/issues", "routes/repo/moved-work.ts", { id: "routes/repo/moved-issues" }),
  route(":owner/:repo/issues/new", "routes/repo/moved-work.ts", { id: "routes/repo/moved-issue-new" }),
  route(":owner/:repo/issues/:number", "routes/repo/moved-work.ts", { id: "routes/repo/moved-issue" }),
  route(":owner/:repo/labels", "routes/repo/moved-work.ts", { id: "routes/repo/moved-labels" }),
  route(":owner/:repo/milestones", "routes/repo/moved-work.ts", { id: "routes/repo/moved-milestones" }),
  route(":owner/:repo/milestones/:number", "routes/repo/moved-work.ts", { id: "routes/repo/moved-milestone" }),
  // Why a line is the way it is, fetched by the blame view.
  route(":owner/:repo/why/:hash", "routes/repo/why.ts"),
  // Files of a large change with their lines, fetched as the diff view reaches them.
  route(":owner/:repo/diff-files.json", "routes/repo/diff-files.ts"),
  // Its branch names, for changing the branch a pull request merges into.
  route(":owner/:repo/branches.json", "routes/repo/branch-names.ts"),
  // An invitation to a repository, answered by someone who cannot see it yet.
  route(":owner/:repo/invitations", "routes/repo/invitations.tsx"),
  // The Files page's About as JSON, asked again while it is first worked out.
  route(":owner/:repo/about.json", "routes/repo/about-json.ts"),
  // Starring it, from the header's Star button.
  route(":owner/:repo/star", "routes/repo/star.ts"),
  // Bringing a fork's branch up to date with its parent's (components/fork-bar.tsx).
  route(":owner/:repo/sync-fork", "routes/repo/sync-fork.ts"),
  // Subscribing to its work items and pull requests, and watching it.
  route(":owner/:repo/notifications", "routes/repo/notifications.ts"),
  // A starter CI workflow, opened as a pull request (components/add-ci.tsx).
  route(":owner/:repo/add-ci", "routes/repo/add-ci.ts"),
  // A screenshot of a project's production, for its overview.
  route(":owner/:repo/production.jpg", "routes/repo/production-screenshot.ts"),
  // The same, of production deployed elsewhere, at its address.
  route(":owner/:repo/production-elsewhere.jpg", "routes/repo/production-elsewhere.ts"),
  // A file as it is, sent on to the usercontent origin (lib/usercontent.ts).
  route(":owner/:repo/raw/:ref/*", "routes/repo/raw.ts"),
  // A file's blame as JSON, fetched by its blame view (routes/repo/blob.tsx).
  route(":owner/:repo/blame/:ref/*", "routes/repo/blame-data.ts"),
  // A project: its overview first, its repository's code under Code. The
  // 1:1 project of a repository has the repository's name, so every
  // repository address below keeps working.
  route(":owner/:repo", "routes/repo/layout.tsx", [
    // Its pages fail inside its frame (routes/page-boundary.tsx).
    layout("routes/page-boundary.tsx", { id: "routes/page-boundary/repo" }, [
      index("routes/repo/overview.tsx"),
      route("code", "routes/repo/code.tsx"),
      route("tree/:ref/*", "routes/repo/tree.tsx"),
      route("blob/:ref/*", "routes/repo/blob.tsx"),
      route("archive/*", "routes/repo/archive.ts"),
      route("commits", "routes/repo/commits.tsx"),
      // Its tabs are paths: `branches/yours`, `branches/stale`, ….
      route("branches/:tab?", "routes/repo/branches.tsx"),
      route("tags", "routes/repo/tags.tsx"),
      route("releases", "routes/repo/releases.tsx"),
      route("releases/new", "routes/repo/release-new.tsx"),
      route("releases/tag/*", "routes/repo/release.tsx"),
      route("contributors", "routes/repo/contributors.tsx"),
      route("activity", "routes/repo/activity.tsx"),
      route("stargazers", "routes/repo/stargazers.tsx"),
      // Forking it into a workspace, and the forks there are.
      route("fork", "routes/repo/fork.tsx"),
      route("forks", "routes/repo/forks.tsx"),
      route("compare/*", "routes/repo/compare.tsx", { id: "routes/repo/compare-range" }),
      route("compare", "routes/repo/compare.tsx"),
      route("commit/:hash", "routes/repo/commit.tsx"),
      // A check run reported on a commit: its report, annotations and buttons.
      route("checks/:id", "routes/repo/check-run.tsx"),
      route("pulls", "routes/repo/pulls.tsx"),
      route("pulls/new", "routes/repo/pull-new.tsx"),
      // Its tabs are paths: `pull/12/session`, `pull/12/files`.
      route("pull/:number/:tab?", "routes/repo/pull.tsx"),
      route("queue", "routes/repo/queue.tsx"),
      route("usage", "routes/repo/usage.tsx"),
      route("actions", "routes/repo/actions.tsx"),
      route("actions/runs/:id", "routes/repo/actions-run.tsx"),
      route("actions/runs/:id/artifacts/:name", "routes/repo/actions-artifact.ts"),
      route("actions/jobs/:job/log", "routes/repo/actions-log.ts"),
      route("actions/jobs/:job/log.txt", "routes/repo/actions-job-log-download.ts"),
      route("actions/runs/:id/logs.zip", "routes/repo/actions-logs-download.ts"),
      route("actions/workflows/:file/badge.svg", "routes/repo/actions-badge.ts"),
      route("deployments", "routes/repo/deployments.tsx"),
      route("deployments/:id", "routes/repo/deployment.tsx"),
      // Observability: what the project's running software did (services/telemetry).
      route("observability", "routes/repo/observability.tsx"),
      route("observability/requests", "routes/repo/observability-requests.tsx"),
      route("observability/requests/:id", "routes/repo/observability-request.tsx"),
      route("observability/logs", "routes/repo/observability-logs.tsx"),
      route("observability/traces", "routes/repo/observability-traces.tsx"),
      route("observability/traces/:trace", "routes/repo/observability-trace.tsx"),
      route("observability/errors", "routes/repo/observability-errors.tsx"),
      route("observability/metrics", "routes/repo/observability-metrics.tsx"),
      route("observability/settings", "routes/repo/observability-settings.tsx"),
      // The live tail's socket, forwarded to the project's store.
      route("observability/live", "routes/repo/observability-live.ts"),
      // Security: an overview, then a page for each part. Old links to
      // `security?tab=…` are sent on by the overview.
      route("security", "routes/repo/security-overview.tsx"),
      route("security/secret-scanning", "routes/repo/security-secrets.tsx"),
      route("security/secret-scanning/patterns", "routes/repo/security-patterns.tsx"),
      route("security/secret-scanning/:id", "routes/repo/security-secret.tsx"),
      route("security/code-scanning", "routes/repo/security-code.tsx"),
      route("security/code-scanning/setup", "routes/repo/security-code-setup.ts"),
      route("security/code-scanning/:number", "routes/repo/security-code-alert.tsx"),
      route("security/vulnerabilities", "routes/repo/security.tsx"),
      route("security/dependency-graph", "routes/repo/security-graph.tsx"),
      route("security/dependency-graph/sbom.json", "routes/repo/security-sbom.ts"),
      route("security/dependency-updates", "routes/repo/security-updates.tsx"),
      route("security/pulls/:number", "routes/repo/security-pull.tsx"),
      route("security/settings", "routes/repo/security-settings.tsx"),
      // Reporting: the policy's pull request, advisories, and private vulnerability reports.
      route("security/policy/setup", "routes/repo/security-policy-setup.ts"),
      route("security/advisories", "routes/repo/security-advisories.tsx"),
      route("security/advisories/new", "routes/repo/security-advisory-edit.tsx", { id: "routes/repo/security-advisory-new" }),
      route("security/advisories/:id", "routes/repo/security-advisory.tsx"),
      route("security/advisories/:id/edit", "routes/repo/security-advisory-edit.tsx"),
      route("security/reports", "routes/repo/security-reports.tsx"),
      route("security/report", "routes/repo/security-report.tsx"),
      route("settings", "routes/repo/settings.tsx"),
      route("settings/repository", "routes/repo/settings-repository.tsx"),
      route("settings/access", "routes/repo/settings-access.tsx"),
      route("settings/keys", "routes/repo/settings-deploy-keys.tsx"),
      route("settings/branches", "routes/repo/settings-branches.tsx"),
      route("settings/rules", "routes/repo/settings-rules.tsx"),
      route("settings/rules/insights", "routes/repo/settings-rules.tsx", { id: "routes/repo/settings-rules-insights" }),
      route("settings/rules/:id", "routes/repo/settings-ruleset.tsx"),
      route("settings/webhooks", "routes/repo/webhooks.tsx"),
      route("settings/secrets", "routes/repo/secrets.tsx"),
      route("settings/actions", "routes/repo/settings-actions.tsx"),
      route("settings/environments", "routes/repo/settings-environments.tsx"),
      route("settings/runners", "routes/repo/settings-runners.tsx"),
      route("settings/deployments", "routes/repo/settings-deployments.tsx"),
      route("settings/domains", "routes/repo/settings-domains.tsx"),
      route("settings/guardrails", "routes/repo/settings-guardrails.tsx"),
      // What the project will have: one page for each Soon in its menu.
      route("soon/:feature", "routes/repo/soon.tsx"),
    ]),
  ]),
  // Anything else: a 404 that still knows who is signed in.
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
