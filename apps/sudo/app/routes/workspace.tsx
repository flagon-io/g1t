import { ArrowLeft, Building2, LogOut } from "lucide-react";
import { data, Link, useLocation } from "react-router";

import { type AccountSummary, type AdminAction, httpStatus } from "@g1t/contracts";

import type { Route } from "./+types/workspace";
import {
  AuditSection,
  BillingLinkSection,
  CreditForm,
  Figure,
  LedgerSection,
  Owners,
  ReviewPanel,
  TermsForm,
} from "~/components/billing";
import { Avatar, Badge, Button, EmptyState, ExposureBar, Field, Notice, Section, Select, StateBadge, TermsBadge, TrustBadge, When } from "~/components/ui";
import { type Subject, billingAction } from "~/lib/billing-actions.server";
import { parseSlug } from "~/lib/forms";
import { usd } from "~/lib/money";
import { type ActionData, type SectionError, doneMessage } from "~/lib/review";
import { admin, identity } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";
import type { Enterprise } from "~/lib/workspaces";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData?.name ?? "Workspace"} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

/** Whether an audit line is about `slug`, in an enterprise's log. */
function mentions(action: AdminAction, slug: string): boolean {
  // A slug is letters, digits and hyphens, none special in a pattern.
  return new RegExp(`(^|[^a-z0-9-])${slug}($|[^a-z0-9-])`).test(action.detail.toLowerCase());
}

