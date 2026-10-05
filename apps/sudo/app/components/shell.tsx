/**
 * sudo's frame. On wide screens, a sidebar: Overview and Reach out as
 * links, then sections that fold open to their pages, as GitLab and
 * Vercel do theirs (apps/web's project sidebar is the same pattern). On a
 * phone, a top bar whose menu holds the same. sudo ships no JavaScript,
 * so every fold is a <details>, drawn open on the server for the section
 * holding the current page. All of it comes from lib/nav.ts.
 */
import {
  Bot,
  Building2,
  Boxes,
  ChevronRight,
  CircleDollarSign,
  Cloud,
  CreditCard,
  Eye,
  FileText,
  Gauge,
  HandCoins,
  Inbox,
  LayoutDashboard,
  LifeBuoy,
  type LucideIcon,
  Megaphone,
  Menu,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  Tags,
  UserCog,
  Users,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import { Link, useLocation } from "react-router";

import { Logo } from "~/components/logo";
import { NAV, type NavGroup, type NavIcon, type NavItem, holdsCurrent, isCurrent } from "~/lib/nav";

const ICONS: Record<NavIcon, LucideIcon> = {
  overview: LayoutDashboard,
  workspaces: Boxes,
  enterprises: Building2,
  "reach-out": Zap,
  people: Users,
  invoices: FileText,
  prices: Tags,
  credits: HandCoins,
  usage: Gauge,
  stripe: CreditCard,
  costs: Cloud,
  agents: Bot,
  abuse: ShieldAlert,
  inbox: Inbox,
  "view-as": Eye,
  announcements: Megaphone,
  staff: UserCog,
  audit: ScrollText,
  customers: UsersRound,
  revenue: CircleDollarSign,
  platform: Server,
  support: LifeBuoy,
  team: UserCog,
};

/** A page's or section's icon, as the sidebar shows it. */
export function NavGlyph({ icon, size = 15, className }: { icon: NavIcon; size?: number; className?: string }) {
  const Icon = ICONS[icon];
  return <Icon size={size} className={className} />;
}

function SoonPill() {
  return (
    <span className="shrink-0 rounded-full px-1.5 py-px text-[0.625rem] font-medium tracking-wide text-muted uppercase ring-1 ring-line">
      Soon
    </span>
  );
}

/** A top-level link, with its icon. */
function TopLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const current = isCurrent(item, pathname);
  return (
    <Link
      to={item.to}
      title={item.about}
      aria-current={current ? "page" : undefined}
      className={`group flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors ${
        current ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"
      }`}
    >
      <NavGlyph icon={item.icon} className={`shrink-0 ${current ? "text-merged" : "text-faint group-hover:text-muted"}`} />
      <span className="min-w-0 grow truncate">{item.label}</span>
      {item.soon && <SoonPill />}
    </Link>
  );
}

/** A page inside a section: indented, no icon, the current one marked in lavender. */
function SubLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const current = isCurrent(item, pathname);
  return (
    <Link
      to={item.to}
      title={item.about}
      aria-current={current ? "page" : undefined}
      className={`relative flex h-8 items-center gap-2 rounded-md pr-2 pl-[2.375rem] text-[0.8125rem] transition-colors ${
        current
          ? "bg-raised font-medium text-fg before:absolute before:top-1.5 before:bottom-1.5 before:left-[1.1875rem] before:z-10 before:w-px before:bg-merged"
          : item.soon
            ? "text-faint hover:bg-raised/60 hover:text-muted"
            : "text-muted hover:bg-raised/60 hover:text-fg"
      }`}
    >
      <span className="min-w-0 grow truncate">{item.label}</span>
      {item.soon && <SoonPill />}
    </Link>
  );
}

