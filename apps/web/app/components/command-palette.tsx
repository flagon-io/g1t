import { type ReactNode, Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "../lib/cn";
import { paletteKeyLabel } from "../lib/shortcut";

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

const never = () => () => {};

function platform(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || nav.platform || nav.userAgent;
}

/**
 * The palette's shortcut as this computer writes it: ⌘K on a Mac, Ctrl K
 * elsewhere. Not shown on a touch screen, which has no keyboard to press it.
 */
export function PaletteKey({ className }: { className?: string }) {
  // The server cannot know the computer: it says ⌘K, and the browser corrects it.
  const label = useSyncExternalStore(never, () => paletteKeyLabel(platform()), () => "⌘K");
  return <kbd className={cn(className, "pointer-coarse:hidden")}>{label}</kbd>;
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
  // What had focus when it opened, the button or the page, to give it back
  // on closing: the dialog has no trigger of its own to return to.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (props.open && !wasOpen.current && typeof document !== "undefined") {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpen.current = props.open;
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <Dialog
        {...props}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected) opener.current.focus();
        }}
      />
    </Suspense>
  );
}