async function load(raw: string) {
  const parsed = parseSlug(raw);
  if (!parsed.ok) throw data("That is not a workspace slug.", { status: 404 });
  const slug = parsed.value;
  const [person, result] = await Promise.all([identity.workspace(slug), admin.account(slug)]);
  if (!result.ok) throw data(result.error.message, { status: httpStatus(result.error) });
  const detail = result.value;
  const { account } = detail.summary;
  const billedTo: Enterprise | null = account.kind === "enterprise" ? { id: account.id, name: account.name } : null;
  const known = person != null || billedTo != null || account.createdAt !== "" || detail.ledger.length > 0 || detail.audit.length > 0;
  if (!known) throw data(`There is no workspace called ${slug}.`, { status: 404 });
  const subject: Subject = { kind: "workspace", slug, accountId: account.id, terms: account.terms, billedTo };
  return { slug, person, detail, billedTo, subject };
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  requireStaff(context);
  const { slug, person, detail, billedTo, subject } = await load(params.slug);
  const { summary } = detail;
  // On an enterprise, the limit is the enterprise's and the figures are
  // this workspace's share of its bill.
  const limit = (billedTo && detail.workspaces.find((member) => member.workspace === slug)) || summary.limit;
  const share = billedTo ? summary.byWorkspace?.find((row) => row.workspace === slug) : null;
  const figures = billedTo
    ? { charged: share?.chargedMicros ?? 0, cost: share?.costMicros ?? 0, paid: share?.paidMicros ?? 0 }
    : { charged: summary.chargedMicros, cost: summary.costMicros, paid: summary.paidMicros };
  const enterprises = billedTo
    ? []
    : (await admin.accounts())
        .filter((row: AccountSummary) => row.account.kind === "enterprise")
        .map((row) => ({ id: row.account.id, name: row.account.name, members: row.account.workspaces.length }));
  return {
    slug,
    name: person?.name ?? slug,
    person,
    billedTo,
    terms: subject.terms,
    limit,
    figures,
    enterprises,
    ledger: billedTo ? detail.ledger.filter((entry) => !entry.workspace || entry.workspace === slug) : detail.ledger,
    audit: billedTo ? detail.audit.filter((entry) => mentions(entry, slug)) : detail.audit,
    done: doneMessage(request.url),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  // What is acted on comes from billing and identity, not from the form.
  const { slug, subject } = await load(params.slug);
  return billingAction(request, staff, subject, `/workspaces/${encodeURIComponent(slug)}`);
}

export default function Workspace({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, name, person, billedTo, terms, limit, figures, enterprises, ledger, audit, done } = loaderData;
  const { pathname } = useLocation();
  const result = actionData as ActionData | undefined;
  const review = result && "review" in result ? result.review : null;
  const link = result && "link" in result ? result.link : null;
  const error = (section: string): SectionError => (result && "error" in result && result.section === section ? result : null);
  const owners = person?.members.filter((member) => member.role === "owner") ?? [];

  return (
    <main id="top" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-8 sm:py-10">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Workspaces
      </Link>

      {/* Header */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar name={slug} size={40} />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
            <p className="mt-0.5 text-xs text-faint">
              <span className="font-mono">{slug}</span>
              {person && (
                <>
                  {" · "}created <When at={person.createdAt} />
                </>
              )}
            </p>
            {person?.description && <p className="mt-1 text-sm text-muted">{person.description}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {billedTo && <Badge tone="lavender">Billed to {billedTo.name}</Badge>}
              <TermsBadge terms={terms} />
              {terms.kind !== "comped" && <TrustBadge trust={limit.trust} />}
              <StateBadge state={limit.state} />
            </div>
          </div>
        </div>
        {owners.length > 0 && (
          <div className="text-xs">
            <p className="mb-1.5 text-faint">Owners</p>
            <Owners owners={owners} />
          </div>
        )}
      </div>

      <div className="mt-6 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {error("top") && <Notice tone="error">{error("top")?.error}</Notice>}
        {limit.message && <Notice tone={limit.state === "stopped" ? "error" : limit.state === "warning" ? "warn" : "info"}>{limit.message}</Notice>}
        {review && <ReviewPanel review={review} pathname={pathname} />}
      </div>

      {/* People */}
      <Section title="Members" description="Everyone in the workspace. Owners manage its members and billing." className="mt-6">
        {!person ? (
          <Notice tone="warn">Identity has no record of {slug}; only billing knows it. It may have been deleted.</Notice>
        ) : person.members.length === 0 ? (
          <EmptyState title="No members" />
        ) : (
          <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
            <table className="w-full min-w-120 text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium sm:pl-5">Member</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium sm:pr-5">Joined</th>
                </tr>
              </thead>
              <tbody>
                {person.members.map((member) => (
                  <tr key={member.username} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5 sm:pl-5">
                      <span className="inline-flex items-center gap-2 font-mono">
                        <Avatar name={member.username} size={18} square={false} />
                        {member.username}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 break-all text-muted">{member.email ?? <span className="text-faint">—</span>}</td>
                    <td className="px-4 py-2.5">{member.role === "owner" ? <Badge tone="lavender">Owner</Badge> : <Badge>Member</Badge>}</td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted sm:pr-5">
                      <When at={member.joined} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Billing */}
      <h2 className="mt-10 text-lg font-semibold tracking-tight">Billing</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-line bg-surface px-4 py-3 sm:col-span-2">
          <p className="mb-2 text-xs text-muted">
            Usage this month against the limit{billedTo && <> · shared with every workspace {billedTo.name} pays for</>}
          </p>
          <ExposureBar limit={limit} wide />
          <p className="mt-2 text-xs text-faint">
            {billedTo ? <>Limit via {billedTo.name}</> : <>Limit from trust {usd(limit.trustCeilingMicros)}</>} · owner's spend limit{" "}
            {usd(limit.spendLimitMicros)}
            {terms.ceilingMicros != null && <> · custom limit {usd(terms.ceilingMicros)}</>}
          </p>
        </div>
        <Figure label="Charged this month" value={usd(figures.charged)} hint={`Cost to g1t ${usd(figures.cost)}`} />
        <Figure label="Paid ever" value={usd(figures.paid)} hint={`Margin this month ${usd(figures.charged - figures.cost)}`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <BilledToSection billedTo={billedTo} enterprises={enterprises} pathname={pathname} error={error("billed-to")} />
          {billedTo ? (
            <Section id="terms" title="Terms" description={`Charged on ${billedTo.name}'s terms while it pays for this workspace.`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TermsBadge terms={terms} />
                <Link to={`/enterprises/${encodeURIComponent(billedTo.id)}#terms`} className="text-sm text-merged hover:underline hover:underline-offset-4">
                  Change them on {billedTo.name}
                </Link>
              </div>
            </Section>
          ) : (
            <TermsForm terms={terms} pathname={pathname} error={error("terms")} />
          )}
          <LedgerSection
            ledger={ledger}
            description={billedTo ? `This workspace's lines among ${billedTo.name}'s latest 100.` : "Recent lines of the statement, newest first."}
          />
        </div>

        <div className="space-y-6">
          <BillingLinkSection link={link} pathname={pathname} error={error("billing-link")} />
          <CreditForm workspaces={[slug]} pathname={pathname} error={error("credit")} />
          <AuditSection
            audit={audit}
            description={
              billedTo ? (
                <>
                  Changes about this workspace in {billedTo.name}'s log.{" "}
                  <Link to={`/enterprises/${encodeURIComponent(billedTo.id)}`} className="text-merged hover:underline">
                    Full log
                  </Link>
                </>
              ) : undefined
            }
          />
        </div>
      </div>
    </main>
  );
}

function BilledToSection({
  billedTo,
  enterprises,
  pathname,
  error,
}: {
  billedTo: Enterprise | null;
  enterprises: { id: string; name: string; members: number }[];
  pathname: string;
  error: SectionError;
}) {
  return (
    <Section id="billed-to" title="Billed to" description="Whether the workspace pays for itself, or an enterprise pays for it.">
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error.error}</Notice>
        </div>
      )}
      {billedTo ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            <Link to={`/enterprises/${encodeURIComponent(billedTo.id)}`} className="font-medium text-fg hover:underline hover:underline-offset-4">
              {billedTo.name}
            </Link>{" "}
            pays for it, under its limit and terms.
          </p>
          <form method="post" action={`${pathname}#review`}>
            <input type="hidden" name="intent" value="detach" />
            <Button type="submit" variant="danger">
              <LogOut size={14} />
              Move off
            </Button>
          </form>
        </div>
      ) : enterprises.length === 0 ? (
        <p className="text-sm text-muted">
          Itself. There are no enterprises to move it onto yet;{" "}
          <Link to="/enterprises/new" className="text-merged hover:underline hover:underline-offset-4">
            create one
          </Link>
          .
        </p>
      ) : (
        <form method="post" action={`${pathname}#review`} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="intent" value="attach" />
          <Field label="Itself. Move onto" className="grow">
            <Select name="target" required defaultValue={error?.values?.target ?? ""}>
              <option value="" disabled>
                Choose an enterprise
              </option>
              {enterprises.map((enterprise) => (
                <option key={enterprise.id} value={enterprise.id}>
                  {enterprise.name} ({enterprise.members} workspace{enterprise.members === 1 ? "" : "s"})
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="quiet">
            <Building2 size={14} />
            Move
          </Button>
        </form>
      )}
    </Section>
  );
}
