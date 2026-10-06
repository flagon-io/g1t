import { useState } from "react";
import { Link } from "react-router";

import { cn } from "../lib/cn";
import { usd } from "../lib/mission-control";
import {
  HEAT_LEVELS,
  type MixPart,
  type TokenUsageView,
  bestDay,
  cacheShare,
  compactTokens,
  heatLevel,
  shortDay,
  tokenMix,
} from "../lib/token-usage";

/**
 * The token mix's colours, in its stacking order. Checked against the dark
 * surface (lightness band, chroma, contrast, and neighbours apart for every
 * kind of colour vision); change them only by re-running that check.
 */
const MIX_COLOR: Record<MixPart["key"], string> = {
  input: "#9085e9",
  cacheRead: "#199e70",
  cacheWrite: "#3987e5",
  output: "#d55181",
};

/** The daily grid's single hue, stronger with more tokens. */
const HEAT_SHADE = ["var(--color-line)", ...Array.from({ length: HEAT_LEVELS }, (_, i) => `color-mix(in oklab, var(--color-merged) ${[28, 48, 72, 100][i]}%, var(--color-surface))`)];

type Scope = "workspace" | "mine";

/**
 * Model tokens over the last weeks, for the workspace or for you: what was
 * used and what it cost, how many days, how much came from the cache, each
 * day's intensity, and the mix of input, cache and output.
 */
export function TokenUsagePanel({
  workspace,
  mine,
  usageHref,
}: {
  workspace: TokenUsageView | null;
  mine: TokenUsageView | null;
  usageHref: string | null;
}) {
  const [scope, setScope] = useState<Scope>("workspace");
  const usage = scope === "mine" ? mine : workspace;
  return (
    <section aria-labelledby="token-usage" className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="token-usage" className="text-base font-semibold tracking-tight">
          Usage
        </h2>
        <div role="tablist" aria-label="Whose usage" className="flex rounded-md border border-line p-0.5 text-xs">
          {(["workspace", "mine"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={scope === option}
              disabled={option === "mine" && !mine}
              onClick={() => setScope(option)}
              className={cn(
                "rounded px-2 py-0.5 transition-colors disabled:opacity-40",
                scope === option ? "bg-raised text-fg" : "text-muted hover:text-fg",
              )}
            >
              {option === "workspace" ? "Workspace" : "You"}
            </button>
          ))}
        </div>
      </div>
      {usage ? <Figures usage={usage} usageHref={usageHref} /> : <p className="mt-4 text-sm text-muted">Usage could not be loaded.</p>}
    </section>
  );
}

function Figures({ usage, usageHref }: { usage: TokenUsageView; usageHref: string | null }) {
  const share = cacheShare(usage);
  const weeks = Math.round(usage.days / 7);
  if (usage.totalTokens === 0) {
    return (
      <p className="mt-4 text-sm text-muted">
        No model tokens in the last {weeks} weeks{usage.person ? " on work you asked for" : ""}. Agents' runs show here as they work.
      </p>
    );
  }
  return (
    <>
      <dl className="mt-4 grid grid-cols-2 gap-2">
        <Tile label="Tokens" value={compactTokens(usage.totalTokens)} />
        <Tile label="Cost" value={usd(usage.costMicros / 1e6)} title="What these runs were charged" />
        <Tile label="Active days" value={String(usage.activeDays)} hint={`of ${usage.days}`} />
        <Tile label="From cache" value={share == null ? "—" : `${Math.round(share * 100)}%`} title="Prompt tokens read from the model's cache" />
      </dl>
      <DailyGrid byDay={usage.byDay} />
      <Mix usage={usage} />
      {usageHref && (
        <Link to={usageHref} className="mt-4 block border-t border-line pt-3 text-xs text-muted hover:text-fg">
          Every run, by repository and model
        </Link>
      )}
    </>
  );
}

function Tile({ label, value, hint, title }: { label: string; value: string; hint?: string; title?: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg/40 px-3 py-2.5" title={title}>
      <dt className="text-[0.6875rem] text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tracking-tight tabular-nums">
        {value}
        {hint && <span className="ml-1 text-xs font-normal text-faint">{hint}</span>}
      </dd>
    </div>
  );
}

/**
 * Each day as a cell, two rows, oldest first; shaded by quartile of the
 * busiest day. Hover or focus a day to read it.
 */
function DailyGrid({ byDay }: { byDay: TokenUsageView["byDay"] }) {
  const best = bestDay(byDay);
  const busiest = best?.tokens ?? 0;
  const [shown, setShown] = useState<{ day: string; tokens: number } | null>(null);
  const columns = Math.ceil(byDay.length / 2);
  const readout = shown ?? best;
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium text-fg-soft">Each day</h3>
        <p className="text-[0.6875rem] text-muted tabular-nums" aria-live="polite">
          {readout ? `${shown ? "" : "Busiest: "}${shortDay(readout.day)} · ${compactTokens(readout.tokens)}` : ""}
        </p>
      </div>
      <div
        className="mt-2 grid gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        onMouseLeave={() => setShown(null)}
      >
        {byDay.map((entry) => (
          <span
            key={entry.day}
            role="img"
            tabIndex={0}
            aria-label={`${shortDay(entry.day)}: ${compactTokens(entry.tokens)} tokens`}
            onMouseEnter={() => setShown(entry)}
            onFocus={() => setShown(entry)}
            onBlur={() => setShown(null)}
            className="aspect-square rounded-[3px] outline-offset-1 hover:ring-1 hover:ring-fg-soft focus-visible:outline-2 focus-visible:outline-accent"
            style={{ background: HEAT_SHADE[heatLevel(entry.tokens, busiest)] }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[0.6875rem] text-faint tabular-nums">
        <span>{byDay[0] ? shortDay(byDay[0].day) : ""}</span>
        <span className="flex items-center gap-1" aria-hidden>
          Less
          {HEAT_SHADE.map((shade) => (
            <span key={shade} className="size-2 rounded-[2px]" style={{ background: shade }} />
          ))}
          More
        </span>
        <span>{byDay.length ? shortDay(byDay[byDay.length - 1].day) : ""}</span>
      </div>
    </div>
  );
}

/** Input, cache reads, cache writes and output as one bar, each part labelled. */
function Mix({ usage }: { usage: TokenUsageView }) {
  const parts = tokenMix(usage).filter((part) => part.tokens > 0);
  return (
    <div className="mt-5">
      <h3 className="text-xs font-medium text-fg-soft">Token mix</h3>
      <div className="mt-2 flex h-2.5 gap-[2px] overflow-hidden rounded" role="img" aria-label={parts.map((p) => `${p.label} ${Math.round(p.share * 100)}%`).join(", ")}>
        {parts.map((part) => (
          <span
            key={part.key}
            title={`${part.label}: ${compactTokens(part.tokens)} (${Math.round(part.share * 100)}%)`}
            className="h-full first:rounded-l last:rounded-r"
            style={{ width: `${part.share * 100}%`, minWidth: 3, background: MIX_COLOR[part.key] }}
          />
        ))}
      </div>
      <ul className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[0.6875rem]">
        {tokenMix(usage).map((part) => (
          <li key={part.key} className="flex min-w-0 items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: MIX_COLOR[part.key] }} />
            <span className="truncate text-muted">{part.label}</span>
            <span className="ml-auto text-fg-soft tabular-nums">
              {compactTokens(part.tokens)} <span className="text-faint">{Math.round(part.share * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
