import { ArrowLeft, Building2, Gift, LogOut, Plus, ScrollText, Trash2, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { data, Link, redirect, useLocation } from "react-router";

import { type AccountDetail, type LedgerEntry, type Limit, type Terms, httpStatus } from "@g1t/contracts";

import type { Route } from "./+types/account";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ExposureBar,
  Field,
  Input,
  KindBadge,
  Notice,
  Section,
  Select,
  StateBadge,
  TermsBadge,
  Textarea,
  TrustBadge,
  When,
} from "~/components/ui";
import { fields, isAccountId, parseCredit, parseNote, parseSlug, parseTerms, text } from "~/lib/forms";
import { dollarsField, usd } from "~/lib/money";
import { admin } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData?.detail.summary.account.name ?? "Account"} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

const DONE: Record<string, string> = {
  terms: "Terms saved. They apply to charges from now on.",
  attach: "Workspace moved onto the enterprise.",
  detach: "Workspace moved back onto its own account.",
  credit: "Credit issued.",
  created: "Enterprise created.",
};

async function load(id: string): Promise<AccountDetail> {
  if (!isAccountId(id)) throw data("That is not an account id or a workspace slug.", { status: 404 });
  const result = await admin.account(id);
  if (!result.ok) throw data(result.error.message, { status: httpStatus(result.error) });
  return result.value;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  requireStaff(context);
  const detail = await load(params.id);
  const { account } = detail.summary;
  // A workspace's page offers the enterprises it could move onto.
  const enterprises =
    account.kind === "workspace"
      ? (await admin.accounts())
          .filter((row) => row.account.kind === "enterprise")
          .map((row) => ({ id: row.account.id, name: row.account.name }))
      : [];
  const done = new URL(request.url).searchParams.get("done");
  return { detail, enterprises, done: done && DONE[done] ? DONE[done] : null };
}

type Review =
  | { intent: "terms"; before: Terms; after: Terms; fields: Record<string, string> }
  | { intent: "attach"; workspace: string; target: string; targetName: string; fields: Record<string, string> }
  | { intent: "detach"; workspace: string; from: string; fields: Record<string, string> };

type ActionData = { error: string; section: string; values?: Record<string, string> } | { review: Review };

function failed(section: string, error: string, values?: Record<string, string>) {
  return data<ActionData>({ error, section, values }, { status: 422 });
}

