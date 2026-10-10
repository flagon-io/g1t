import { ArrowLeft, CornerDownRight } from "lucide-react";
import type { CSSProperties } from "react";
import { Link, data } from "react-router";

import type { Route } from "./+types/spend-receipt";
import { AgentAvatar } from "../../components/agent-avatar";
import { KindBadge, PrivateTitle, StatusChip, sessionHref } from "../../components/agents/parts";
import { whereLabel } from "../../components/agents/format";
import { TimeAgo } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { effortLabel } from "../../lib/effort";
import { page } from "../../lib/meta";
import { requireUser, roleIn } from "../../lib/session.server";
import { loadPricing } from "../../lib/spend.server";
import { receiptOf, tokenCount } from "../../lib/spend";
import { workspaceAgents } from "../../lib/services.server";
import { money } from "../../lib/usage";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Receipt · ${params.owner} · g1t` });
}

/** A task's receipt: its session tree from the agents service, and the price book's terms. */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const [detail, pricing] = await Promise.all([workspaceAgents.session(slug, params.id, viewer).catch(() => null), loadPricing()]);
  if (detail && !detail.ok && detail.error.code === "not_found") throw data(null, { status: 404 });
  const receipt = detail?.ok ? receiptOf(detail.value.tree, detail.value.session.root_id) : null;
  return { slug, receipt, pricing };
}

/**
 * One task, itemized: each session of its tree (the agent's own, and every
 * helper and subagent it brought in) with its tokens, the model at the
 * provider's price and what it was charged; then the totals. A session in
 * a conversation you aren't in shows what it cost, not what it was about.
 */
export default function Receipt({ loaderData }: Route.ComponentProps) {
  const { slug, receipt, pricing } = loaderData;
  const back = (
    <Link to={`/${slug}/-/spend`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft size={14} /> Spend
    </Link>
  );
  if (!receipt) {
    return (
      <div className="mx-auto w-full max-w-215 space-y-6 px-4 py-5 md:px-10 md:py-8">
        {back}
        <Card asChild className="px-4 py-8 text-center text-sm text-muted">
          <p>This receipt couldn&apos;t be read right now. Reload in a moment.</p>
        </Card>
      </div>
    );
  }
  const { root } = receipt;
  const g1tPart = Math.max(0, receipt.chargedMicros - receipt.providerMicros);
  return (
    <div className="mx-auto w-full max-w-215 space-y-6 px-4 py-5 md:px-10 md:py-8">
      {back}
      <header className="flex items-start gap-3">
        <AgentAvatar agent={{ handle: root.agent_handle, avatar_seed: root.agent_avatar_seed }} size={36} />
        <div className="min-w-0 grow">
          <p className="text-xs text-muted">Receipt</p>
          <h1 className="mt-0.5 text-xl leading-snug font-semibold tracking-tight">{root.visible ? root.title || "Untitled session" : <PrivateTitle />}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-faint">
            <span className="text-muted">{root.agent_name}</span>
            {root.visible && root.asked_by_username && <span>· for @{root.asked_by_username}</span>}
            {root.visible && <span>· {whereLabel(root)}</span>}
            <span>·</span>
            <TimeAgo at={root.created_at} />
            <StatusChip status={root.status} className="ml-1" />
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-muted">Total</p>
          <p className="text-2xl font-semibold tracking-tight tabular-nums">{money(receipt.chargedMicros)}</p>
        </div>
      </header>

      <Card asChild className="overflow-hidden">
        <section aria-label="Sessions">
          <div className="hidden grid-cols-[minmax(0,1fr)_9rem_6.5rem_5.5rem] gap-3 border-b border-line px-4 py-2 text-[0.6875rem] font-medium tracking-wide text-faint uppercase sm:grid">
            <span>Session</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Provider price</span>
            <span className="text-right">Charged</span>
          </div>
          <ul className="divide-y divide-line/60">
            {receipt.lines.map(({ session, depth, ownMicros }) => (
              <li key={session.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_9rem_6.5rem_5.5rem] sm:items-center">
                <div className="flex min-w-0 items-start gap-2" style={{ paddingLeft: `${depth * 1.25}rem` }}>
                  {depth > 0 && <CornerDownRight size={13} className="mt-0.5 shrink-0 text-faint" aria-hidden="true" />}
                  <div className="min-w-0">
                    <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                      {session.visible ? (
                        <Link to={sessionHref(slug, session)} className="min-w-0 truncate hover:underline">
                          {session.title || "Untitled session"}
                        </Link>
                      ) : (
                        <PrivateTitle />
                      )}
                      <KindBadge kind={session.kind} subagent={session.subagent} />
                    </p>
                    <p className="mt-0.5 truncate text-xs text-faint">
                      {session.agent_name}
                      {session.model ? ` · ${session.model}` : ""}
                      {session.effort ? ` · ${effortLabel(session.effort)} effort` : ""} · {session.steps} {session.steps === 1 ? "step" : "steps"} · {session.tool_calls} {session.tool_calls === 1 ? "tool" : "tools"}
                    </p>
                  </div>
                </div>
                <span className="text-right text-sm tabular-nums sm:hidden">{money(ownMicros)}</span>
                <span className="col-span-2 text-xs text-faint tabular-nums sm:col-span-1 sm:text-right sm:text-sm sm:text-muted max-sm:pl-(--indent)" style={{ "--indent": `${depth * 1.25 + (depth ? 1.3 : 0)}rem` } as CSSProperties}>
                  <span className="sm:hidden">Tokens </span>
                  {tokenCount(session.input_tokens)} in · {tokenCount(session.output_tokens)} out
                </span>
                <span className="hidden text-right text-sm text-muted tabular-nums sm:block">{money(session.cost_micros ?? 0)}</span>
                <span className="hidden text-right text-sm tabular-nums sm:block">{money(ownMicros)}</span>
              </li>
            ))}
          </ul>
        </section>
      </Card>

      <Card asChild className="p-4">
        <section aria-label="Totals">
          <dl className="space-y-2 text-sm">
            <Row
              label={receipt.chargedMicros < receipt.providerMicros ? "Models, billed by your own provider, not here" : "Models, at the provider's price"}
              value={money(receipt.providerMicros)}
            />
            <Row
              label={
                pricing?.agentRateMicros != null
                  ? `g1t's agent rate, ${money(pricing.agentRateMicros)} per million tokens${pricing.modelMarkupPercent > 0 ? `, and the ${pricing.modelMarkupPercent}% model markup` : ""}`
                  : "g1t's part"
              }
              value={money(g1tPart)}
            />
            <div className="border-t border-line pt-2">
              <Row label="Total, as budgets count it" value={money(receipt.chargedMicros)} strong />
            </div>
          </dl>
          <p className="mt-3 text-xs text-faint">
            {tokenCount(receipt.inputTokens)} tokens in and {tokenCount(receipt.outputTokens)} out over {receipt.steps} steps and {receipt.toolCalls} tool calls. On your
            own model key, your provider bills the model and only the agent rate is charged here; time on your own runners is $0. What the workspace is charged after
            included usage and credit is on Billing.
          </p>
        </section>
      </Card>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? "font-medium" : "text-muted"}>{label}</dt>
      <dd className={`shrink-0 tabular-nums ${strong ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}
