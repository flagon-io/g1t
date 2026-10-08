import { type RouteConfig, index, route } from "@react-router/dev/routes";

import { soonItems } from "./lib/nav.ts";

export default [
  index("routes/overview.tsx"),
  route("workspaces", "routes/workspaces.tsx"),
  route("workspaces/deleted", "routes/deleted-workspaces.tsx"),
  route("workspaces/:slug", "routes/workspace.tsx"),
  route("users/:username", "routes/user.tsx"),
  route("enterprises", "routes/enterprises.tsx"),
  route("invites", "routes/invites.tsx"),
  route("aliases", "routes/aliases.tsx"),
  route("enterprises/new", "routes/new-enterprise.tsx"),
  route("enterprises/:id", "routes/enterprise.tsx"),
  route("reach-out", "routes/reach-out.tsx"),
  route("requests", "routes/requests.tsx"),
  route("overages", "routes/overages.tsx"),
  route("velocity", "routes/velocity.tsx"),
  route("costs", "routes/costs.tsx"),
  route("costs/bill", "routes/costs-bill.tsx"),
  route("agents", "routes/agents.tsx"),
  route("abuse", "routes/abuse.tsx"),
  route("invoices", "routes/invoices.tsx"),
  route("credits", "routes/credits.tsx"),
  route("stripe", "routes/stripe.tsx"),
  route("audit", "routes/audit.tsx"),
  route("timezone", "routes/timezone.tsx"),
  route("incidents", "routes/incidents.tsx"),
  route("incidents/new", "routes/incident-new.tsx"),
  route("incidents/maintenance/new", "routes/maintenance-new.tsx"),
  route("incidents/maintenance/:id", "routes/maintenance.tsx"),
  route("incidents/:id", "routes/incident.tsx"),
  route("incidents/:id/postmortem", "routes/incident-postmortem.tsx"),
  // What sudo will have: one placeholder page each, from lib/nav.ts.
  ...soonItems().map((item) => route(item.to.slice(1), "routes/soon.tsx", { id: `soon${item.to.replace(/\//g, "-")}` })),
  // Before sudo was organised around workspaces, everything was an account.
  route("accounts/*", "routes/legacy-accounts.tsx"),
] satisfies RouteConfig;
