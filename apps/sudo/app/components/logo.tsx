/**
 * g1t's mark, "the fleet", copied from apps/web/app/components/logo.tsx:
 * three 1s stepping back in depth. Keep the two in step.
 */
export function Mark({ className, tight = false }: { className?: string; tight?: boolean }) {
  return (
    <svg viewBox={tight ? "6.9 5 18.2 22" : "0 0 32 32"} className={className} aria-hidden="true">
      <g transform="translate(0.7 0.5)">
        <rect x="6.2" y="9.5" width="4.4" height="17" rx="2.2" fill="var(--g1t-merged)" fillOpacity="0.35" />
        <rect x="12.4" y="7" width="4.8" height="19.5" rx="2.4" fill="var(--g1t-merged)" fillOpacity="0.65" />
        <rect x="19" y="4.5" width="5.4" height="22" rx="2.7" fill="currentColor" />
        <path d="M21.7 7.2 17.6 10.9" fill="none" stroke="currentColor" strokeWidth="4.6" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** The lockup, with sudo's badge beside it. */
export function Logo({ className = "text-[1.3rem]" }: { className?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-flex items-baseline gap-[0.3em] leading-none font-bold text-fg ${className}`}>
        <Mark tight className="h-[0.74em] w-auto shrink-0 self-baseline" />
        <span className="tracking-[-0.045em]">g1t</span>
      </span>
      <span className="rounded-full bg-merged/12 px-2 py-0.5 font-mono text-[0.7rem] font-semibold tracking-wide text-merged ring-1 ring-merged/35 ring-inset">
        sudo
      </span>
    </span>
  );
}
