import { Check, KeyRound, X } from "lucide-react";
import { Form, Link, useSearchParams } from "react-router";

import type { MemberToken, TokenKind } from "@g1t/contracts";

import type { Route } from "./+types/personal-access-tokens";
import { page } from "../../lib/meta";
import { Avatar, EmptyState, ErrorText, Input, SubmitButton, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { SwitchCard } from "../../components/ui/switch";
import { AccessSummary } from "../../components/token-scopes";
import { identity } from "../../lib/services.server";
import { describeExpiry } from "../../lib/token-scopes";
import { lifetimeFromForm, permissionChips, reachSummary, statusBadge } from "../../lib/fine-grained";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";
import { cn } from "../../lib/cn";

// A workspace's rules for its members' personal access tokens, the tokens
// that reach it, and approving fine-grained ones. Owners only; identity
// decides (services/identity/src/token_reach.rs).

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Personal access tokens · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, params.owner);
  if (!viewer || role !== "owner") return { slug, role, policy: null, tokens: [] as MemberToken[] };
  const [policy, tokens] = await Promise.all([identity.getTokenPolicy(slug, viewer), identity.listMemberTokens(viewer, slug)]);
  return { slug, role, policy: unwrap(policy), tokens: unwrap(tokens) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const slug = params.owner;
  const id = String(form.get("id") ?? "");
  const reason = String(form.get("reason") ?? "").trim() || null;
  switch (form.get("intent")) {
    case "policy": {
      const lifetime = lifetimeFromForm(form.get("max_lifetime_days"));
      if (!lifetime.ok) return { error: lifetime.error, saved: false };
      const saved = await identity.setTokenPolicy(user, slug, {
        allowClassic: form.get("allow_classic") === "on",
        allowFineGrained: form.get("allow_fine_grained") === "on",
        requireApproval: form.get("require_approval") === "on",
        maxLifetimeDays: lifetime.value ?? 0,
        forbidNoExpiry: form.get("forbid_no_expiry") === "on",
      });
      return saved.ok ? { error: null, saved: true } : { error: saved.error.message, saved: false };
    }
    case "approve":
    case "deny": {
      const reviewed = await identity.reviewTokenRequest(user, slug, id, form.get("intent") === "approve", reason);
      return reviewed.ok ? { error: null, saved: false } : { error: reviewed.error.message, saved: false };
    }
    case "revoke": {
      const revoked = await identity.revokeMemberToken(user, slug, id, reason);
      return revoked.ok ? { error: null, saved: false } : { error: revoked.error.message, saved: false };
    }
  }
  return null;
}

const LIFETIMES = [
  ["", "No limit"],
  ["7", "7 days"],
  ["30", "30 days"],
  ["60", "60 days"],
  ["90", "90 days"],
  ["180", "180 days"],
  ["366", "1 year"],
] as const;

