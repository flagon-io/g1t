import { AlertTriangle, CheckCircle2, ChevronRight, ReceiptText, X } from "lucide-react";
import { Form, Link, data } from "react-router";

import {
  COST_PROVIDERS,
  type CostProvider,
  type CostUnit,
  type ProviderConnection,
  type ProviderCosts,
  type ProviderPersonCosts,
  isCostProvider,
} from "@g1t/contracts";

import type { Route } from "./+types/provider-costs";
import { CostProviderMark } from "../../components/connectors";
import { Unavailable } from "../../components/boundary";
import { ErrorText, Field, Input, SubmitButton, TimeAgo } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { page } from "../../lib/meta";
import { money } from "../../lib/money";
import { type Failed, isFailed, part } from "../../lib/partial";
import { billing } from "../../lib/services.server";
import { unitAmount } from "../../lib/spend";
import { assertSameOrigin, getViewer, managesBilling, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Provider costs · ${params.owner} · g1t` });
}

/** How many days the page totals. */
const RECENT_DAYS = 30;

/** Which key each provider's report needs, where it is made, and what g1t reads with it. */
const KEYS: Record<CostProvider, { key: string; where: string; placeholder: string; reads: string }> = {
  anthropic: {
    key: "an Admin API key",
    where: "Make one in the Claude Console under Settings, Admin keys. Only an organization admin can.",
    placeholder: "sk-ant-admin…",
    reads: "Its cost report, and Claude Code's usage report per person.",
  },
  openai: {
    key: "an admin key",
    where: "Make one in the OpenAI platform under Organization settings, Admin keys. Only an organization owner can.",
    placeholder: "sk-admin-…",
    reads: "Its costs, overall and per person.",
  },
  cursor: {
    key: "an Admin API key",
    where: "A team admin makes one in the Cursor dashboard, under API Keys. Cursor's Admin API is for Enterprise teams.",
    placeholder: "crsr_…",
    reads: "What each request was charged, per person and conversation.",
  },
  amp: {
    key: "an External API application",
    where: "Make a machine-to-machine application in your Amp workspace's settings, under Applications, with the workspace analytics and members view scopes.",
    placeholder: "Client secret",
    reads: "Each person's usage in dollars, by day.",
  },
  devin: {
    key: "a service key",
    where:
      "A Devin service user key (cog_…) that may view consumption and members, or a Devin Desktop service key with Teams Read-only. Devin's usage APIs are for Enterprise plans.",
    placeholder: "cog_… or a Devin Desktop service key",
    reads: "Each person's ACUs or Devin Desktop credits, by day, as they are: never turned into dollars.",
  },
};

/** The first day of the calendar quarter `today` (`YYYY-MM-DD`, UTC) is in. */
function quarterStart(today: string): string {
  const month = Number(today.slice(5, 7));
  return `${today.slice(0, 4)}-${String(month - ((month - 1) % 3)).padStart(2, "0")}-01`;
}

/**
 * Settings, Provider costs: the AI providers whose own cost reports g1t
 * reads for the workspace (services/billing/src/provider_costs.rs and
 * provider_people.rs). Every
 * member can see which are connected, when they were last read and what
 * went wrong; only owners connect and disconnect them. Keys are never
 * shown again, only their last four characters.
 *
 * Owners and billing managers also see what the per-person reports hold
 * this quarter, in dollars, for nobody g1t can link to a member.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const since = new Date(Date.now() - (RECENT_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  // The connections are what the page is about; the totals beside them are a part, and what nobody is linked to is
  // left out when billing doesn't say. Unlinked comes back for a manager whoever the person asked about is.
  const [connections, costs, people] = await Promise.all([
    billing.providerConnections(slug, viewer),
    part(billing.providerCosts(slug, viewer, since), "What the providers reported"),
    viewer && managesBilling(viewer, slug)
      ? billing
          .providerPersonCosts(slug, viewer, { userId: viewer.id, since: quarterStart(today), until: today })
          .then((found) => (found.ok ? found.value : null))
          .catch(() => null)
      : null,
  ]);
  return {
    slug,
    owner: role === "owner",
    connections: unwrap(connections),
    totals: totalsOf(costs),
    people: people?.connected && people.unlinkedMicros != null ? people : null,
  };
}

/** A provider's total: millionths of its unit. */
type Total = { micros: number; unit: CostUnit };

/** Each provider's total over the recent days, in its unit, or the part's failure. */
function totalsOf(costs: Awaited<ReturnType<typeof billing.providerCosts>> | Failed): Partial<Record<CostProvider, Total>> | Failed {
  if (isFailed(costs)) return costs;
  if (!costs.ok) return { failed: true, what: "What the providers reported" };
  const totals: Partial<Record<CostProvider, Total>> = {};
  for (const day of (costs.value as ProviderCosts).days) {
    const unit = day.unit ?? "usd";
    const total = totals[day.provider] ?? { micros: 0, unit };
    // A provider reports in one unit; one that changed (a new key) shows its latest.
    totals[day.provider] = total.unit === unit ? { micros: total.micros + day.micros, unit } : { micros: day.micros, unit };
  }
  return totals;
}

/** A total in words: dollars, credits or ACUs. */
const amount = ({ micros, unit }: Total) => (unit === "usd" ? money(micros) : unitAmount(micros, unit));

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const form = await request.formData();
  const provider = String(form.get("provider") ?? "");
  if (!isCostProvider(provider)) return { ok: false as const, provider: null, error: "Choose a provider." };
  try {
    if (form.get("intent") === "disconnect") {
      const removed = await billing.disconnectProvider(user, slug, provider);
      return removed.ok ? { ok: true as const, provider, disconnected: true as const } : { ok: false as const, provider, error: removed.error.message };
    }
    // Amp's application has a client ID and secret: billing takes them as one, `id:secret`.
    const clientId = String(form.get("clientId") ?? "").trim();
    const secret = String(form.get("credential") ?? "").trim();
    const credential = provider === "amp" && clientId && secret ? `${clientId}:${secret}` : secret;
    if (!secret || (provider === "amp" && !clientId)) {
      return {
        ok: false as const,
        provider,
        error: provider === "amp" ? "Paste the application's client ID and client secret." : `Paste ${COST_PROVIDERS[provider].label}'s key.`,
      };
    }
    const connected = await billing.connectProvider(user, slug, provider, credential);
    return connected.ok ? { ok: true as const, provider, connected: connected.value } : { ok: false as const, provider, error: connected.error.message };
  } catch (error) {
    console.error("provider costs: billing did not answer", error);
    return { ok: false as const, provider, error: "Billing didn't answer. Try again in a moment." };
  }
}

