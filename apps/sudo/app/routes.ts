import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/workspaces.tsx"),
  route("workspaces", "routes/workspaces-redirect.tsx"),
  route("workspaces/:slug", "routes/workspace.tsx"),
  route("enterprises", "routes/enterprises.tsx"),
  route("enterprises/new", "routes/new-enterprise.tsx"),
  route("enterprises/:id", "routes/enterprise.tsx"),
  // Before sudo was organised around workspaces, everything was an account.
  route("accounts/*", "routes/legacy-accounts.tsx"),
] satisfies RouteConfig;
