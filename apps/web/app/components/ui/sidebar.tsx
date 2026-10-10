import { type VariantProps, cva } from "class-variance-authority";
import { PanelLeft } from "lucide-react";
import { Slot } from "radix-ui";
import { type ComponentProps, type CSSProperties, type ReactNode, createContext, useCallback, useContext, useMemo } from "react";

import { cn } from "../../lib/cn";
import { Button } from "./button";
import { Hint } from "./hint";
import { Input } from "./input";
import { Separator } from "./separator";
import { Sheet, SheetContent, SheetTitle } from "./sheet";

// shadcn/ui's sidebar, styled with g1t's tokens: the frame of the rail and
// the mode sidebar down the left of the app (components/shell.tsx,
// components/rail.tsx), and of the drawer that stands in for them on a
// phone. A provider holds whether it is open; `Sidebar` draws the column;
// header, content and footer stack inside it; groups hold a label and a
// menu of rows; `SidebarMenuButton` is one row, or one icon of the rail.
//
// The colours are the sidebar's own tokens (app.css): `sidebar` for its
// surface, `sidebar-accent` for the current row, `sidebar-border` for the
// hairlines, and `rail` for the rail's surface.
//
// Unlike shadcn's, the provider does not read the viewport: the page is
// drawn on the server, so the desktop column and the phone's drawer are
// both rendered and CSS shows one of them (`hiddenBelow`). Whoever toggles
// the sidebar decides which one to move (the shell asks `matchMedia`).

export const SIDEBAR_WIDTH = "15rem";
export const SIDEBAR_WIDTH_ICON = "3.5rem";

type SidebarContextValue = {
  /** The desktop column: shown beside the page, or folded away. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The drawer, on a phone or a narrow window. */
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  /** Shows or hides whichever of the two the window is using. */
  toggleSidebar: () => void;
  state: "expanded" | "collapsed";
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.");
  return context;
}

