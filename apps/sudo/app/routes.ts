import { type RouteConfig, index, route } from "@react-router/dev/routes";

import { soonItems } from "./lib/nav.ts";

export default [
  index("routes/overview.tsx"),
  route("workspaces", "routes/workspaces.tsx"),
  route("workspaces/:slug", "routes/workspace.tsx"),
  route("enterprises", "routes/enterprises.tsx"),
  route("enterprises/new", "routes/new-enterprise.tsx"),
  route("enterprises/:id", "routes/enterprise.tsx"),
  route("reach-out", "routes/reach-out.tsx"),
  route("invoices", "routes/invoices.tsx"),
  route("stripe", "routes/stripe.tsx"),
  route("audit", "routes/audit.tsx"),
  // What sudo will have: one placeholder page each, from lib/nav.ts.
  ...soonItems().map((item) => route(item.to.slice(1), "routes/soon.tsx", { id: `soon${item.to.replace(/\//g, "-")}` })),
  // Before sudo was organised around workspaces, everything was an account.
  route("accounts/*", "routes/legacy-accounts.tsx"),
] satisfies RouteConfig;