/** A section: one row that folds open to its pages. Open when it holds the current page. */
function Section({ group, pathname }: { group: NavGroup & { title: string }; pathname: string }) {
  const current = holdsCurrent(group, pathname);
  const allSoon = group.items.every((item) => item.soon);
  return (
    <details open={current} className="group/section">
      <summary
        className={`group flex h-8 cursor-pointer list-none items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors select-none hover:bg-raised/60 [&::-webkit-details-marker]:hidden ${
          current ? "text-fg" : allSoon ? "text-faint hover:text-muted" : "text-muted hover:text-fg"
        }`}
      >
        {group.icon && <NavGlyph icon={group.icon} className={`shrink-0 ${current ? "text-muted" : "text-faint group-hover:text-muted"}`} />}
        <span className={`min-w-0 grow truncate ${current ? "font-medium" : ""}`}>{group.title}</span>
        {allSoon && (
          <span className="group-open/section:hidden">
            <SoonPill />
          </span>
        )}
        <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-faint transition-transform duration-150 group-open/section:rotate-90" />
      </summary>
      <ul className="relative mt-px mb-1 space-y-px before:absolute before:top-1 before:bottom-1 before:left-[1.1875rem] before:w-px before:bg-line">
        {group.items.map((item) => (
          <li key={item.to}>
            <SubLink item={item} pathname={pathname} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function NavTree({ pathname }: { pathname: string }) {
  return (
    <div className="space-y-px">
      {NAV.map((group, index) =>
        group.title ? (
          <Section key={group.title} group={group as NavGroup & { title: string }} pathname={pathname} />
        ) : (
          <ul key={index} className={`space-y-px ${index === 0 ? "" : "pt-2"} ${index < NAV.length - 1 ? "pb-2" : ""}`}>
            {group.items.map((item) => (
              <li key={item.to}>
                <TopLink item={item} pathname={pathname} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/** Who is signed in: a panel of its own at the foot of the menu. */
function SignedIn({ email }: { email: string | null | undefined }) {
  return (
    <div className="border-t border-line bg-raised/40 px-4 py-3">
      {email && (
        <p title="Signed in through Cloudflare Access" className="flex items-center gap-2 text-[0.8125rem]">
          <ShieldCheck size={15} className="shrink-0 text-merged" />
          <span className="min-w-0 truncate font-mono text-xs text-fg-soft">{email}</span>
        </p>
      )}
      <p className="mt-1.5 text-[0.6875rem] leading-snug text-faint">g1t staff only. Every change is recorded with who made it.</p>
    </div>
  );
}

/** The sidebar, from `lg` up. */
export function Sidebar({ email }: { email: string | null | undefined }) {
  const { pathname } = useLocation();
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-surface/50 lg:flex">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Link to="/" aria-label="sudo overview">
          <Logo />
        </Link>
      </div>
      <nav aria-label="sudo" className="grow overflow-y-auto px-2 pt-2 pb-6">
        <NavTree pathname={pathname} />
      </nav>
      <div className="shrink-0">
        <SignedIn email={email} />
      </div>
    </aside>
  );
}

/** The top bar and its menu, below `lg`. */
export function MobileBar({ email }: { email: string | null | undefined }) {
  const { pathname } = useLocation();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur lg:hidden">
      <div className="flex h-14 items-center justify-between gap-2 px-4">
        <Link to="/" aria-label="sudo overview">
          <Logo />
        </Link>
        {/* A details element: it opens and closes with no script. A link
            loads a new page, which arrives with the menu closed. */}
        <details className="group/menu">
          <summary
            aria-label="Menu"
            className="flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md border border-line px-2.5 text-sm text-muted transition-colors select-none hover:border-line-strong hover:text-fg group-open/menu:border-line-strong group-open/menu:text-fg [&::-webkit-details-marker]:hidden"
          >
            <Menu size={16} className="group-open/menu:hidden" />
            <X size={16} className="hidden group-open/menu:block" />
            Menu
          </summary>
          <div className="absolute inset-x-0 top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto border-b border-line bg-bg shadow-2xl shadow-black/50">
            <nav aria-label="sudo" className="px-2 pt-3 pb-4">
              <NavTree pathname={pathname} />
            </nav>
            <SignedIn email={email} />
          </div>
        </details>
      </div>
    </header>
  );
}
