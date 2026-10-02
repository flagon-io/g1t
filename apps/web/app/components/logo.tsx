/** Three lanes converging on one node: many pull requests, one merged. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      strokeWidth="2.5"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 7h6c7 0 7 9 14 9" className="stroke-muted" />
      <path d="M4 25h6c7 0 7-9 14-9" className="stroke-muted" />
      <path d="M4 16h20" className="stroke-accent" />
      <circle cx="25" cy="16" r="3.5" className="fill-accent" stroke="none" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2">
      <Mark className="size-6" />
      <span className="font-mono text-lg font-semibold tracking-tight">
        g<span className="text-accent">1</span>t
      </span>
    </span>
  );
}
