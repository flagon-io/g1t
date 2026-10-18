import { Globe, ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../lib/cn";
import type { CardSource } from "../lib/production-image";
import { DeployLink } from "./deploy";
import { ButtonLink } from "./ui";

/**
 * A thumbnail of production, linking to it: a screenshot (taken once per
 * deploy on g1t.page, or of the address of production deployed
 * elsewhere), else an image someone uploaded (lib/production-image.ts
 * `cardSources`). Each source is tried in turn, the next when one does not
 * load. The browser frame and address stay visible in every state.
 * Until an image loads, a quiet page stands in; to someone who may change the project's
 * settings it offers to add an image.
 */
export function ProductionShot({
  sources,
  href,
  label,
  note,
  addImage,
  className,
}: {
  /** The images to try, in order; empty for none. */
  sources: CardSource[];
  href: string | null;
  label: string;
  /** What the empty frame says, such as when a screenshot comes; none for a quiet frame. */
  note?: string | null;
  /** Where an image is added, for someone who may; null for anyone else. */
  addImage?: string | null;
  className?: string;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [at, setAt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // The picture last shown, kept under the next one until that has loaded
  // and faded in: a new deploy's screenshot replaces the old one rather
  // than the frame going blank while it comes.
  const [shown, setShown] = useState<CardSource | null>(null);
  const key = sources.map((source) => source.src).join("\n");
  const source = sources[at] ?? null;
  const under = source && shown && shown.src !== source.src ? shown : null;

  // Other sources (another deploy, a new upload): from the first again.
  useEffect(() => {
    setAt(0);
    setLoaded(false);
  }, [key]);

  // An image that settled before hydration fired its events unheard.
  useEffect(() => {
    const img = image.current;
    if (!img?.complete) return;
    if (img.naturalWidth > 0) setLoaded(true);
    else setAt((index) => index + 1);
  }, [source?.src]);

  // Once the new picture has faded in over it (300 ms), the old one goes.
  useEffect(() => {
    if (!loaded || !source || shown?.src === source.src) return;
    const timer = setTimeout(() => setShown(source), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `source` is the one `src` names
  }, [loaded, source?.src, shown?.src]);

  const empty = source == null;
  const waiting = !empty && !loaded ? (source.kind === "screenshot" ? "Taking a screenshot…" : "Loading the image…") : null;

  const frame = (
    <span className={cn("block w-full overflow-hidden rounded-lg border border-line bg-bg", href && "transition-colors group-hover:border-line-strong")}>
      <span className="flex h-7 items-center gap-1.5 border-b border-line bg-surface px-2.5">
        <span aria-hidden="true" className="flex shrink-0 gap-1.5">
          <span className="size-1.5 rounded-full bg-line-strong" />
          <span className="size-1.5 rounded-full bg-line-strong" />
          <span className="size-1.5 rounded-full bg-line-strong" />
        </span>
        {label && <span className="ml-1.5 min-w-0 flex-1 truncate rounded bg-bg px-2 py-px font-mono text-[0.625rem] text-muted">{label}</span>}
      </span>
      <span className="relative block aspect-16/10 w-full overflow-hidden">
        {!loaded && !under && <Placeholder waiting={waiting} note={empty && !addImage ? (note ?? null) : null} />}
        {under && (
          <img
            key={under.src}
            src={under.src}
            alt=""
            aria-hidden="true"
            width={1280}
            height={800}
            className="absolute inset-0 size-full object-cover object-top"
          />
        )}
        {source && (
          <img
            key={source.src}
            ref={image}
            src={source.src}
            alt={source.kind === "screenshot" ? `Screenshot of ${label}` : `Image of ${label}`}
            width={1280}
            height={800}
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => {
              setLoaded(false);
              setAt((index) => index + 1);
            }}
            className={cn("absolute inset-0 size-full object-cover object-top transition-opacity duration-300", loaded ? "opacity-100" : "opacity-0")}
          />
        )}
      </span>
    </span>
  );

  return (
    <div className={cn("relative", className)}>
      {href ? (
        <DeployLink href={href} className="group block" aria-label={`Visit ${label}`}>
          {frame}
        </DeployLink>
      ) : (
        frame
      )}
      {empty && addImage && (
        // Beside the link, not in it: a link holds no other link.
        <span className="pointer-events-none absolute inset-x-0 top-7 bottom-0 flex flex-col items-center justify-center gap-2 px-3 text-center">
          <ButtonLink to={addImage} variant="outline" size="xs" className="pointer-events-auto bg-surface">
            <ImagePlus size={13} />
            Add an image of your app
          </ButtonLink>
          {note && <span className="text-[0.6875rem] text-faint">{note}</span>}
        </span>
      )}
    </div>
  );
}

/** Faint page content inside the persistent browser frame while no picture is available. */
function Placeholder({ waiting, note }: { waiting: string | null; note: string | null }) {
  const line = waiting ?? note;
  return (
    <span className="absolute inset-0 flex flex-col">
      <span className="relative flex grow flex-col gap-2 p-3.5">
        <span className="h-2 w-2/5 rounded-full bg-line/80" />
        <span className="h-1.5 w-4/5 rounded-full bg-line/50" />
        <span className="h-1.5 w-3/5 rounded-full bg-line/50" />
        {line && (
          <span className="mt-auto flex items-center gap-1.5 text-[0.6875rem] text-faint">
            <Globe size={12} className={waiting ? "animate-pulse" : undefined} />
            {line}
          </span>
        )}
      </span>
    </span>
  );
}
