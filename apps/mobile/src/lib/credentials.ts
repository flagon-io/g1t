import * as SecureStore from "expo-secure-store";

import { HOSTED, type Server } from "./server";

/**
 * What the app keeps between launches, in the phone's keystore (Android
 * Keystore, the iOS keychain): the server, and how it is signed in.
 *
 * Two ways to be signed in:
 * - `oauth`: the app's own sign-in (lib/oauth.ts). An access token that
 *   lasts 30 days and a refresh token that works once and returns the
 *   next pair, as every OAuth client of g1t's gets.
 * - `token`: a personal access token pasted in, for a g1t whose OAuth
 *   tokens do not yet open Chat (see the README) or for testing. One with
 *   "Use the website as you" turned on opens everything the app shows.
 */
export type Credentials =
  | {
      kind: "oauth";
      accessToken: string;
      refreshToken: string;
      /** Epoch milliseconds. */
      expiresAt: number;
      /** The scopes the person granted, or `*` for full access. */
      scope: string;
      /**
       * The client id it was issued to: a refresh must name the same one.
       * Kept, because in Expo Go the id follows the computer's address,
       * which changes between sessions (lib/oauth.ts).
       */
      clientId?: string;
    }
  | { kind: "token"; accessToken: string };

const SERVER_KEY = "g1t.server";
const CREDENTIALS_KEY = "g1t.credentials";

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const text = await SecureStore.getItemAsync(key);
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    // Unreadable (a restore to another phone, a keystore reset): start over.
    return null;
  }
}

export async function loadServer(): Promise<Server> {
  const saved = await readJson<Server>(SERVER_KEY);
  return saved?.site && saved?.api ? saved : HOSTED;
}

export async function saveServer(server: Server): Promise<void> {
  await SecureStore.setItemAsync(SERVER_KEY, JSON.stringify(server));
}

export async function loadCredentials(): Promise<Credentials | null> {
  return readJson<Credentials>(CREDENTIALS_KEY);
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(credentials));
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
}
