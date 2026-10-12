/**
 * When a Customize page reads its data again: for another page, the other
 * view, or a posted form (lib/customize.ts `needsReload`). A route export
 * the browser runs, so it lives apart from the server-only helpers.
 */
import type { ShouldRevalidateFunctionArgs } from "react-router";

import { needsReload } from "./customize";

export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs): boolean {
  return needsReload(currentUrl, nextUrl, formMethod) ? defaultShouldRevalidate : false;
}
