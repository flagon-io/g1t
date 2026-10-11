import type { Membership, User } from "@g1t/contracts";
import { useQueryClient } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, Client } from "./client";
import { type Credentials, clearCredentials, loadCredentials, loadServer, saveCredentials, saveServer } from "./credentials";
import { signInWithOAuth } from "./oauth";
import { unregisterPush } from "./push";
import type { Server } from "./server";

/**
 * Who is signed in, to which g1t, and in which workspace. Everything that
 * talks to g1t reads its {@link Client} from here.
 */

/** `GET /user`: the person, their workspaces, and what the token may do. */
export type Me = User & { token?: { token_id: string; scopes?: string[] } };

type State =
  | { status: "loading"; server: Server | null }
  | { status: "signed-out"; server: Server }
  | { status: "signed-in"; server: Server; client: Client; me: Me; workspace: Membership | null };

type SignedInState = Extract<State, { status: "signed-in" }>;

type SessionApi = {
  state: State;
  /**
   * The last signed-in state, kept through signing out: the signed-in
   * screens render once more as they leave, and read it then.
   */
  lastSignedIn: SignedInState | null;
  /** Opens the site to approve the app, then signs in. */
  signIn: () => Promise<void>;
  /** Signs in with a personal access token (`g1t_…`). */
  signInWithToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Points the app at another g1t; signs out of the one before. */
  changeServer: (server: Server) => Promise<void>;
  /** Switches workspace by slug. */
  selectWorkspace: (slug: string) => Promise<void>;
};

const WORKSPACE_KEY = "g1t.workspace";

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading", server: null });
  const queries = useQueryClient();
  const serverRef = useRef<Server | null>(null);
  const lastSignedIn = useRef<SignedInState | null>(null);
  if (state.status === "signed-in") lastSignedIn.current = state;

  const signedOut = useCallback(
    async (server: Server) => {
      await clearCredentials();
      queries.clear();
      setState({ status: "signed-out", server });
    },
    [queries],
  );

  /** Makes a client for credentials, reads who they are, and signs in. */
  const start = useCallback(
    async (server: Server, credentials: Credentials) => {
      const client = new Client({
        server,
        credentials,
        onCredentials: (next) => {
          if (next === null) void signedOut(server);
        },
      });
      const me = await client.api<Me>("/user");
      if ((me.kind ?? "user") !== "user") {
        throw new ApiError("forbidden", "Sign in as yourself: a workspace's or an agent's token cannot use the app.");
      }
      const saved = await SecureStore.getItemAsync(WORKSPACE_KEY).catch(() => null);
      const workspaces = me.workspaces ?? [];
      const workspace = workspaces.find((one) => one.slug === saved) ?? workspaces[0] ?? null;
      setState({ status: "signed-in", server, client, me, workspace });
    },
    [signedOut],
  );

  useEffect(() => {
    void (async () => {
      const server = await loadServer();
      serverRef.current = server;
      const credentials = await loadCredentials();
      if (!credentials) return setState({ status: "signed-out", server });
      try {
        await start(server, credentials);
      } catch (error) {
        // Offline at launch keeps the credentials for next time; anything
        // else (revoked, expired) signs out.
        if (error instanceof ApiError && error.code === "offline") {
          setState({ status: "signed-out", server });
          return;
        }
        await signedOut(server);
      }
    })();
  }, [start, signedOut]);

  const api = useMemo<SessionApi>(() => {
    const current = () => serverRef.current ?? state.server;
    return {
      state,
      lastSignedIn: lastSignedIn.current,
      signIn: async () => {
        const server = current();
        if (!server) return;
        const credentials = await signInWithOAuth(server);
        await saveCredentials(credentials);
        await start(server, credentials);
      },
      signInWithToken: async (token) => {
        const server = current();
        if (!server) return;
        const trimmed = token.trim();
        if (!trimmed.startsWith("g1t_")) throw new ApiError("failed", "An access token starts with g1t_.");
        const credentials: Credentials = { kind: "token", accessToken: trimmed };
        await start(server, credentials);
        await saveCredentials(credentials);
      },
      signOut: async () => {
        const server = current();
        // The phone stops getting notifications first, while the token still works.
        if (state.status === "signed-in") await unregisterPush(state.client).catch(() => undefined);
        if (server) await signedOut(server);
      },
      changeServer: async (server) => {
        await saveServer(server);
        serverRef.current = server;
        await signedOut(server);
      },
      selectWorkspace: async (slug) => {
        if (state.status !== "signed-in") return;
        const workspace = state.me.workspaces?.find((one) => one.slug.toLowerCase() === slug.toLowerCase());
        if (!workspace || workspace.slug === state.workspace?.slug) return;
        await SecureStore.setItemAsync(WORKSPACE_KEY, workspace.slug);
        setState({ ...state, workspace });
      },
    };
  }, [state, start, signedOut]);

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession is used outside SessionProvider.");
  return session;
}

/** The signed-in session, for screens that only show when signed in. */
export function useSignedIn() {
  const { state, lastSignedIn, ...rest } = useSession();
  const signedIn = state.status === "signed-in" ? state : lastSignedIn;
  if (!signedIn) throw new Error("This screen needs a signed-in session.");
  return { ...signedIn, ...rest };
}
