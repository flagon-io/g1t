import { Check, Search, X } from "lucide-react";
import { Link, data, redirect, useLocation } from "react-router";

import type { RegistrationSetting, WaitlistEntry } from "@g1t/contracts";

import type { Route } from "./+types/waitlist";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Textarea, When } from "~/components/ui";
import { text } from "~/lib/forms";
import { DONE, doneKey } from "~/lib/review";
import { identity } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";
import { ago } from "~/lib/time";
import {
  MAX_NOTE,
  WAITLIST_TABS,
  type WaitlistTab,
  parseNote,
  parseRegistrationMode,
  parseWaitlistDecision,
  parseWaitlistTab,
  statusFilter,
  waitlistHref,
} from "~/lib/waitlist";

export const meta: Route.MetaFunction = () => [{ title: "Access requests · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const tab = parseWaitlistTab(url.searchParams.get("status"));
  const query = (url.searchParams.get("q") ?? "").trim();
  const [rows, pending, registration] = await Promise.all([
    settle(identity.waitlist(query || null, statusFilter(tab))),
    settle(identity.waitlistPending()),
    settle(identity.registration()),
  ]);
  const done = doneKey(request.url);
  return {
    tab,
    query,
    rows: rows.ok ? rows.value : [],
    pending: pending.ok ? pending.value : null,
    registration: registration.ok ? registration.value : null,
    error: rows.ok ? null : rows.error,
    done: done ? DONE[done] : null,
    now: Date.now(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  // The sign-up switch: open, or invite only (private preview).
  if (text(form, "intent") === "registration") {
    const mode = parseRegistrationMode(text(form, "mode"));
    if (!mode.ok) return data({ registrationError: mode.error }, { status: 422 });
    await identity.setRegistration(mode.value, staff.email);
    const back = new URL(request.url);
    back.searchParams.set("done", `registration-${mode.value}`);
    throw redirect(`${back.pathname}${back.search}`);
  }
  const id = text(form, "id");
  const values = { note: text(form, "note") };
  const decision = parseWaitlistDecision(text(form, "decision"));
  if (!decision.ok) return data({ error: decision.error, id, values }, { status: 422 });
  const approve = decision.value;
  const note = parseNote(values.note);
  if (!note.ok) return data({ error: note.error, id, values }, { status: 422 });
  const result = await identity.decideWaitlist(id, approve, staff.email, approve ? note.value : null);
  if (!result.ok) return data({ error: result.error.message, id, values }, { status: 422 });
  const back = new URL(request.url);
  back.searchParams.set("done", approve ? "waitlist-approved" : "waitlist-dismissed");
  throw redirect(`${back.pathname}${back.search}`);
}

const TAB_LABEL: Record<WaitlistTab, string> = { waiting: "Waiting", invited: "Invited", dismissed: "Dismissed", all: "All" };

export default function Waitlist({ loaderData, actionData }: Route.ComponentProps) {
  const { tab, query, rows, pending, registration, error, done, now } = loaderData;
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Access requests"
        description="While g1t.sh is in private preview, a new account needs an invite. People without one ask on the sign-up page and wait here. Approving emails them an invite to their address, with your note; dismissing tells nobody. Staff are emailed about new requests too, at most one summary every 15 minutes."
      />
      <SignUpSwitch setting={registration} now={now} error={actionData && "registrationError" in actionData ? actionData.registrationError : null} />
      <nav aria-label="Status" className="mt-5 flex flex-wrap gap-2">
        {WAITLIST_TABS.map((value) => (
          <Link
            key={value}
            to={waitlistHref(value, query)}
            aria-current={value === tab ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors ${
              value === tab ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg"
            }`}
          >
            {TAB_LABEL[value]}
            {value === "waiting" && pending != null && <span className="tabular text-faint">{pending}</span>}
          </Link>
        ))}
      </nav>
      <form method="get" className="mt-4 flex flex-wrap items-end gap-2">
        {tab !== "waiting" && <input type="hidden" name="status" value={tab} />}
        <div className="min-w-0 grow basis-60">
          <Input name="q" defaultValue={query} placeholder="An email, or what they said" aria-label="Search" />
        </div>
        <Button type="submit" variant="quiet">
          <Search size={14} />
          Search
        </Button>
      </form>
      <div className="mt-5 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="warn">Identity did not answer for the waitlist: {error}</Notice>}
      </div>
      <div className="mt-5">
        {rows.length === 0 && !error ? (
          <EmptyState title={tab === "waiting" ? (query ? "Nobody waiting matches" : "Nobody waiting") : `No ${TAB_LABEL[tab].toLowerCase()} requests`}>
            People who ask for access on g1t.sh's sign-up page show up here, oldest first while they wait.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {rows.map((entry) => (
              <Row key={entry.id} entry={entry} now={now} error={actionData && "id" in actionData && actionData.id === entry.id ? actionData : null} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

/** Whether anyone may sign up, and the one button that flips it: no deploy, the site follows within a minute. */
function SignUpSwitch({ setting, now, error }: { setting: RegistrationSetting | null; now: number; error: string | null }) {
  if (!setting) return <Notice tone="warn">Identity did not say whether sign-up is open.</Notice>;
  const preview = setting.mode === "invite";
  return (
    <section aria-labelledby="sign-up" className="mt-5 rounded-lg border border-line bg-surface px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="sign-up" className="flex items-center gap-2 text-sm font-medium">
            Sign-up {preview ? <Badge tone="mint">Private preview: invite only</Badge> : <Badge>Open to everyone</Badge>}
          </h2>
          <p className="text-xs text-faint">
            {setting.setBy && setting.setAt ? (
              <>
                Set by {setting.setBy} {ago(setting.setAt, now)} · <When at={setting.setAt} time />
              </>
            ) : (
              <>Identity's default (REGISTRATION_MODE): nobody has flipped it yet.</>
            )}
          </p>
        </div>
        <form method="post">
          <input type="hidden" name="intent" value="registration" />
          <input type="hidden" name="mode" value={preview ? "open" : "invite"} />
          <Button type="submit" variant="quiet">
            {preview ? "Open sign-up to everyone" : "Close sign-up to invites only"}
          </Button>
        </form>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}

function Row({ entry, now, error }: { entry: WaitlistEntry; now: number; error: { error: string; values?: Record<string, string> } | null }) {
  const { pathname, search } = useLocation();
  const waiting = entry.status === "waiting";
  return (
    <li id={entry.id} className="scroll-mt-20 space-y-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-sm break-all">{entry.email}</span>
        {entry.status === "invited" && <Badge tone="mint">Invited</Badge>}
        {entry.status === "dismissed" && <Badge>Dismissed</Badge>}
        <span className="text-xs text-faint">
          asked {ago(entry.createdAt, now)} · <When at={entry.createdAt} time />
          {entry.updatedAt !== entry.createdAt && <> · again {ago(entry.updatedAt, now)}</>}
        </span>
      </div>
      {entry.about ? (
        <blockquote className="border-l-2 border-line-strong pl-3 text-sm wrap-break-word whitespace-pre-line text-fg-soft">{entry.about}</blockquote>
      ) : (
        <p className="text-xs text-faint italic">Did not say what they will build.</p>
      )}
      <Decision entry={entry} />
      {waiting && (
        <form method="post" action={`${pathname}${search}#${entry.id}`} className="space-y-2">
          <input type="hidden" name="id" value={entry.id} />
          <Field label="Note in the invite email" hint={`Optional, up to ${MAX_NOTE} characters. Sent only when you approve.`}>
            <Textarea
              name="note"
              rows={2}
              maxLength={MAX_NOTE}
              defaultValue={error?.values?.note ?? ""}
              placeholder="e.g. Thanks for waiting. Tell us how it goes."
            />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="submit" name="decision" value="dismiss" variant="quiet">
              <X size={14} />
              Dismiss
            </Button>
            <Button type="submit" name="decision" value="approve" variant="lavender">
              <Check size={14} />
              Approve and invite
            </Button>
          </div>
        </form>
      )}
      {error && <Notice tone="error">{error.error}</Notice>}
    </li>
  );
}

/** Who decided, when, what they wrote, and whether the invite was used. */
function Decision({ entry }: { entry: WaitlistEntry }) {
  if (!entry.decidedBy) return null;
  return (
    <div className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-faint">
        {entry.status === "invited" ? "Approved" : "Dismissed"} by <span className="font-mono text-muted">{entry.decidedBy}</span>
        <When at={entry.decidedAt} time />
        {entry.status === "invited" &&
          (entry.joinedAs ? (
            <Link to={`/users/${encodeURIComponent(entry.joinedAs)}`} className="hover:underline">
              <Badge tone="mint">Joined as @{entry.joinedAs}</Badge>
            </Link>
          ) : (
            <Badge>Invite not used yet</Badge>
          ))}
      </p>
      {entry.note && (
        <p className="text-xs text-muted">
          Note sent: <span className="whitespace-pre-line text-fg-soft">{entry.note}</span>
        </p>
      )}
    </div>
  );
}
