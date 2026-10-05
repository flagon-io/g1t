/**
 * g1t's mark, "the fleet": three 1s stepping back in depth, the agents at
 * work behind the one change in front. The front 1 takes the text colour;
 * the two behind it fade into lavender. The same shapes as the favicon and
 * the brand files in .g1t/brand and public/brand.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <g transform="translate(0.7 0.5)">
        {/* The agents behind */}
        <rect x="6.2" y="9.5" width="4.4" height="17" rx="2.2" fill="var(--g1t-merged)" fillOpacity="0.35" />
        <rect x="12.4" y="7" width="4.8" height="19.5" rx="2.4" fill="var(--g1t-merged)" fillOpacity="0.65" />
        {/* The 1 in front */}
        <rect x="19" y="4.5" width="5.4" height="22" rx="2.7" fill="currentColor" />
        <path d="M21.7 7.2 17.6 10.9" fill="none" stroke="currentColor" strokeWidth="4.6" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 text-fg">
      <Mark className="size-6" />
      <span className="text-[1.15rem] leading-none font-bold tracking-[-0.035em]">g1t</span>
    </span>
  );
}
