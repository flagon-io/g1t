/**
 * g1t's mark, "the fleet": three 1s stepping back in depth, the agents at
 * work behind the one change in front. The front 1 takes the text colour;
 * the two behind it fade into lavender. The same shapes as the favicon and
 * the brand files in .g1t/brand and public/brand.
 */
export function Mark({ className, tight = false }: { className?: string; tight?: boolean }) {
  return (
    // Square for icons; `tight` crops to the figure itself, for setting it
    // beside type, where it must stand on the baseline.
    <svg viewBox={tight ? "6.9 5 18.2 22" : "0 0 32 32"} className={className} aria-hidden="true">
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

/**
 * The lockup, as in the brand files: the mark as tall as the wordmark's
 * capitals, standing on its baseline. Sized by its font size.
 */
export function Logo({ className = "text-[1.3rem]" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-[0.3em] leading-none font-bold text-fg ${className}`}>
      <Mark tight className="h-[0.74em] w-auto shrink-0 self-baseline" />
      <span className="tracking-[-0.045em]">g1t</span>
    </span>
  );
}