export function SidebarProvider({
  open,
  onOpenChange,
  openMobile,
  onOpenMobileChange,
  toggleSidebar,
  className,
  style,
  children,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openMobile: boolean;
  onOpenMobileChange: (open: boolean) => void;
  /** Shows or hides the column or the drawer, whichever the window is using. */
  toggleSidebar: () => void;
  children: ReactNode;
}) {
  const setOpen = useCallback((next: boolean) => onOpenChange(next), [onOpenChange]);
  const setOpenMobile = useCallback((next: boolean) => onOpenMobileChange(next), [onOpenMobileChange]);
  const value = useMemo<SidebarContextValue>(
    () => ({ open, setOpen, openMobile, setOpenMobile, toggleSidebar, state: open ? "expanded" : "collapsed" }),
    [open, setOpen, openMobile, setOpenMobile, toggleSidebar],
  );
  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={{ "--sidebar-width": SIDEBAR_WIDTH, "--sidebar-width-icon": SIDEBAR_WIDTH_ICON, ...style } as CSSProperties}
        className={cn("group/sidebar-wrapper contents", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

/**
 * The column itself. `variant="sidebar"` is the mode sidebar: the
 * sidebar's surface, a hairline on its page side. `variant="rail"` is the
 * narrow column of icons: the rail's surface. `collapsible="offcanvas"`
 * folds the column away when the provider says it is closed; `"icon"`
 * narrows it to its icons (rows hide their words, `group-data-
 * [collapsible=icon]`); `"none"` always shows it in full. The column is
 * positioned by whoever holds it (`className`); `hiddenBelow` names the
 * breakpoint under which only the drawer (`mobile`) is drawn.
 */
export function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "rail";
  collapsible?: "offcanvas" | "icon" | "none";
}) {
  const { state } = useSidebar();
  const collapsed = collapsible !== "none" && state === "collapsed";
  return (
    <div
      data-slot="sidebar"
      data-side={side}
      data-variant={variant}
      data-state={collapsible === "none" ? "expanded" : state}
      data-collapsible={collapsed ? collapsible : ""}
      className={cn(
        "group/sidebar flex h-full flex-col text-fg",
        variant === "rail" ? "w-(--sidebar-width-icon) bg-rail" : "w-(--sidebar-width) bg-sidebar",
        side === "left" ? "border-r border-sidebar-border" : "border-l border-sidebar-border",
        collapsible === "icon" && collapsed && "w-(--sidebar-width-icon)",
        collapsible === "offcanvas" && collapsed && "hidden",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * The same column as a drawer over the page, for a phone or a narrow
 * window: a sheet from the left that holds focus and closes on Escape or a
 * tap outside. `title` names it for a screen reader.
 */
export function SidebarMobile({
  title,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof SheetContent>, "side" | "showClose"> & { title: string }) {
  const { openMobile, setOpenMobile } = useSidebar();
  return (
    <Sheet open={openMobile} onOpenChange={setOpenMobile}>
      <SheetContent
        side="left"
        showClose={false}
        aria-describedby={undefined}
        data-slot="sidebar"
        data-mobile="true"
        data-state="expanded"
        // Focus would land on the first row and open its hint; the sheet itself takes it instead.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        className={cn("group/sidebar w-[min(var(--sidebar-width),86vw)] border-sidebar-border bg-sidebar px-0 text-fg", className)}
        {...props}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/** The button that shows or hides the sidebar: the panel icon, with its shortcut as the hint. */
export function SidebarTrigger({ hint, className, onClick, ...props }: ComponentProps<typeof Button> & { hint?: ReactNode }) {
  const { open, toggleSidebar } = useSidebar();
  const button = (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      aria-label={open ? "Hide the sidebar" : "Show the sidebar"}
      aria-expanded={open}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) toggleSidebar();
      }}
      className={className}
      {...props}
    >
      <PanelLeft size={17} />
    </Button>
  );
  return hint ? <Hint label={hint}>{button}</Hint> : button;
}

/**
 * The thin strip along the sidebar's page edge that toggles it when
 * pressed: a second way to fold it, for the pointer, beside the trigger.
 */
export function SidebarRail({ className, ...props }: ComponentProps<"button">) {
  const { open, toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      data-slot="sidebar-rail"
      aria-label={open ? "Hide the sidebar" : "Show the sidebar"}
      tabIndex={-1}
      onClick={toggleSidebar}
      className={cn(
        "absolute inset-y-0 -right-2 z-20 hidden w-4 cursor-w-resize transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-px hover:after:bg-sidebar-border sm:flex",
        "group-data-[state=collapsed]/sidebar:cursor-e-resize",
        className,
      )}
      {...props}
    />
  );
}

/** The page beside the sidebar, when the two are laid out as one flex row. */
export function SidebarInset({ className, ...props }: ComponentProps<"main">) {
  return <main data-slot="sidebar-inset" className={cn("relative flex min-h-dvh min-w-0 flex-1 flex-col bg-bg", className)} {...props} />;
}

/** A field at the top of the sidebar: search, or jump to. */
export function SidebarInput({ className, ...props }: ComponentProps<typeof Input>) {
  return <Input data-slot="sidebar-input" className={cn("h-8 bg-bg shadow-none ring-sidebar-border", className)} {...props} />;
}

export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sidebar-header" className={cn("flex shrink-0 flex-col gap-2 p-2", className)} {...props} />;
}

export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sidebar-footer" className={cn("flex shrink-0 flex-col gap-2 p-2", className)} {...props} />;
}

export function SidebarSeparator({ className, ...props }: ComponentProps<typeof Separator>) {
  return <Separator data-slot="sidebar-separator" className={cn("mx-2 my-2 w-auto bg-sidebar-border", className)} {...props} />;
}

/** What scrolls: the groups, between the header and the footer. */
export function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto [scrollbar-width:thin] group-data-[collapsible=icon]/sidebar:overflow-hidden", className)}
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sidebar-group" className={cn("relative flex w-full min-w-0 flex-col px-2", className)} {...props} />;
}

/** A group's name: small capitals, quiet, with room at the end for an action. */
export function SidebarGroupLabel({ className, asChild = false, ...props }: ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="sidebar-group-label"
      className={cn(
        "flex h-7 shrink-0 items-center rounded-md px-2 text-[0.6875rem] font-medium tracking-wide text-faint uppercase outline-none transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 focus-visible:ring-accent",
        "group-data-[collapsible=icon]/sidebar:-mt-8 group-data-[collapsible=icon]/sidebar:opacity-0",
        "[&>svg]:size-3.5 [&>svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

/** A small button at the end of a group's label: what the group makes. */
export function SidebarGroupAction({ className, asChild = false, ...props }: ComponentProps<"button"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="sidebar-group-action"
      className={cn(
        "absolute top-1 right-3 flex aspect-square w-6 items-center justify-center rounded-md p-0 text-faint outline-none transition-colors hover:bg-sidebar-accent hover:text-fg focus-visible:ring-2 focus-visible:ring-accent [&>svg]:size-3.5 [&>svg]:shrink-0",
        // A finger's target is bigger than the button.
        "after:absolute after:-inset-2 md:after:hidden",
        "group-data-[collapsible=icon]/sidebar:hidden",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroupContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sidebar-group-content" className={cn("w-full text-sm", className)} {...props} />;
}

export function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return <ul data-slot="sidebar-menu" className={cn("flex w-full min-w-0 flex-col gap-px", className)} {...props} />;
}

export function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("group/menu-item relative", className)} {...props} />;
}

/**
 * One row of a menu: an icon, its words, and whatever sits at the end
 * (a count, a chevron). `isActive` fills it; a `tooltip` shows its words
 * while the sidebar is collapsed to icons, or always for `size="icon"`.
 * `variant="faint"` is for what is coming rather than there.
 */
export const sidebarMenuButtonVariants = cva(
  [
    "peer/menu-button group/menu-button flex w-full items-center gap-2.5 overflow-hidden rounded-md text-left outline-none transition-[width,height,padding,color,background-color]",
    "hover:bg-sidebar-accent/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent active:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-fg data-[state=open]:bg-sidebar-accent data-[state=open]:text-fg",
    "data-[pending=true]:bg-sidebar-accent/60 data-[pending=true]:text-fg",
    "group-data-[collapsible=icon]/sidebar:size-10! group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:p-0!",
    "[&>span:last-child]:truncate [&>svg]:shrink-0 [&_svg]:pointer-events-none",
  ],
  {
    variants: {
      variant: {
        default: "text-muted [&>svg]:text-faint hover:[&>svg]:text-muted data-[active=true]:[&>svg]:text-fg",
        faint: "text-faint hover:text-muted [&>svg]:opacity-80",
        outline: "border border-dashed border-sidebar-border text-muted hover:border-line-strong hover:bg-transparent data-[active=true]:border-accent/50 data-[active=true]:bg-accent/10 data-[active=true]:font-normal",
      },
      size: {
        // 36px rows, 13px words and 16px icons: the sidebar's row.
        default: "h-9 px-2 text-[0.8125rem] [&>svg]:size-4",
        sm: "h-8 px-2 text-xs [&>svg]:size-3.5",
        lg: "h-11 px-2 text-sm [&>svg]:size-4",
        // The rail's: a 40px rounded square around a 20px icon, no words.
        icon: "relative size-10 justify-center overflow-visible rounded-[10px] p-0 text-muted hover:bg-sidebar-accent hover:text-fg data-[active=true]:bg-sidebar-accent data-[active=true]:text-fg [&>svg]:size-5 [&>svg]:text-current",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function SidebarMenuButton({
  asChild = false,
  isActive = false,
  isPending = false,
  variant,
  size,
  tooltip,
  className,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof sidebarMenuButtonVariants> & {
    asChild?: boolean;
    isActive?: boolean;
    /** The page it leads to is on its way. */
    isPending?: boolean;
    /** Its words, shown beside it on hover: always for `size="icon"`, else only while collapsed to icons. */
    tooltip?: ReactNode;
  }) {
  const Comp = asChild ? Slot.Root : "button";
  const { state } = useSidebar();
  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-size={size ?? "default"}
      data-active={isActive || undefined}
      data-pending={isPending || undefined}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );
  if (!tooltip || (size !== "icon" && state !== "collapsed")) return button;
  return (
    <Hint label={tooltip} side="right">
      {button}
    </Hint>
  );
}

/** A small button at the end of a row, shown on hover (`showOnHover`) or always. */
export function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: ComponentProps<"button"> & { asChild?: boolean; showOnHover?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="sidebar-menu-action"
      className={cn(
        "absolute top-1/2 right-1 flex aspect-square w-6 -translate-y-1/2 items-center justify-center rounded-md p-0 text-faint outline-none transition-colors hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent [&>svg]:size-3.5 [&>svg]:shrink-0",
        "after:absolute after:-inset-2 md:after:hidden",
        "group-data-[collapsible=icon]/sidebar:hidden",
        showOnHover &&
          "opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** A count at the end of a row: how many of what the row lists. */
export function SidebarMenuBadge({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="sidebar-menu-badge"
      className={cn(
        "pointer-events-none ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1.5 text-[0.6875rem] font-medium text-muted tabular-nums select-none",
        "bg-line peer-data-[active=true]/menu-button:bg-line-strong/60",
        "group-data-[collapsible=icon]/sidebar:hidden",
        className,
      )}
      {...props}
    />
  );
}

/** A row that is still on its way: a grey where the icon and words will be. */
export function SidebarMenuSkeleton({ className, showIcon = false, ...props }: ComponentProps<"div"> & { showIcon?: boolean }) {
  const width = useMemo(() => `${Math.floor(Math.random() * 40) + 50}%`, []);
  return (
    <div data-slot="sidebar-menu-skeleton" className={cn("flex h-9 items-center gap-2.5 rounded-md px-2", className)} {...props}>
      {showIcon && <div className="size-4 animate-pulse rounded-md bg-raised" />}
      <div className="h-3.5 max-w-(--skeleton-width) flex-1 animate-pulse rounded bg-raised" style={{ "--skeleton-width": width } as CSSProperties} />
    </div>
  );
}

/** Rows under a row: a list indented by a hairline. */
export function SidebarMenuSub({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      className={cn("mx-3.5 flex min-w-0 translate-x-px flex-col gap-px border-l border-sidebar-border px-2.5 py-0.5", "group-data-[collapsible=icon]/sidebar:hidden", className)}
      {...props}
    />
  );
}

export function SidebarMenuSubItem({ className, ...props }: ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-sub-item" className={cn("group/menu-sub-item relative", className)} {...props} />;
}

export function SidebarMenuSubButton({
  asChild = false,
  size = "md",
  isActive = false,
  className,
  ...props
}: ComponentProps<"a"> & { asChild?: boolean; size?: "sm" | "md"; isActive?: boolean }) {
  const Comp = asChild ? Slot.Root : "a";
  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-size={size}
      data-active={isActive || undefined}
      className={cn(
        "flex h-8 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-muted outline-none hover:bg-sidebar-accent/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent",
        "data-[active=true]:bg-sidebar-accent data-[active=true]:text-fg [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-faint",
        size === "sm" ? "text-xs" : "text-[0.8125rem]",
        "group-data-[collapsible=icon]/sidebar:hidden",
        className,
      )}
      {...props}
    />
  );
}
