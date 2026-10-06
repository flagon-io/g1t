/**
 * /.well-known/security.txt (RFC 9116): where to report a vulnerability.
 * Its `Expires` is computed, so it never goes stale.
 */
import type { Route } from "./+types/security-txt";
import { securityTxt } from "../lib/legal";

export function loader({ request }: Route.LoaderArgs) {
  const site = new URL(request.url).origin;
  return new Response(securityTxt(new Date(), site), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
