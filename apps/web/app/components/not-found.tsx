import { Form, Link, useLocation, useRouteLoaderData } from "react-router";

import type { Membership, User } from "@g1t/contracts";

import { withNext } from "../lib/next";
import { useSignUpCopy } from "../lib/registration";
import { missingKind, notFoundCopy } from "../lib/not-found";
import { PageMain } from "./landmark";
import { Pixel404 } from "./logo";
import { ButtonLink, SubmitButton } from "./ui";

/**
 * The page for anything someone cannot see. It reads only the kind of thing
 * the address names and who is signed in, so a private project and a
 * missing one give the same page, word for word, and the same 404.
 */
export function NotFound({ data }: { data?: unknown }) {
  const { pathname, search } = useLocation();
  const root = useRouteLoaderData("root") as
    | { user?: User | null; shell?: { workspace?: Membership | null; repo?: { namespace: string; name: string } | null } }
    | undefined;
  const user = root?.user ?? null;
  const workspace = user ? (root?.shell?.workspace ?? null) : null;
  // Something missing inside a project the viewer can see: back to it.
  const project = root?.shell?.repo ?? null;
  const inProject =
    project != null && pathname.toLowerCase().startsWith(`/${project.namespace}/${project.name}/`.toLowerCase());
  const kind = missingKind(data, pathname);
  const copy = notFoundCopy(kind, user?.username);
  const here = pathname + search;
  const signUp = useSignUpCopy();
  return (
    <PageMain className="mx-auto flex max-w-lg flex-col items-center px-4 py-20 text-center sm:py-28">
      <Pixel404 className="text-[3.5rem] sm:text-[4.5rem]" />
      <h1 className="mt-10 text-balance text-2xl font-semibold tracking-tight">{copy.title}</h1>
      <p className="mt-2 text-balance text-muted">{copy.body}</p>

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        {copy.signIn ? (
          <ButtonLink to={withNext("/login", here)}>Sign in</ButtonLink>
        ) : kind === "person" ? (
          <ButtonLink to="/search?type=people">Search people</ButtonLink>
        ) : inProject ? (
          <ButtonLink to={`/${project.namespace}/${project.name}`}>Go to {project.name}</ButtonLink>
        ) : workspace ? (
          <ButtonLink to={`/${workspace.slug}`}>Go to {workspace.name?.trim() || workspace.slug}</ButtonLink>
        ) : user ? (
          <ButtonLink to="/">Go home</ButtonLink>
        ) : null}
        <ButtonLink to="/explore" variant="outline">
          {user ? "Explore" : "Explore public projects"}
        </ButtonLink>
      </div>

      <p className="mt-6 hidden text-sm text-faint sm:block">
        Looking for something? Press{" "}
        <kbd className="rounded bg-raised px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted ring-1 ring-line">⌘K</kbd>{" "}
        to search.
      </p>

      {copy.signIn && (
        <p className="mt-3 text-xs text-faint">
          New to g1t?{" "}
          <Link to={withNext("/register", here)} className="text-muted underline-offset-4 hover:text-fg hover:underline">
            {signUp.primary}
          </Link>
        </p>
      )}

      {copy.signedInAs && (
        // Signing out, then in again, comes back here.
        <Form
          method="post"
          action={`/logout?next=${encodeURIComponent(withNext("/login", here))}`}
          className="mt-3 text-xs text-faint"
        >
          Signed in as <span className="font-mono text-muted">@{copy.signedInAs}</span> ·{" "}
          <SubmitButton
            pending="Signing out…"
            variant="link"
            size="inline"
            className="gap-1 text-muted hover:text-fg"
          >
            Switch account
          </SubmitButton>
        </Form>
      )}
    </PageMain>
  );
}
