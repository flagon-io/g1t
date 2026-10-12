/**
 * The g1t CLI's install scripts: g1t.sh/install for Linux and macOS
 * (`curl -fsSL https://g1t.sh/install | sh`) and g1t.sh/install.ps1 for
 * Windows (`irm https://g1t.sh/install.ps1 | iex`). Each downloads the newest
 * release from g1t.sh/downloads/cli/ (scripts/cli-release.mjs), checks it
 * against the release's SHA256SUMS, and installs it. `install` is a
 * reserved name.
 */
import type { Route } from "./+types/install-script";
import sh from "../content/install/install.sh?raw";
import ps1 from "../content/install/install.ps1?raw";

export function loader({ request }: Route.LoaderArgs) {
  const windows = new URL(request.url).pathname.endsWith(".ps1");
  return new Response(windows ? ps1 : sh, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
