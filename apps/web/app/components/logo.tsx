/**
 * g1t's mark: an isometric cube, the unit of work in its artwork. Three
 * faces in three tones of the text colour, split by hairline gaps, so it
 * holds at any size and on any background.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      {/* Top face */}
      <path d="M16 2.5 28 9.4 16 16.3 4 9.4Z" fill="currentColor" />
      {/* Left face */}
      <path d="M4 10.9 15.3 17.4V30.2L4 23.7Z" fill="currentColor" fillOpacity="0.55" />
      {/* Right face */}
      <path d="M28 10.9 16.7 17.4V30.2L28 23.7Z" fill="currentColor" fillOpacity="0.25" />
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
