import { Monitor, Moon, Sun } from "lucide-react";
import { DropdownMenu as Menu } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { useRouteLoaderData } from "react-router";

import { cn } from "../lib/cn";
import { THEME_CHOICES, THEME_LABEL, type ThemeChoice, setTheme, useThemeChoice } from "../lib/theme";
import type { PaletteCommand } from "./command-palette";
import { Hint } from "./ui/hint";

/** The person's Appearance: as the page was drawn with it, or as switched since. */
export function useTheme(): ThemeChoice {
  const root = useRouteLoaderData("root") as { theme?: ThemeChoice } | undefined;
  return useThemeChoice(root?.theme);
}

const ICON: Record<ThemeChoice, (size: number) => ReactNode> = {
  auto: (size) => <Monitor size={size} />,
  light: (size) => <Sun size={size} />,
  dark: (size) => <Moon size={size} />,
};

const TRACK = "grid grid-cols-3 gap-0.5 rounded-lg bg-raised p-0.5 ring-1 ring-line ring-inset";
const SEGMENT =
  "flex min-w-0 items-center justify-center gap-1.5 rounded-md font-medium text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent data-[on=true]:bg-surface data-[on=true]:text-fg data-[on=true]:shadow-[0_0_0_1px_var(--color-line-strong),0_1px_2px_rgb(0_0_0/0.12)]";

/**
 * Auto, Light and Dark side by side, the current one raised: on a
 * settings page, or in a phone's sheet (`size="large"`). A radio group:
 * the arrow keys move between them.
 */
export function ThemeSwitch({ size = "small", className }: { size?: "small" | "large"; className?: string }) {
  const theme = useTheme();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = THEME_CHOICES[(index + step + THEME_CHOICES.length) % THEME_CHOICES.length]!;
    setTheme(next);
    buttons.current[THEME_CHOICES.indexOf(next)]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Appearance" className={cn(TRACK, className)}>
      {THEME_CHOICES.map((choice, index) => (
        <button
          key={choice}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={theme === choice}
          tabIndex={theme === choice ? 0 : -1}
          data-on={theme === choice}
          onClick={() => setTheme(choice)}
          onKeyDown={(event) => move(event, index)}
          className={cn(SEGMENT, size === "large" ? "h-10 text-sm" : "h-7 text-xs")}
        >
          {ICON[choice](size === "large" ? 16 : 13)}
          {THEME_LABEL[choice]}
        </button>
      ))}
    </div>
  );
}

/** The palette's commands for switching: "Use light theme" and the rest (components/command-palette.tsx). */
export const THEME_COMMANDS: PaletteCommand[] = [
  { label: "Use light theme", hint: "Appearance", icon: ICON.light(15), run: () => setTheme("light") },
  { label: "Use dark theme", hint: "Appearance", icon: ICON.dark(15), run: () => setTheme("dark") },
  { label: "Use auto theme", hint: "Appearance · Follow the system", icon: ICON.auto(15), run: () => setTheme("auto") },
];

/**
 * The same switch as a row of the account menu: a group of menu radio
 * items, so the menu's arrow keys reach it, that switch without closing
 * the menu.
 */
export function ThemeMenuSwitch({ className }: { className?: string }) {
  const theme = useTheme();
  return (
    <div className={cn("flex items-center gap-2.5 px-2.5 py-1", className)}>
      <span className="grow text-[0.8125rem] text-fg/90">Appearance</span>
      <Menu.RadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemeChoice)} aria-label="Appearance" className={cn(TRACK, "w-[7.5rem] shrink-0")}>
        {THEME_CHOICES.map((choice) => (
          <Hint key={choice} label={THEME_LABEL[choice]} side="bottom">
            <Menu.RadioItem
              value={choice}
              aria-label={THEME_LABEL[choice]}
              data-on={theme === choice}
              // Switching keeps the menu open, so the change can be seen.
              onSelect={(event) => event.preventDefault()}
              className={cn(SEGMENT, "h-7 cursor-default data-highlighted:text-fg data-highlighted:ring-1 data-highlighted:ring-line-strong")}
            >
              {ICON[choice](14)}
            </Menu.RadioItem>
          </Hint>
        ))}
      </Menu.RadioGroup>
    </div>
  );
}
