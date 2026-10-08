import { identity, repos } from "../../lib/services.server";
import { Form, Link, redirect, useSearchParams } from "react-router";

import { presetScopes, type AccessToken } from "@g1t/contracts";

import type { Route } from "./+types/tokens";
import { page } from "../../lib/meta";
import {
  SubmitButton,
  ButtonLink,
  ErrorText,
  Field,
  Input,
  TimeAgo,
} from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { DeleteButton } from "../../components/account-settings";
import { FineGrainedForm, type OwnerChoice } from "../../components/fine-grained-form";
import {
  AccessSummary,
  ExpiryField,
  ScopeChecklist,
} from "../../components/token-scopes";
import {
  describeExpiry,
  expiryTtl,
  grantFromForm,
} from "../../lib/token-scopes";
import { fineGrainedFromForm, permissionChips, reachSummary, statusBadge } from "../../lib/fine-grained";
import { assertSameOrigin, requireUser } from "../../lib/session.server";
import { cn } from "../../lib/cn";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Access tokens · Settings · g1t" });
}

type Tab = "fine-grained" | "classic";

function tabOf(value: string | null): Tab {
  return value === "classic" ? "classic" : "fine-grained";
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const memberships = user.workspaces ?? [];
  // Each workspace you belong to, with its rules for tokens and the
  // repositories you can choose from.
  const [tokens, owners] = await Promise.all([
    identity.listAccessTokens(user),
    Promise.all(
      memberships.map(async (membership): Promise<OwnerChoice> => {
        const [policy, listed] = await Promise.all([
          identity.getTokenPolicy(membership.slug, user),
          repos.list(user, { namespace: membership.slug }).catch(() => []),
        ]);
        return {
          slug: membership.slug,
          owner: membership.role === "owner",
          policy: policy.ok ? policy.value : null,
          repos: listed.map((repo) => `${repo.namespace}/${repo.name}`).sort(),
        };
      }),
    ),
  ]);
  return { user, tokens, owners };
}

type ActionResult = {
  newToken: string | null;
  created: AccessToken | null;
  error: string | null;
  editing: string | null;
};

const failed = (error: string, editing: string | null = null): ActionResult => ({ newToken: null, created: null, error, editing });

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult | null> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  switch (form.get("intent")) {
    case "add-token": {
      const grant = grantFromForm(form);
      if (!grant.ok) return failed(grant.error);
      const created = await identity.createAccessToken(
        user,
        String(form.get("label") ?? ""),
        expiryTtl(form.get("expires")),
        { ...grant.value, listed: true },
      );
      return { newToken: created.token, created: created.info, error: null, editing: null };
    }
    case "add-fine-grained": {
      const input = fineGrainedFromForm(form);
      if (!input.ok) return failed(input.error);
      const created = await identity.createFineGrainedToken(user, input.value);
      if (!created.ok) return failed(created.error.message);
      return { newToken: created.value.token, created: created.value.info, error: null, editing: null };
    }
    case "update-token": {
      const id = String(form.get("id") ?? "");
      const grant = grantFromForm(form);
      if (!grant.ok) return failed(grant.error, id);
      const updated = await identity.updateAccessToken(user, id, grant.value);
      if (!updated.ok) return failed(updated.error.message, id);
      throw redirect("/settings/tokens?tab=classic");
    }
    case "update-fine-grained": {
      const id = String(form.get("id") ?? "");
      const input = fineGrainedFromForm(form, { editing: true });
      if (!input.ok) return failed(input.error, id);
      const { name, description, repositorySelection, repositories, permissions } = input.value;
      const updated = await identity.updateFineGrainedToken(user, id, {
        name: name || undefined,
        description: description ?? "",
        repositorySelection,
        repositories,
        permissions,
      });
      if (!updated.ok) return failed(updated.error.message, id);
      throw redirect("/settings/tokens");
    }
    case "delete-token":
      await identity.removeAccessToken(user, String(form.get("id") ?? ""));
      return null;
  }
  return null;
}

