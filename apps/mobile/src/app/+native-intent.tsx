import { linkPathOf, routeFor } from "@/lib/links";

/**
 * Where a link that opens the app goes. `g1t://` links name a site path,
 * as on the desktop; the app shows the ones it has screens for and opens
 * the rest on the site (app/open.tsx). Android App Links and iOS
 * Universal Links for https://g1t.sh come through here too once the site
 * publishes assetlinks.json and apple-app-site-association.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const sitePath = linkPathOf(path) ?? path;
    const route = routeFor(sitePath);
    return route ?? `/open?path=${encodeURIComponent(sitePath)}`;
  } catch {
    return "/";
  }
}
