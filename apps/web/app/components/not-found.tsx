import { EyeOff, KeyRound, UserX } from "lucide-react";
import { Form, Link, useLocation, useRouteLoaderData } from "react-router";

import type { User } from "@g1t/contracts";

import { withNext } from "../lib/next";
import { useSignUpCopy } from "../lib/registration";
import { missingKind, notFoundCopy } from "../lib/not-found";
import { Avatar, ButtonLink } from "./ui";

/**
 * The page for anything someone cannot see. It reads only the kind of thing
 * the address names and who is signed in, so a private project and a
 * missing one give the same page, word for word.
 */
export function NotFound({ data }: { data?: unknown }) {
  const { pathname, search } = useLocation();
  const user = (useRouteLoaderData("root") as { user?: User | null } | undefined)?.user ?? null;
  const kind = missingKind(data, pathname);
  const copy = notFoundCopy(kind, user?.username);
  const here = pathname + search;
  const signUp = useSignUpCopy();
  const Icon = kind === "person" ? UserX : copy.signIn ? KeyRound : EyeOff;
  return (
    <main className="mx-auto flex max-w-lg flex-col items-center px-4 py-24 text-center sm:py-32">
      <span className="flex size-11 items-center justify-center rounded-xl bg-surface text-muted ring-1 ring-line">
        <Icon size={20} />
      </span>
      <h1 className="mt-6 text-balance text-2xl font-semibold tracking-tight">{copy.title}</h1>
      {copy.body && <p className="mt-3 text-muted">{copy.body}</p>}

      {copy.signIn && (
        <>
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            <ButtonLink to={withNext("/login", here)}>Sign in</ButtonLink>
            <ButtonLink to="/explore" variant="quiet">
              Explore public projects
            </ButtonLink>
          </div>
          <p className="mt-5 text-sm text-muted">
            New to g1t?{" "}
            <Link to={withNext("/register", here)} className="font-medium text-fg underline-offset-4 hover:underline">
              {signUp.primary}
            </Link>
          </p>
        </>
      )}

      {copy.signedInAs && (
        <>
          <div className="mt-6 flex w-full flex-col items-center gap-3 rounded-lg bg-surface px-4 py-4 text-sm ring-1 ring-line">
            <p className="flex items-center gap-2 text-muted">
              <Avatar name={copy.signedInAs} image={user?.avatar} size={20} />
              Signed in as <span className="font-mono font-medium text-fg">@{copy.signedInAs}</span>
            </p>
            {/* Signing out, then in again, comes back here. */}
            <Form method="post" action={`/logout?next=${encodeURIComponent(withNext("/login", here))}`}>
              <span className="text-faint">Not you? </span>
              <button type="submit" className="font-medium text-fg underline-offset-4 hover:underline">
                Switch account
              </button>
            </Form>
          </div>
          {copy.askOwner && (
            <p className="mt-4 text-sm text-muted">
              If you should have access, ask an owner of the workspace to add you.
            </p>
          )}
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            <ButtonLink to="/">Back to Mission control</ButtonLink>
            <ButtonLink to="/explore" variant="quiet">
              Explore
            </ButtonLink>
          </div>
        </>
      )}

      {kind === "person" && (
        <div className="mt-8 flex flex-wrap justify-center gap-2">
          <ButtonLink to="/search?type=people">Search people</ButtonLink>
          <ButtonLink to="/explore" variant="quiet">
            Explore
          </ButtonLink>
        </div>
      )}
    </main>
  );
}
