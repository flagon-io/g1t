import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { data, Link, redirect, useLocation } from "react-router";

import { type AdminOwner, type Limit, httpStatus } from "@g1t/contracts";

import type { Route } from "./+types/enterprise";
import { AuditSection, CreditForm, Figure, LedgerSection, ReviewPanel, TermsForm } from "~/components/billing";
import { Avatar, Badge, Button, EmptyState, ExposureBar, Field, Input, Notice, Section, StateBadge, TermsBadge, TrustBadge, When } from "~/components/ui";
import { type Subject, billingAction } from "~/lib/billing-actions.server";
import { usd } from "~/lib/money";
import { type ActionData, type SectionError, doneMessage } from "~/lib/review";
import { admin, identity } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";
import { legacyAccountPath } from "~/lib/workspaces";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData?.detail.summary.account.name ?? "Enterprise"} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

const ENTERPRISE_ID = /^ent_[a-z0-9_-]{1,80}$/;

async function load(raw: string) {
  const id = raw.trim().toLowerCase();
  if (!ENTERPRISE_ID.test(id)) {
    // A workspace's id or slug: its own page.
    const path = legacyAccountPath(id);
    if (path) throw redirect(path);
    throw data("That is not an enterprise.", { status: 404 });
  }
  const result = await admin.account(id);
  if (!result.ok) throw data(result.error.message, { status: httpStatus(result.error) });
  const detail = result.value;
  const { account } = detail.summary;
  if (account.kind !== "enterprise") throw data("That is not an enterprise.", { status: 404 });
  const subject: Subject = { kind: "enterprise", accountId: account.id, name: account.name, terms: account.terms, workspaces: account.workspaces };
  return { detail, subject };
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  requireStaff(context);
  const { detail } = await load(params.id);
  const slugs = detail.summary.account.workspaces;
  const listed = await identity.workspaces();
  const people = new Map(listed.map((workspace) => [workspace.slug, { name: workspace.name, owners: workspace.owners }]));
  // Members older than identity's list: look them up one by one.
  const missing = slugs.filter((slug) => !people.has(slug)).slice(0, 25);
  for (const found of await Promise.all(missing.map((slug) => identity.workspace(slug)))) {
    if (found) {
      people.set(found.slug, {
        name: found.name,
        owners: found.members.filter((member) => member.role === "owner").map(({ username, email }) => ({ username, email })),
      });
    }
  }
  const limits = new Map(detail.workspaces.map((limit) => [limit.workspace, limit]));
  const shares = new Map((detail.summary.byWorkspace ?? []).map((share) => [share.workspace, share]));
  const members = slugs.map((slug) => ({
    slug,
    name: people.get(slug)?.name ?? null,
    owners: people.get(slug)?.owners ?? ([] as AdminOwner[]),
    limit: limits.get(slug) ?? null,
    chargedMicros: shares.get(slug)?.chargedMicros ?? 0,
  }));
  return { detail, members, done: doneMessage(request.url) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  // What is acted on comes from billing, not from the form.
  const { subject } = await load(params.id);
  return billingAction(request, staff, subject, `/enterprises/${encodeURIComponent(subject.accountId)}`);
}

type Member = Route.ComponentProps["loaderData"]["members"][number];

export default function Enterprise({ loaderData, actionData }: Route.ComponentProps) {
  const { detail, members, done } = loaderData;
  const { summary } = detail;
  const { account, limit } = summary;
  const { pathname } = useLocation();
  const result = actionData as ActionData | undefined;
  const review = result && "review" in result ? result.review : null;
  const error = (section: string): SectionError => (result && "error" in result && result.section === section ? result : null);

  return (
    <main id="top" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-8 sm:py-10">
      <Link to="/enterprises" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Enterprises
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar name={account.name} size={40} />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{account.name}</h1>
            <p className="mt-0.5 text-xs text-faint">
              Enterprise since <When at={account.createdAt} /> · pays for {members.length} workspace{members.length === 1 ? "" : "s"}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="lavender">Enterprise</Badge>
              <TermsBadge terms={account.terms} />
              {account.terms.kind !== "comped" && <TrustBadge trust={limit.trust} />}
              <StateBadge state={limit.state} />
            </div>
          </div>
        </div>
        <p className="text-xs text-faint">
          Billing account id <span className="font-mono">{account.id}</span>
        </p>
      </div>

      <div className="mt-6 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {error("top") && <Notice tone="error">{error("top")?.error}</Notice>}
        {limit.message && <Notice tone={limit.state === "stopped" ? "error" : limit.state === "warning" ? "warn" : "info"}>{limit.message}</Notice>}
        {review && <ReviewPanel review={review} pathname={pathname} />}
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-line bg-surface px-4 py-3 sm:col-span-2">
          <p className="mb-2 text-xs text-muted">Usage this month against the limit, all workspaces together</p>
          <ExposureBar limit={limit} wide />
          <p className="mt-2 text-xs text-faint">
            Limit from trust {usd(limit.trustCeilingMicros)}
            {account.terms.ceilingMicros != null && <> · custom limit {usd(account.terms.ceilingMicros)}</>}
          </p>
        </div>
        <Figure label="Charged this month" value={usd(summary.chargedMicros)} hint={`Cost to g1t ${usd(summary.costMicros)}`} />
        <Figure label="Paid ever" value={usd(summary.paidMicros)} hint={`Margin this month ${usd(summary.chargedMicros - summary.costMicros)}`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <MembersSection members={members} pathname={pathname} error={error("members")} />
          <TermsForm terms={account.terms} pathname={pathname} error={error("terms")} />
          <LedgerSection ledger={detail.ledger} showWorkspace description="Recent lines for every workspace it pays for, newest first." />
        </div>
        <div className="space-y-6">
          <CreditForm workspaces={account.workspaces} pathname={pathname} error={error("credit")} />
          <AuditSection audit={detail.audit} />
        </div>
      </div>
    </main>
  );
}

function MembersSection({ members, pathname, error }: { members: Member[]; pathname: string; error: SectionError }) {
  return (
    <Section id="members" title="Workspaces" description="Billed together: one bill, one limit, one set of terms.">
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error.error}</Notice>
        </div>
      )}
      {members.length === 0 ? (
        <EmptyState title="No workspaces yet">Add one below to bill it to this enterprise.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {members.map((member) => (
            <li key={member.slug} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 grow items-start gap-2.5">
                <Avatar name={member.slug} size={22} />
                <div className="min-w-0">
                  <Link to={`/workspaces/${encodeURIComponent(member.slug)}`} className="font-medium hover:underline hover:underline-offset-4">
                    {member.name ?? member.slug}
                  </Link>
                  <p className="truncate text-xs text-faint">
                    <span className="font-mono">{member.slug}</span>
                    {member.owners.length > 0 && (
                      <>
                        {" · "}
                        {member.owners.map((owner, index) => (
                          <span key={owner.username} title={owner.email ?? "No email"}>
                            {index > 0 && ", "}
                            {owner.username}
                          </span>
                        ))}
                      </>
                    )}
                  </p>
                  {member.limit?.message && <p className="mt-1 text-xs text-muted">{member.limit.message}</p>}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 sm:w-56 sm:justify-end">
                <p className="tabular text-right text-xs text-muted">
                  Charged <span className="text-fg-soft">{usd(member.chargedMicros)}</span>
                  {member.limit && <MemberState limit={member.limit} />}
                </p>
                <DetachButton workspace={member.slug} pathname={pathname} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <form method="post" action={`${pathname}#review`} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <input type="hidden" name="intent" value="attach" />
        <Field label="Add a workspace" className="grow">
          <Input name="workspace" required placeholder="workspace-slug" defaultValue={error?.values?.workspace ?? ""} className="font-mono" />
        </Field>
        <Button type="submit" variant="quiet">
          <Plus size={14} />
          Add
        </Button>
      </form>
    </Section>
  );
}

function MemberState({ limit }: { limit: Limit }) {
  if (limit.state === "ok") return null;
  return (
    <span className="mt-1 block">
      <StateBadge state={limit.state} />
    </span>
  );
}

function DetachButton({ workspace, pathname }: { workspace: string; pathname: string }) {
  return (
    <form method="post" action={`${pathname}#review`} className="shrink-0">
      <input type="hidden" name="intent" value="detach" />
      <input type="hidden" name="workspace" value={workspace} />
      <button
        type="submit"
        aria-label={`Remove ${workspace}`}
        title={`Remove ${workspace}`}
        className="rounded-md border border-line p-2 text-muted transition-colors hover:border-danger/50 hover:text-danger"
      >
        <Trash2 size={14} />
      </button>
    </form>
  );
}