const SECTION = "border-t border-line pt-8 first:border-t-0 first:pt-0";

export default function ProviderCostsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, owner, connections, totals, people } = loaderData;
  const connected = actionData?.ok && "connected" in actionData ? actionData.connected : null;
  const failure = actionData && !actionData.ok ? actionData : null;
  const byProvider = new Map(connections.map((c) => [c.provider, c]));
  const unconnected = (Object.keys(COST_PROVIDERS) as CostProvider[]).filter((p) => !byProvider.has(p));
  return (
    <div className="max-w-2xl">
      <header className="mb-8 border-b border-line pb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <span className="text-muted">
            <ReceiptText size={18} />
          </span>
          Provider costs
        </h1>
        <p className="mt-1.5 text-sm text-muted">
          What your AI providers say {slug}&apos;s organization spent, day by day, read from each provider&apos;s own reports. It counts every use of that
          organization, in g1t or not: CI scripts, other tools, people&apos;s own sessions. g1t reads them once a day.
        </p>
      </header>

      {!owner && (
        <Card asChild radius="lg" className="mb-8 px-4 py-3 text-sm text-muted">
          <p>Only workspace owners can connect or disconnect a provider. They are shown so you know where these figures come from.</p>
        </Card>
      )}

      {connected && <Connected connection={connected} />}
      {failure && !failure.provider && <ErrorText>{failure.error}</ErrorText>}

      <div className="space-y-8">
        <section className={SECTION} aria-labelledby="connected-heading">
          <h2 id="connected-heading" className="font-medium">
            Connected providers
          </h2>
          {connections.length === 0 ? (
            <p className="mt-3 text-sm text-muted">{owner ? "None yet. Connect one below." : `None yet. An owner of ${slug} can connect one.`}</p>
          ) : (
            <Card asChild divided className="mt-4 overflow-hidden">
              <ul>
                {connections.map((connection) => (
                  <li key={connection.provider} className="p-4">
                    <ConnectionRow
                      connection={connection}
                      owner={owner}
                      total={
                        isFailed(totals)
                          ? totals
                          : (totals[connection.provider] ?? { micros: 0, unit: COST_PROVIDERS[connection.provider].dollars ? "usd" : "credits" })
                      }
                      error={failure?.provider === connection.provider ? failure.error : null}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {people && <ByPerson people={people} />}
          <p className="mt-3 text-xs text-faint">
            Keys are sealed when saved and never shown again. Disconnecting deletes the key and every cost read with it.
          </p>
        </section>

        {owner && unconnected.length > 0 && (
          <section className={SECTION} aria-labelledby="connect-heading">
            <h2 id="connect-heading" className="font-medium">
              Connect a provider
            </h2>
            <p className="mt-1.5 text-xs text-faint">
              g1t checks the key with one small report request, then reads the last 90 days. It reads costs only: the key is never used to run models.
            </p>
            <div className="mt-4 space-y-4">
              {unconnected.map((provider) => (
                <Card key={provider} asChild className="p-4">
                  <div>
                    <div className="flex items-center gap-3">
                      <CostProviderMark provider={provider} size={28} />
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium">{COST_PROVIDERS[provider].label}</h3>
                        <p className="text-xs text-muted">{KEYS[provider].reads}</p>
                        <p className="text-xs text-muted">{KEYS[provider].where}</p>
                      </div>
                    </div>
                    <KeyForm provider={provider} error={failure?.provider === provider ? failure.error : null} label="Connect" />
                  </div>
                </Card>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function ConnectionRow({ connection, owner, total, error }: { connection: ProviderConnection; owner: boolean; total: Total | Failed; error: string | null }) {
  const { provider } = connection;
  return (
    <div>
      <div className="flex items-center gap-3">
        <CostProviderMark provider={provider} />
        <div className="min-w-0 grow">
          <p className="truncate text-sm font-medium">{COST_PROVIDERS[provider].label}</p>
          <p className="truncate text-xs text-muted">
            Key {connection.hint} · connected by {connection.connectedBy} <TimeAgo at={connection.connectedAt} />
          </p>
        </div>
        {owner && (
          <Form method="post" className="shrink-0">
            <input type="hidden" name="provider" value={provider} />
            <SubmitButton
              variant="outline"
              name="intent"
              value="disconnect"
              match={{ provider }}
              pending="Disconnecting…"
              aria-label={`Disconnect ${COST_PROVIDERS[provider].label}`}
            >
              <X size={14} />
            </SubmitButton>
          </Form>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span>
          {connection.lastSyncedAt ? (
            <>
              Last read <TimeAgo at={connection.lastSyncedAt} />
            </>
          ) : (
            "Not read yet"
          )}
          {connection.syncedFrom && <>, back to {connection.syncedFrom}</>}
        </span>
        {isFailed(total) ? (
          <Unavailable what={total.what} compact />
        ) : (
          <span>
            {amount(total)} in the last {RECENT_DAYS} days
          </span>
        )}
      </div>
      {connection.lastError && (
        <p className="mt-3 flex items-start gap-2 text-xs text-warn">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {connection.lastError}
        </p>
      )}
      <ErrorText>{error}</ErrorText>
      {owner && (
        <details className="group mt-3">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-fg">
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
            Replace the key
          </summary>
          <p className="mt-2 text-xs text-faint">The costs read with the old key are deleted and the last 90 days are read again with the new one.</p>
          <KeyForm provider={provider} error={null} label="Replace" />
        </details>
      )}
    </div>
  );
}

/**
 * The per-person reports, for owners and billing managers: each provider's
 * rows are linked to members only through addresses they verified, and
 * this is what this quarter's reports hold in dollars for nobody g1t can
 * link.
 */
function ByPerson({ people }: { people: ProviderPersonCosts }) {
  const actors = people.unlinkedActors;
  return (
    <div className="mt-4 text-xs leading-relaxed text-muted">
      <p className="font-medium text-fg-soft">By person</p>
      <p className="mt-1">
        g1t also reads what each person&apos;s use cost at each provider, by day. A row is linked to a member only through an email address they verified on
        g1t, and shows on their Spend page beside what g1t&apos;s sessions saw.
      </p>
      {actors > 0 ? (
        <p className="mt-1">
          Not linked to anyone: <span className="font-medium text-fg tabular-nums">{money(people.unlinkedMicros ?? 0)}</span> across{" "}
          {actors.toLocaleString("en-US")} {actors === 1 ? "person or key" : "people or keys"} this quarter. To link someone, they add and verify that address
          under{" "}
          <Link to="/settings/emails" className="underline decoration-line-strong underline-offset-2 hover:text-accent">
            Account settings, Emails
          </Link>
          ; API keys stay unlinked.
        </p>
      ) : (
        <p className="mt-1">Everything this quarter is linked to a member.</p>
      )}
    </div>
  );
}

function KeyForm({ provider, error, label }: { provider: CostProvider; error: string | null; label: string }) {
  const amp = provider === "amp";
  return (
    <Form method="post" className="mt-4 space-y-3">
      <input type="hidden" name="provider" value={provider} />
      {amp && (
        <Field label="Amp client ID" hint="The application's client ID.">
          <Input name="clientId" required autoComplete="off" spellCheck={false} className="max-w-sm font-mono text-[0.8125rem]" />
        </Field>
      )}
      <Field
        label={amp ? "Amp client secret" : `${COST_PROVIDERS[provider].label} ${provider === "devin" ? "service key" : "admin key"}`}
        hint={`Write-only: g1t never shows it again. Use ${KEYS[provider].key}.`}
      >
        <Input
          name="credential"
          type="password"
          required
          placeholder={KEYS[provider].placeholder}
          autoComplete="new-password"
          spellCheck={false}
          className="max-w-sm font-mono text-[0.8125rem]"
        />
      </Field>
      <ErrorText>{error}</ErrorText>
      <SubmitButton variant="outline" name="intent" value="connect" match={{ provider }} pending="Checking the key…">
        {label}
      </SubmitButton>
    </Form>
  );
}

/** What happened, right after connecting: shown once. */
function Connected({ connection }: { connection: ProviderConnection }) {
  const label = COST_PROVIDERS[connection.provider].label;
  return (
    <div className="mb-8 rounded-xl border border-success-dim/60 bg-success/5 p-5">
      <p className="flex items-center gap-2 font-medium">
        <CheckCircle2 size={16} className="text-success" />
        {label} is connected.
      </p>
      <p className="mt-2 text-sm text-muted">
        {connection.lastError
          ? `The key works and is saved, but the first read failed: ${connection.lastError}`
          : connection.syncedFrom
            ? `Its report is read back to ${connection.syncedFrom}, and again every day.`
            : "The key works and is saved. Its report is read once a day."}
      </p>
    </div>
  );
}