/** The workspace an account's page acts for when it is a workspace's own. */
function ownWorkspace(detail: AccountDetail): string {
  return detail.summary.limit.workspace;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  // What is acted on comes from the billing service, not from the form.
  const detail = await load(params.id);
  const { account } = detail.summary;
  const form = await request.formData();
  const intent = text(form, "intent");
  const confirmed = text(form, "confirm") === "yes";
  const back = (done: string) => redirect(`/accounts/${encodeURIComponent(params.id)}?done=${done}#top`);

  if (intent === "terms") {
    const values = fields(form, "kind", "discount", "ceiling", "note", "until");
    const terms = parseTerms(form, staff.email);
    if (!terms.ok) return failed("terms", terms.error, values);
    if (!confirmed) return { review: { intent, before: account.terms, after: terms.value, fields: values } } satisfies ActionData;
    const result = await admin.setTerms(account.id, terms.value, staff.email);
    if (!result.ok) return failed("terms", result.error.message, values);
    return back("terms");
  }

  if (intent === "attach") {
    const values = fields(form, "workspace", "target");
    const slug = parseSlug(account.kind === "enterprise" ? values.workspace : ownWorkspace(detail));
    if (!slug.ok) return failed("members", slug.error, values);
    let target = account.id;
    let targetName = account.name;
    if (account.kind === "workspace") {
      const enterprise = (await admin.accounts()).find((row) => row.account.kind === "enterprise" && row.account.id === values.target);
      if (!enterprise) return failed("enterprise", "Choose an enterprise to move onto.", values);
      target = enterprise.account.id;
      targetName = enterprise.account.name;
    } else if (account.workspaces.includes(slug.value)) {
      return failed("members", `${slug.value} is already on this enterprise.`, values);
    }
    if (!confirmed) {
      return { review: { intent, workspace: slug.value, target, targetName, fields: values } } satisfies ActionData;
    }
    const result = await admin.attach(slug.value, target, staff.email);
    if (!result.ok) return failed(account.kind === "enterprise" ? "members" : "enterprise", result.error.message, values);
    return back("attach");
  }

  if (intent === "detach") {
    const values = fields(form, "workspace");
    const workspace = account.kind === "enterprise" ? values.workspace : ownWorkspace(detail);
    const onIt = account.kind === "enterprise" ? account.workspaces.includes(workspace) : detail.summary.limit.account !== account.id;
    if (!onIt) return failed(account.kind === "enterprise" ? "members" : "enterprise", `${workspace} is not on an enterprise here.`);
    const from = account.kind === "enterprise" ? account.name : detail.summary.limit.accountName;
    if (!confirmed) return { review: { intent, workspace, from, fields: values } } satisfies ActionData;
    const result = await admin.attach(workspace, null, staff.email);
    if (!result.ok) return failed(account.kind === "enterprise" ? "members" : "enterprise", result.error.message);
    return back("detach");
  }

  if (intent === "credit") {
    const values = fields(form, "workspace", "amount", "note", "confirmation");
    const workspace = account.kind === "enterprise" ? values.workspace : ownWorkspace(detail);
    if (account.kind === "enterprise" && !account.workspaces.includes(workspace)) {
      return failed("credit", "Choose one of this account's workspaces.", values);
    }
    const amount = parseCredit(values.amount);
    if (!amount.ok) return failed("credit", amount.error, values);
    const note = parseNote(values.note);
    if (!note.ok) return failed("credit", note.error, values);
    if (values.confirmation !== workspace) {
      return failed("credit", `Type the workspace's slug, ${workspace}, exactly, to issue the credit.`, { ...values, confirmation: "" });
    }
    const result = await admin.credit(workspace, amount.value, note.value, staff.email);
    if (!result.ok) return failed("credit", result.error.message, values);
    return back("credit");
  }

  return failed("top", "Unknown action.");
}

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const { detail, enterprises, done } = loaderData;
  const { summary } = detail;
  const { account, limit } = summary;
  const { pathname } = useLocation();
  const result = actionData as ActionData | undefined;
  const review = result && "review" in result ? result.review : null;
  const error = (section: string) => (result && "error" in result && result.section === section ? result : null);
  const isEnterprise = account.kind === "enterprise";
  const billedElsewhere = !isEnterprise && limit.account !== account.id;

  return (
    <main id="top" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-8 sm:py-10">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Accounts
      </Link>

      {/* Header */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar name={account.name} size={40} />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{account.name}</h1>
            <p className="mt-0.5 font-mono text-xs break-all text-faint">{account.id}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <KindBadge kind={account.kind} />
              <TermsBadge terms={account.terms} />
              <TrustBadge trust={limit.trust} />
              <StateBadge state={limit.state} />
              {billedElsewhere && <Badge tone="lavender">Billed through {limit.accountName}</Badge>}
            </div>
          </div>
        </div>
        <p className="text-xs text-faint">
          Account since <When at={account.createdAt} />
        </p>
      </div>

      <div className="mt-6 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {error("top") && <Notice tone="error">{error("top")?.error}</Notice>}
        {limit.message && <Notice tone={limit.state === "stopped" ? "error" : limit.state === "warning" ? "warn" : "info"}>{limit.message}</Notice>}
        {review && <ReviewPanel review={review} pathname={pathname} />}
      </div>

      {/* This month */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-line bg-surface px-4 py-3 sm:col-span-2">
          <p className="mb-2 text-xs text-muted">Unpaid exposure this month</p>
          <ExposureBar limit={limit} wide />
          <p className="mt-2 text-xs text-faint">
            Trust ceiling {usd(limit.trustCeilingMicros)} · owner's spend limit {usd(limit.spendLimitMicros)}
            {account.terms.ceilingMicros != null && <> · custom ceiling {usd(account.terms.ceilingMicros)}</>}
          </p>
        </div>
        <Figure label="Charged this month" value={usd(summary.chargedMicros)} hint={`Cost to g1t ${usd(summary.costMicros)}`} />
        <Figure label="Paid ever" value={usd(summary.paidMicros)} hint={`Margin this month ${usd(summary.chargedMicros - summary.costMicros)}`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <TermsForm terms={account.terms} pathname={pathname} error={error("terms")} />

          {isEnterprise ? (
            <MembersSection detail={detail} pathname={pathname} error={error("members")} />
          ) : (
            <EnterpriseSection
              billedElsewhere={billedElsewhere}
              limit={limit}
              enterprises={enterprises}
              pathname={pathname}
              error={error("enterprise")}
            />
          )}

          <LedgerSection ledger={detail.ledger} />
        </div>

        <div className="space-y-6">
          <CreditForm
            workspaces={isEnterprise ? account.workspaces : [limit.workspace]}
            pathname={pathname}
            error={error("credit")}
          />
          <AuditSection audit={detail.audit} />
        </div>
      </div>
    </main>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  );
}

function Hidden({ values }: { values: Record<string, string> }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

type SectionError = { error: string; values?: Record<string, string> } | null;

// --- Confirmation ------------------------------------------------------------

function describeTerms(terms: Terms): [string, string][] {
  return [
    ["Terms", terms.kind === "custom" ? "Custom" : terms.kind === "comped" ? "Comped" : "Standard"],
    ["Discount", terms.kind === "custom" ? `${terms.discountPercent}%` : "—"],
    ["Ceiling", terms.ceilingMicros == null ? "By trust" : usd(terms.ceilingMicros)],
    ["Until", terms.until ? terms.until.slice(0, 10) : "No end"],
    ["Note", terms.note || "—"],
  ];
}

function ReviewPanel({ review, pathname }: { review: Review; pathname: string }) {
  let title: string;
  let body: ReactNode;
  let danger = false;
  if (review.intent === "terms") {
    const before = describeTerms(review.before);
    const after = describeTerms(review.after);
    title = "Confirm the new terms";
    danger = review.after.kind === "comped";
    body = (
      <>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1.5 pr-4 font-medium" />
                <th className="py-1.5 pr-4 font-medium">Now</th>
                <th className="py-1.5 font-medium">After</th>
              </tr>
            </thead>
            <tbody>
              {after.map(([label, value], index) => (
                <tr key={label} className="border-t border-line align-top">
                  <td className="py-1.5 pr-4 text-muted">{label}</td>
                  <td className="py-1.5 pr-4 break-words text-faint">{before[index][1]}</td>
                  <td className={`py-1.5 break-words ${value !== before[index][1] ? "font-medium text-fg" : "text-muted"}`}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {review.after.kind === "comped" && (
          <p className="mt-3 text-sm text-warn">Comped: nothing this account uses will be charged{review.after.until ? ` until ${review.after.until.slice(0, 10)}` : ""}. Usage is still recorded at cost.</p>
        )}
      </>
    );
  } else if (review.intent === "attach") {
    title = `Move ${review.workspace} onto ${review.targetName}?`;
    body = (
      <p className="text-sm text-muted">
        From now on <span className="font-mono text-fg">{review.workspace}</span>'s usage is billed to{" "}
        <span className="text-fg">{review.targetName}</span> and counts against its limit and terms, not its own.
      </p>
    );
  } else {
    title = `Move ${review.workspace} off ${review.from}?`;
    danger = true;
    body = (
      <p className="text-sm text-muted">
        <span className="font-mono text-fg">{review.workspace}</span> goes back to paying for itself, under its own terms and the
        ceiling its trust gives it. It may stop at once if its own ceiling is lower than its exposure.
      </p>
    );
  }
  return (
    <section id="review" className={`scroll-mt-20 rounded-lg border p-4 sm:p-5 ${danger ? "border-warn/40 bg-warn/5" : "border-merged/40 bg-merged/5"}`}>
      <h2 className="font-semibold tracking-tight">{title}</h2>
      <div className="mt-3">{body}</div>
      <form method="post" action={`${pathname}#top`} className="mt-4 flex flex-wrap items-center gap-2">
        <Hidden values={review.fields} />
        <input type="hidden" name="intent" value={review.intent} />
        <input type="hidden" name="confirm" value="yes" />
        <Button type="submit" variant={danger ? "danger" : "lavender"}>
          Confirm
        </Button>
        <Link to={pathname} className="px-2 text-sm text-muted hover:text-fg">
          Cancel
        </Link>
      </form>
    </section>
  );
}

// --- Terms -------------------------------------------------------------------

const KINDS: { value: Terms["kind"]; title: string; text: string }[] = [
  { value: "standard", title: "Standard", text: "Published prices; the ceiling comes from trust." },
  { value: "comped", title: "Comped", text: "Nothing charged. Usage still recorded at cost." },
  { value: "custom", title: "Custom", text: "A discount, a custom ceiling, or both." },
];

function TermsForm({ terms, pathname, error }: { terms: Terms; pathname: string; error: SectionError }) {
  const values = error?.values;
  const kind = values?.kind ?? terms.kind;
  return (
    <Section
      id="terms"
      title="Terms"
      description={
        terms.setBy ? (
          <>
            Set by <span className="font-mono">{terms.setBy}</span> on <When at={terms.setAt} />
            {terms.note && <> · “{terms.note}”</>}
          </>
        ) : (
          "Standard terms, as every account starts."
        )
      }
    >
      <form method="post" action={`${pathname}#review`} className="space-y-4">
        <input type="hidden" name="intent" value="terms" />
        {error && <Notice tone="error">{error.error}</Notice>}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-muted">Kind</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {KINDS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer gap-2.5 rounded-md border border-line bg-bg p-3 transition-colors hover:border-line-strong has-checked:border-merged/60 has-checked:bg-merged/8"
              >
                <input type="radio" name="kind" value={option.value} defaultChecked={kind === option.value} className="mt-0.5" required />
                <span>
                  <span className="block text-sm font-medium">{option.title}</span>
                  <span className="mt-0.5 block text-xs text-muted">{option.text}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Discount %" hint="Custom only.">
            <Input name="discount" inputMode="numeric" pattern="\d{1,3}" placeholder="0" defaultValue={values?.discount ?? (terms.discountPercent ? String(terms.discountPercent) : "")} />
          </Field>
          <Field label="Ceiling $" hint="Blank: trust decides.">
            <Input name="ceiling" inputMode="decimal" placeholder="By trust" defaultValue={values?.ceiling ?? dollarsField(terms.ceilingMicros)} />
          </Field>
          <Field label="Until" hint="Blank: no end. UTC.">
            <Input type="date" name="until" defaultValue={values?.until ?? (terms.until ? terms.until.slice(0, 10) : "")} />
          </Field>
        </div>
        <Field label="Note" hint="Required. Why, for whoever looks next.">
          <Textarea name="note" rows={2} required maxLength={500} defaultValue={values?.note ?? ""} placeholder="e.g. Design partner through launch" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit">Review terms</Button>
        </div>
      </form>
    </Section>
  );
}

// --- Enterprise membership ----------------------------------------------------

function MembersSection({ detail, pathname, error }: { detail: AccountDetail; pathname: string; error: SectionError }) {
  const members: Limit[] = detail.workspaces;
  const listed = new Set(members.map((member) => member.workspace));
  // Any workspace the account names but no limit came back for.
  const missing = detail.summary.account.workspaces.filter((slug) => !listed.has(slug));
  return (
    <Section id="members" title="Workspaces" description="Billed together: one bill, one limit, one set of terms.">
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error.error}</Notice>
        </div>
      )}
      {members.length + missing.length === 0 ? (
        <EmptyState title="No workspaces yet">Add one below to bill it through this enterprise.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {members.map((member) => (
            <li key={member.workspace} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 grow items-center gap-2.5">
                <Avatar name={member.workspace} size={22} />
                <div className="min-w-0">
                  <Link to={`/accounts/${encodeURIComponent(member.workspace)}`} className="font-mono text-sm hover:underline hover:underline-offset-4">
                    {member.workspace}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <TrustBadge trust={member.trust} />
                    <StateBadge state={member.state} />
                  </div>
                  {member.message && <p className="mt-1 text-xs text-muted">{member.message}</p>}
                </div>
              </div>
              <div className="flex items-center gap-3 sm:w-64">
                <ExposureBar limit={member} wide />
                <DetachButton workspace={member.workspace} pathname={pathname} />
              </div>
            </li>
          ))}
          {missing.map((slug) => (
            <li key={slug} className="flex items-center gap-3 p-3">
              <span className="grow font-mono text-sm">{slug}</span>
              <DetachButton workspace={slug} pathname={pathname} />
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

function EnterpriseSection({
  billedElsewhere,
  limit,
  enterprises,
  pathname,
  error,
}: {
  billedElsewhere: boolean;
  limit: Limit;
  enterprises: { id: string; name: string }[];
  pathname: string;
  error: SectionError;
}) {
  return (
    <Section id="enterprise" title="Enterprise" description="Whether another account pays for this workspace.">
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error.error}</Notice>
        </div>
      )}
      {billedElsewhere ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            Billed through{" "}
            <Link to={`/accounts/${encodeURIComponent(limit.account)}`} className="text-fg hover:underline hover:underline-offset-4">
              {limit.accountName}
            </Link>
            , under its limit and terms.
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
          Pays for itself. There are no enterprises to move it onto yet;{" "}
          <Link to="/enterprises/new" className="text-merged hover:underline hover:underline-offset-4">
            create one
          </Link>
          .
        </p>
      ) : (
        <form method="post" action={`${pathname}#review`} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="intent" value="attach" />
          <Field label="Pays for itself. Move onto" className="grow">
            <Select name="target" required defaultValue={error?.values?.target ?? ""}>
              <option value="" disabled>
                Choose an enterprise
              </option>
              {enterprises.map((enterprise) => (
                <option key={enterprise.id} value={enterprise.id}>
                  {enterprise.name} ({enterprise.id})
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

// --- Credit -------------------------------------------------------------------

function CreditForm({ workspaces, pathname, error }: { workspaces: string[]; pathname: string; error: SectionError }) {
  const values = error?.values;
  const single = workspaces.length === 1 ? workspaces[0] : null;
  return (
    <Section id="credit" title="Issue credit" description="A refund or goodwill. Added to the workspace's balance at once.">
      {workspaces.length === 0 ? (
        <p className="text-sm text-muted">Add a workspace first: credit goes to a workspace.</p>
      ) : (
        <form method="post" action={`${pathname}#credit`} className="space-y-4">
          <input type="hidden" name="intent" value="credit" />
          {error && <Notice tone="error">{error.error}</Notice>}
          {single ? (
            <input type="hidden" name="workspace" value={single} />
          ) : (
            <Field label="Workspace">
              <Select name="workspace" required defaultValue={values?.workspace ?? ""}>
                <option value="" disabled>
                  Choose a workspace
                </option>
                {workspaces.map((slug) => (
                  <option key={slug} value={slug}>
                    {slug}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Amount $" hint="Up to $10,000 at a time.">
            <Input name="amount" inputMode="decimal" required placeholder="25.00" defaultValue={values?.amount ?? ""} />
          </Field>
          <Field label="Note" hint="Required. Shown on the workspace's statement.">
            <Textarea name="note" rows={2} required maxLength={500} placeholder="e.g. Refund for the failed runs on Oct 2" defaultValue={values?.note ?? ""} />
          </Field>
          <Field
            label="Confirm"
            hint={
              <>
                Type the workspace's slug{single && <> (<span className="font-mono text-muted">{single}</span>)</>} to issue it.
              </>
            }
          >
            <Input name="confirmation" required placeholder={single ?? "workspace-slug"} className="font-mono" />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="lavender">
              <Gift size={14} />
              Issue credit
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

// --- Ledger and audit ---------------------------------------------------------

const ENTRY_KIND: Record<string, string> = { top_up: "Top-up", usage: "Usage", credit: "Credit" };

function LedgerSection({ ledger }: { ledger: LedgerEntry[] }) {
  return (
    <Section title="Ledger" description="Recent lines of the statement, newest first.">
      {ledger.length === 0 ? (
        <EmptyState title="Nothing yet" />
      ) : (
        <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium sm:pl-5">When</th>
                <th className="px-4 py-2 font-medium">What</th>
                <th className="px-4 py-2 text-right font-medium sm:pr-5">Amount</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((entry) => (
                <tr key={entry.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted sm:pl-5">
                    <When at={entry.createdAt} time />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={entry.amountMicros > 0 ? "mint" : "plain"}>{ENTRY_KIND[entry.kind] ?? entry.kind}</Badge>
                      <span className="break-words">{entry.description}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-faint">
                      {[
                        entry.repo && (entry.number != null ? `${entry.repo}#${entry.number}` : entry.repo),
                        entry.task,
                        entry.model,
                        entry.billedTo === "workspace" ? "own provider" : null,
                        entry.createdBy && `by ${entry.createdBy}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </td>
                  <td className={`tabular px-4 py-2.5 text-right whitespace-nowrap sm:pr-5 ${entry.amountMicros > 0 ? "text-accent" : "text-fg-soft"}`}>
                    {usd(entry.amountMicros, { signed: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function AuditSection({ audit }: { audit: AccountDetail["audit"] }) {
  return (
    <Section title="Audit log" description="Every change made in sudo, and by whom.">
      {audit.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <ScrollText size={14} />
          No changes yet.
        </p>
      ) : (
        <ol className="space-y-3">
          {audit.map((entry) => (
            <li key={entry.id} className="border-l-2 border-merged/40 pl-3">
              <p className="flex flex-wrap items-center gap-x-2 text-sm">
                <span className="font-mono font-medium text-merged">{entry.action}</span>
                <span className="text-xs text-faint">
                  <When at={entry.createdAt} time />
                </span>
              </p>
              {entry.detail && <p className="mt-0.5 text-sm break-words text-fg-soft">{entry.detail}</p>}
              <p className="mt-0.5 flex items-center gap-1 font-mono text-xs text-faint">
                <UserRound size={11} />
                {entry.by}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
