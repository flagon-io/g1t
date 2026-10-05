import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/accounts.tsx"),
  route("accounts/:id", "routes/account.tsx"),
  route("enterprises/new", "routes/new-enterprise.tsx"),
] satisfies RouteConfig;