export default function TokenSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { user, tokens, owners } = loaderData;
  const [params] = useSearchParams();
  const created = actionData?.created ?? null;
  const tab: Tab = created ? (created.kind === "fine_grained" ? "fine-grained" : "classic") : tabOf(params.get("tab"));
  const fine = tokens.filter((token) => token.kind === "fine_grained");
  const classic = tokens.filter((token) => token.kind !== "fine_grained");
  const workspaces = (user.workspaces ?? []).map((membership) => membership.slug);
  return (
    <section id="tokens" className="scroll-mt-20">
      <nav aria-label="Kinds of token" className="mb-5 flex gap-1 border-b border-line">
        {(
          [
            ["fine-grained", "Fine-grained tokens", fine.length],
            ["classic", "Tokens (classic)", classic.length],
          ] as const
        ).map(([id, label, count]) => (
          <Link
            key={id}
            to={id === "classic" ? "?tab=classic" : "?"}
            preventScrollReset
            aria-current={tab === id ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-3 pb-2.5 text-sm whitespace-nowrap transition-colors",
              tab === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {label}
            {count > 0 && <span className="rounded-full bg-raised px-1.5 py-px text-xs text-muted">{count}</span>}
          </Link>
        ))}
      </nav>

      {actionData?.newToken && created && (
        <div className="mb-5 rounded-md border border-accent/40 bg-surface p-4">
          <p className="text-sm">
            <span className="font-medium">{created.name}</span> is ready. Copy it now. It will not be shown again.
          </p>
          <pre className="mt-2 font-mono text-sm break-all whitespace-pre-wrap text-accent">{actionData.newToken}</pre>
          {created.kind === "fine_grained" ? <FineGrainedSummary token={created} /> : <AccessSummary holder={created} className="mt-3" />}
          <p className="mt-1.5 text-xs text-faint">{describeExpiry(created.expiresAt)}</p>
        </div>
      )}

      {tab === "fine-grained" ? (
        <FineGrainedTokens tokens={fine} owners={owners} actionData={actionData ?? null} />
      ) : (
        <ClassicTokens tokens={classic} workspaces={workspaces} actionData={actionData ?? null} />
      )}
    </section>
  );
}

/** A fine-grained token's reach, permissions and status, under its name. */
function FineGrainedSummary({ token }: { token: AccessToken }) {
  const badge = statusBadge(token.fineGrained?.status);
  return (
    <div className="mt-1.5 space-y-1.5">
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Badge tone="accent">Fine-grained</Badge>
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        <span>{reachSummary(token)}</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {permissionChips(token.fineGrained?.permissions).map((chip) => (
          <span key={chip} className="rounded border border-line px-1.5 py-px text-[0.6875rem] text-muted">
            {chip}
          </span>
        ))}
      </div>
      {token.fineGrained?.repositorySelection === "selected" && token.fineGrained.repositories.length > 0 && (
        <p className="truncate font-mono text-[0.6875rem] text-faint">{token.fineGrained.repositories.join(", ")}</p>
      )}
      {token.fineGrained?.reviewReason && (
        <p className="text-xs text-faint">Owner's note: {token.fineGrained.reviewReason}</p>
      )}
    </div>
  );
}

function Meta({ token }: { token: AccessToken }) {
  const expiry = describeExpiry(token.expiresAt);
  return (
    <p className="text-xs text-faint">
      Created <TimeAgo at={token.createdAt} /> ·{" "}
      {token.lastUsedAt ? (
        <>
          last used <TimeAgo at={token.lastUsedAt} />
        </>
      ) : (
        "never used"
      )}{" "}
      · <span className={expiry === "Expired" ? "text-danger" : undefined}>{expiry}</span>
    </p>
  );
}

function FineGrainedTokens({
  tokens,
  owners,
  actionData,
}: {
  tokens: AccessToken[];
  owners: OwnerChoice[];
  actionData: ActionResult | null;
}) {
  const [params] = useSearchParams();
  const editing = actionData?.editing ?? params.get("edit");
  const created = actionData?.created;
  return (
    <>
      <p className="text-sm text-muted">
        A fine-grained token reaches one resource owner (one workspace, or your own account), only the repositories
        you choose, and only with the permissions you give it. It always expires.
      </p>
      <ul className="mt-4 divide-y divide-line rounded-md border border-line empty:hidden">
        {tokens.map((token) => (
          <li key={token.id} className="px-4 py-3">
            <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
              <div className="min-w-0 grow basis-60">
                <p className="truncate text-sm font-medium">{token.name}</p>
                {token.description && <p className="truncate text-xs text-muted">{token.description}</p>}
                <Meta token={token} />
                <FineGrainedSummary token={token} />
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {editing !== token.id && (
                  <ButtonLink variant="quiet" to={`?edit=${token.id}`} preventScrollReset>
                    Edit
                  </ButtonLink>
                )}
                <DeleteButton intent="delete-token" id={token.id} />
              </div>
            </div>
            {editing === token.id && (
              <Form method="post" className="mt-4 space-y-5 border-t border-line pt-4">
                <input type="hidden" name="intent" value="update-fine-grained" />
                <input type="hidden" name="id" value={token.id} />
                <p className="text-sm text-muted">
                  The token stays the same; what it reaches changes from its next request. A workspace that approves
                  tokens asks again when you widen it.
                </p>
                <FineGrainedForm owners={owners} editing={token} />
                <ErrorText>{actionData?.editing === token.id ? actionData.error : null}</ErrorText>
                <div className="flex gap-2">
                  <SubmitButton pending="Saving…" match={{ intent: "update-fine-grained", id: token.id }}>
                    Save
                  </SubmitButton>
                  <ButtonLink variant="quiet" to="." preventScrollReset>
                    Cancel
                  </ButtonLink>
                </div>
              </Form>
            )}
          </li>
        ))}
      </ul>
      {!editing && (
        <Form key={created?.id ?? "new"} method="post" className="mt-8 space-y-5 rounded-md border border-line p-4 sm:p-5">
          <input type="hidden" name="intent" value="add-fine-grained" />
          <h2 className="font-medium">New fine-grained token</h2>
          <FineGrainedForm owners={owners} />
          {!actionData?.editing && <ErrorText>{actionData?.error}</ErrorText>}
          <SubmitButton pending="Generating…" match={{ intent: "add-fine-grained" }}>
            Generate token
          </SubmitButton>
        </Form>
      )}
    </>
  );
}

