/**
 * /robots.txt (lib/robots.ts). Served from the request's own origin, so a
 * self-hosted g1t names itself.
 */
import type { Route } from "./+types/robots-txt";
import { robotsTxt } from "../lib/robots";

export function loader({ request }: Route.LoaderArgs) {
  return new Response(robotsTxt(new URL(request.url).origin), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
