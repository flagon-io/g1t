import { type ReactNode, Suspense, lazy, useEffect, useRef, useState } from "react";

/*
 * The ⌘K palette. The dialog itself, with its search and its dependencies,
 * loads the first time it is opened, so pages that never open it do not
 * carry it.
 */
const Dialog = lazy(() => import("./command-palette-dialog"));

/** A page or action the palette can jump to. */
export type PaletteCommand = { label: string; hint?: string; to: string; icon: ReactNode };

/** Opens and closes the palette on ⌘K or Ctrl-K, from anywhere on the page. */
export function usePaletteShortcut(toggle: () => void) {
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        latest.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * ⌘K: pages and actions from what the page already knows, and, as someone
 * types, repositories, issues, pull requests and people from search
 * (command-palette-dialog.tsx).
 */
export function CommandPalette(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
  /** The repository being looked at, `owner/name`, to offer searching its code. */
  repo?: string | null;
}) {
  const [wanted, setWanted] = useState(props.open);
  useEffect(() => {
    if (props.open) setWanted(true);
  }, [props.open]);
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <Dialog {...props} />
    </Suspense>
  );
}