function ClassicTokens({
  tokens,
  workspaces,
  actionData,
}: {
  tokens: AccessToken[];
  workspaces: string[];
  actionData: ActionResult | null;
}) {
  const [params] = useSearchParams();
  const editing = actionData?.editing ?? params.get("edit");
  const created = actionData?.created;
  return (
    <>
      <p className="text-sm text-muted">
        A classic token reaches every workspace and repository you can, and its scopes say what it may do there. A
        workspace can keep classic tokens out.
        {workspaces.length > 0 && (
          <>
            {" "}
            For CI and integrations that work for a team, use a workspace's own tokens instead:{" "}
            {workspaces.map((slug, i) => (
              <span key={slug}>
                {i > 0 && ", "}
                <Link to={`/${slug}/-/tokens`} className="font-mono text-fg underline underline-offset-4">
                  {slug}
                </Link>
              </span>
            ))}
            .
          </>
        )}
      </p>
      <ul className="mt-4 divide-y divide-line rounded-md border border-line empty:hidden">
        {tokens.map((token) => (
          <ClassicRow
            key={token.id}
            token={token}
            editing={editing === token.id}
            error={actionData?.editing === token.id ? actionData.error : null}
          />
        ))}
      </ul>

      {!editing && (
        // Keyed on the token just made, so the fields start over for the next.
        <Form key={created?.id ?? "new"} method="post" className="mt-8 space-y-5 rounded-md border border-line p-4 sm:p-5">
          <input type="hidden" name="intent" value="add-token" />
          <h2 className="font-medium">New classic token</h2>
          <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
            <Field label="Name" hint="Name it after what will use it.">
              <Input name="label" maxLength={100} placeholder="laptop" required />
            </Field>
            <ExpiryField />
          </div>
          <ScopeChecklist initial={presetScopes("agent")} />
          {!actionData?.editing && <ErrorText>{actionData?.error}</ErrorText>}
          <SubmitButton pending="Creating…" match={{ intent: "add-token" }}>
            Create token
          </SubmitButton>
        </Form>
      )}
    </>
  );
}

function ClassicRow({
  token,
  editing,
  error,
}: {
  token: AccessToken;
  editing: boolean;
  error: string | null | undefined;
}) {
  const legacy = token.legacy && token.scopes === null;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 grow basis-60">
          <p className="truncate text-sm font-medium">{token.name}</p>
          <Meta token={token} />
          <AccessSummary holder={token} />
          {legacy && (
            <p className="mt-1.5 text-xs text-warn">
              Made before tokens had scopes, so it can do everything you can.
              Narrow it to what it needs.
            </p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!editing && (
            <ButtonLink
              variant="quiet"
              to={`?tab=classic&edit=${token.id}`}
              preventScrollReset
            >
              {legacy ? "Narrow this token" : "Edit access"}
            </ButtonLink>
          )}
          <DeleteButton intent="delete-token" id={token.id} />
        </div>
      </div>
      {editing && (
        <Form
          method="post"
          className="mt-4 space-y-5 border-t border-line pt-4"
        >
          <input type="hidden" name="intent" value="update-token" />
          <input type="hidden" name="id" value={token.id} />
          <p className="text-sm text-muted">
            The token stays the same; only what it may do changes, from its next
            request.
          </p>
          <ScopeChecklist initial={token.scopes} />
          <ErrorText>{error}</ErrorText>
          <div className="flex gap-2">
            <SubmitButton pending="Saving…" match={{ intent: "update-token", id: token.id }}>
              Save access
            </SubmitButton>
            <ButtonLink variant="quiet" to="?tab=classic" preventScrollReset>
              Cancel
            </ButtonLink>
          </div>
        </Form>
      )}
    </li>
  );
}
