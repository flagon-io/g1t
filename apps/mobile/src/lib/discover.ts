import { DISCOVERY_PATH, parseDiscovery } from "@g1t/contracts/discovery";

import { type Server, parseOrigin, parseServer } from "./server";

/**
 * A g1t from the address someone typed, or a `g1t://connect` link gave:
 * its site, and its API as the site says (`/.well-known/g1t.json`,
 * packages/contracts src/discovery.ts), so a self-hosted g1t's API can be
 * anywhere. A g1t from before the phone app has no such file: its API is
 * then taken to be `api.` in front of the site, and Chat may need a
 * website-enabled access token there.
 */
export type Found = { server: Server; known: boolean; push: boolean; chat: boolean };

export async function discover(siteText: string, apiText?: string): Promise<Found> {
  const site = parseOrigin(siteText);
  if (!site) throw new Error("That is not a web address. It looks like https://g1t.example.com.");
  if (apiText?.trim()) {
    const given = parseServer(site, apiText);
    if (!given) throw new Error("The API's address is not a web address.");
    return { server: given, known: false, push: true, chat: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(site + DISCOVERY_PATH, { headers: { accept: "application/json" }, signal: controller.signal });
    const found = response.ok ? parseDiscovery(await response.json()) : null;
    if (found) {
      return { server: { site: found.site, api: found.api, push: found.phone.push }, known: true, push: found.phone.push, chat: found.phone.chat };
    }
  } catch {
    // Unreachable, or not g1t: said below.
  } finally {
    clearTimeout(timer);
  }
  const guessed = parseServer(site);
  if (!guessed) throw new Error("That is not a web address.");
  // Reachable at all? A wrong address should say so now, not at sign-in.
  try {
    const metadata = await fetch(`${guessed.api}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } });
    if (!metadata.ok) throw new Error(String(metadata.status));
  } catch {
    throw new Error(`${new URL(site).host} did not answer as a g1t. Check the address, or give its API's address too.`);
  }
  return { server: guessed, known: false, push: true, chat: false };
}