export default function PersonalAccessTokens({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, role, policy, tokens } = loaderData;
  const [params] = useSearchParams();
  if (role !== "owner" || !policy) {
    return (
      <EmptyState title="Owners only">
        Only an owner of {slug} can see which personal access tokens reach it. Your own tokens are under{" "}
        <Link to="/settings/tokens" className="text-fg underline underline-offset-4">
          your settings
        </Link>
        .
      </EmptyState>
    );
  }
  const pending = tokens.filter((member) => member.token.fineGrained?.status === "pending");
  const kind = (params.get("kind") as TokenKind | null) ?? null;
  const listed = tokens.filter((member) => member.token.fineGrained?.status !== "pending" && (!kind || member.token.kind === kind));
  const lifetime = policy.maxLifetimeDays == null ? "" : String(policy.maxLifetimeDays);
  return (
    <div className="max-w-3xl space-y-10">
      <section aria-labelledby="pat-rules">
        <h2 id="pat-rules" className="font-medium">
          Rules
        </h2>
        <p className="mt-1 text-sm text-muted">
          They apply from each token's next request, to tokens made before them too. A token they keep out still works
          elsewhere, and reads {slug}'s public repositories as anyone can.
        </p>
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="policy" />
          <SwitchCard name="allow_fine_grained" defaultChecked={policy.allowFineGrained} title="Allow fine-grained personal access tokens">
            Members may make tokens that name {slug} as their resource owner, reaching only the repositories and
            permissions they choose.
          </SwitchCard>
          <SwitchCard name="require_approval" defaultChecked={policy.requireApproval} title="Require approval of fine-grained tokens">
            A member's fine-grained token waits for an owner to approve it, and again when they widen it. Owners' own
            tokens never wait.
          </SwitchCard>
          <SwitchCard name="allow_classic" defaultChecked={policy.allowClassic} title="Allow classic personal access tokens">
            Classic tokens reach every workspace their owner belongs to. Off: they no longer reach {slug}.
          </SwitchCard>
          <SwitchCard name="forbid_no_expiry" defaultChecked={policy.forbidNoExpiry} title="Tokens must expire">
            A token that never expires does not reach {slug}.
          </SwitchCard>
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
            <label htmlFor="pat-lifetime" className="min-w-0">
              <span className="block text-sm font-medium text-fg">Longest lifetime</span>
              <span className="mt-1 block text-sm text-muted">A token that lasts longer does not reach {slug}.</span>
            </label>
            <select
              id="pat-lifetime"
              name="max_lifetime_days"
              defaultValue={LIFETIMES.some(([value]) => value === lifetime) ? lifetime : ""}
              className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm sm:w-40"
            >
              {LIFETIMES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <SubmitButton match={{ intent: "policy" }} pending="Saving…">
              Save rules
            </SubmitButton>
            {actionData?.saved && <span className="text-sm text-success">Saved.</span>}
            {policy.updatedBy && (
              <span className="text-xs text-faint">
                Last changed by <span className="font-mono">{policy.updatedBy}</span>
                {policy.updatedAt && (
                  <>
                    {" "}
                    <TimeAgo at={policy.updatedAt} />
                  </>
                )}
              </span>
            )}
          </div>
        </Form>
      </section>

      <ErrorText>{actionData?.error}</ErrorText>

      <section aria-labelledby="pat-requests">
        <h2 id="pat-requests" className="flex items-center gap-2 font-medium">
          Waiting for approval
          {pending.length > 0 && <Badge tone="warn">{pending.length}</Badge>}
        </h2>
        {pending.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No fine-grained token is waiting for approval.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
            {pending.map((member) => (
              <li key={member.token.id} className="px-4 py-3">
                <TokenLine member={member} />
                <Form method="post" className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input type="hidden" name="id" value={member.token.id} />
                  <div className="min-w-0 grow">
                    <Input name="reason" maxLength={500} placeholder="Note for the owner (optional)" aria-label="Note for the token's owner" />
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <SubmitButton name="intent" value="approve" match={{ intent: "approve", id: member.token.id }} pending="Approving…">
                      <Check size={14} /> Approve
                    </SubmitButton>
                    <SubmitButton name="intent" value="deny" variant="quiet" match={{ intent: "deny", id: member.token.id }} pending="Denying…">
                      <X size={14} /> Deny
                    </SubmitButton>
                  </div>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="pat-active">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="pat-active" className="font-medium">
            Tokens that can reach {slug}
          </h2>
          <nav aria-label="Kind" className="flex gap-1 text-xs">
            {(
              [
                [null, "All"],
                ["fine_grained", "Fine-grained"],
                ["classic", "Classic"],
              ] as const
            ).map(([value, label]) => (
              <Link
                key={label}
                to={value ? `?kind=${value}` : "?"}
                preventScrollReset
                aria-current={kind === value ? "page" : undefined}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 transition-colors",
                  kind === value ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg",
                )}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <p className="mt-1 text-sm text-muted">
          Members' and outside collaborators' tokens, never the tokens themselves. The workspace's own tokens are under{" "}
          <Link to={`/${slug}/-/tokens`} className="text-fg underline underline-offset-4">
            Access tokens
          </Link>
          .
        </p>
        {listed.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No tokens">No member has a personal access token of this kind that can reach {slug}.</EmptyState>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
            {listed.map((member) => (
              <li key={member.token.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
                <div className="min-w-0 grow">
                  <TokenLine member={member} />
                </div>
                {member.token.fineGrained?.status !== "revoked" && !(member.blockedBy === "revoked") && (
                  <Form method="post" className="shrink-0">
                    <input type="hidden" name="intent" value="revoke" />
                    <input type="hidden" name="id" value={member.token.id} />
                    <SubmitButton variant="quiet" match={{ intent: "revoke", id: member.token.id }} pending="Revoking…">
                      Revoke
                    </SubmitButton>
                  </Form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One member's token: whose, what it is, what it reaches and may do. */
function TokenLine({ member }: { member: MemberToken }) {
  const { token } = member;
  const fine = token.kind === "fine_grained";
  const badge = statusBadge(token.fineGrained?.status);
  const expiry = describeExpiry(token.expiresAt);
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <Avatar name={member.owner} size={18} />
        <Link to={`/u/${member.owner}`} className="font-mono text-fg hover:underline">
          {member.owner}
        </Link>
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <KeyRound size={13} className="shrink-0 text-faint" />
          <span className="truncate">{token.name}</span>
        </span>
        <Badge tone={fine ? "accent" : "neutral"}>{fine ? "Fine-grained" : "Classic"}</Badge>
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        {!badge && !member.reaches && member.blockedBy && <Badge tone="danger">Kept out: {member.blockedBy}</Badge>}
      </p>
      {token.description && <p className="text-xs text-muted">{token.description}</p>}
      <p className="text-xs text-faint">
        Created <TimeAgo at={token.createdAt} /> ·{" "}
        {token.lastUsedAt ? (
          <>
            last used <TimeAgo at={token.lastUsedAt} />
          </>
        ) : (
          "never used"
        )}{" "}
        · <span className={expiry === "No expiry" ? "text-warn" : undefined}>{expiry}</span>
        {fine && <> · {reachSummary(token)}</>}
      </p>
      {fine ? (
        <div className="flex flex-wrap gap-1.5">
          {permissionChips(token.fineGrained?.permissions).map((chip) => (
            <span key={chip} className="rounded border border-line px-1.5 py-px text-[0.6875rem] text-muted">
              {chip}
            </span>
          ))}
        </div>
      ) : (
        <AccessSummary holder={token} className="mt-0" />
      )}
      {fine && token.fineGrained?.repositorySelection === "selected" && token.fineGrained.repositories.length > 0 && (
        <p className="truncate font-mono text-[0.6875rem] text-faint">{token.fineGrained.repositories.join(", ")}</p>
      )}
    </div>
  );
}
