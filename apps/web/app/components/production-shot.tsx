import { Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../lib/cn";

/**
 * A thumbnail of production as it is now, linking to it. The screenshot is
 * taken once per deploy; until it has loaded, or when there is none yet, a
 * quiet frame with the address stands in.
 */
export function ProductionShot({
  src,
  href,
  label,
  className,
}: {
  /** Null when nothing is deployed yet. */
  src: string | null;
  href: string | null;
  label: string;
  className?: string;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");

  // An image that settled before hydration fired its events unheard.
  useEffect(() => {
    const img = image.current;
    if (!img?.complete) return;
    setState(img.naturalWidth > 0 ? "loaded" : "failed");
  }, [src]);

  const frame = (
    <span
      className={cn(
        "relative block aspect-[16/10] w-full overflow-hidden rounded-lg border border-line bg-bg",
        href && "transition-colors group-hover:border-line-strong",
      )}
    >
      {state !== "loaded" && <Placeholder label={label} waiting={src != null && state === "loading"} />}
      {src && state !== "failed" && (
        <img
          ref={image}
          src={src}
          alt={`Screenshot of ${label}`}
          width={1280}
          height={800}
          decoding="async"
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
          className={cn(
            "absolute inset-0 size-full object-cover object-top transition-opacity duration-300",
            state === "loaded" ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </span>
  );

  return href ? (
    <a href={href} className={cn("group block", className)} aria-label={`Visit ${label}`}>
      {frame}
    </a>
  ) : (
    <div className={className}>{frame}</div>
  );
}

function Placeholder({ label, waiting }: { label: string; waiting: boolean }) {
  return (
    <span className="absolute inset-0 flex flex-col">
      <span className="flex items-center gap-1.5 border-b border-line bg-surface px-2.5 py-1.5">
        <span className="size-1.5 rounded-full bg-line-strong" />
        <span className="size-1.5 rounded-full bg-line-strong" />
        <span className="size-1.5 rounded-full bg-line-strong" />
        <span className="ml-1.5 truncate rounded bg-bg px-2 py-px font-mono text-[0.625rem] text-faint">{label}</span>
      </span>
      <span className="relative flex grow flex-col gap-2 p-3.5">
        <span className="h-2 w-2/5 rounded-full bg-line/80" />
        <span className="h-1.5 w-4/5 rounded-full bg-line/50" />
        <span className="h-1.5 w-3/5 rounded-full bg-line/50" />
        <span className="mt-auto flex items-center gap-1.5 text-[0.6875rem] text-faint">
          <Globe size={12} className={waiting ? "animate-pulse" : undefined} />
          {waiting ? "Taking a screenshot…" : "A screenshot appears after the next deploy"}
        </span>
      </span>
    </span>
  );
}
