import { type ReactNode, Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "../lib/cn";
import { Kbd } from "./ui/kbd";
import { PALETTE_KEY, shortcutsKeyLabel } from "../lib/shortcut";

/*
 * The search palette, opened with /. The dialog itself, with its search and
 * its dependencies, loads the first time it is opened, so pages that never
 * open it do not carry it.
 */
const Dialog = lazy(() => import("./command-palette-dialog"));

/**
 * A page the palette can jump to (`to`), or something it does in place
 * (`run`, listed under Commands), such as switching the theme.
 */
export type PaletteCommand = { label: string; hint?: string; icon: ReactNode } & ({ to: string; run?: undefined } | { run: () => void; to?: undefined });

/** Whether a key press happened in something you type into, where / and Ctrl K are the field's own. */
export function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']") != null;
}

/** Opens the palette on /, from anywhere on the page but a text field. */
export function usePaletteShortcut(toggle: () => void) {
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== PALETTE_KEY || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || inTextField(event.target)) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Opens the keyboard's shortcuts on ⌘K or Ctrl K, and on ?, from anywhere
 * but a text field, where Ctrl K is the field's own (a link, in an editor).
 */
export function useShortcutsKey(open: () => void) {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || inTextField(event.target)) return;
      const mod = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const help = event.key === "?" && !event.ctrlKey && !event.metaKey;
      if (!mod && !help) return;
      event.preventDefault();
      latest.current();
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

/** Search's key, /. Not shown on a touch screen, which has no keyboard to press it. */
export function PaletteKey({ className }: { className?: string }) {
  return <Kbd className={cn(className, "pointer-coarse:hidden")}>{PALETTE_KEY}</Kbd>;
}

/** The keyboard's shortcuts' key as this computer writes it: ⌘K on a Mac, Ctrl K elsewhere. */
export function ShortcutsKey({ className }: { className?: string }) {
  // The server cannot know the computer: it says ⌘K, and the browser corrects it.
  const label = useSyncExternalStore(
    never,
    () => shortcutsKeyLabel(platform()),
    () => "⌘K",
  );
  return <Kbd className={cn(className, "pointer-coarse:hidden")}>{label}</Kbd>;
}

/**
 * The palette (/): pages and actions from what the page already knows, and, as someone
 * types, repositories, work items, pull requests and people from search
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
