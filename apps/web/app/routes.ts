import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),
  route("logout", "routes/logout.tsx"),
  route("verify", "routes/verify.tsx"),
  route("forgot", "routes/forgot.tsx"),
  route("reset", "routes/reset.tsx"),
  route("new", "routes/new.tsx"),
  route("settings", "routes/settings.tsx"),
  route("explore", "routes/explore.tsx", { id: "explore" }),
  route("search", "routes/explore.tsx", { id: "search" }),
  route("docs/api/reference", "routes/api-reference.tsx"),
  route("docs/:page?", "routes/docs.tsx"),
  route(":owner", "routes/profile.tsx"),
  route(":owner/:repo", "routes/repo/layout.tsx", [
    index("routes/repo/code.tsx"),
    route("tree/:ref/*", "routes/repo/tree.tsx"),
    route("blob/:ref/*", "routes/repo/blob.tsx"),
    route("commits", "routes/repo/commits.tsx"),
    route("intents", "routes/repo/intents.tsx"),
    route("intents/new", "routes/repo/intent-new.tsx"),
    route("intents/:number", "routes/repo/intent.tsx"),
    route("attempts/:id", "routes/repo/attempt.tsx"),
  ]),
] satisfies RouteConfig;
