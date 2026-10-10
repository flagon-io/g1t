/**
 * The public frame's header (lib/chrome.ts, `public`): for a visitor who is
 * not signed in, on every page that is not about signing in. The logo,
 * search, Explore and Docs, and signing in or up; on a phone the links fold
 * into one menu. Someone still confirming their address gets their
 * account's menu in place of signing in.
 */
import { BookOpen, ChevronDown, Compass, CreditCard, LogIn, LogOut, Menu, Plus, Search, Settings } from "lucide-react";
import { useState } from "react";
import { Form, Link, NavLink, useParams, useSubmit } from "react-router";

import type { User } from "@g1t/contracts";

import { CommandPalette, type PaletteCommand, PaletteKey, usePaletteShortcut } from "./command-palette";
import { THEME_COMMANDS, ThemeMenuSwitch } from "./theme-switch";
import { Logo } from "./logo";
import { ButtonLink, notACredential } from "./ui";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useSignUpCopy } from "../lib/registration";

function HeaderLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-raised hover:text-fg ${
          isActive ? "text-fg" : "text-muted"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

/** What the palette offers someone without the app's sidebar. */
const PUBLIC_COMMANDS: PaletteCommand[] = [
  { label: "Explore", hint: "Public projects", to: "/explore", icon: <Compass size={15} /> },
  { label: "Search g1t", hint: "Repositories, code, issues, people", to: "/search", icon: <Search size={15} /> },
  { label: "Pricing", to: "/pricing", icon: <CreditCard size={15} /> },
  { label: "Documentation", to: "https://docs.g1t.sh/", icon: <BookOpen size={15} /> },
  { label: "Sign in", to: "/login", icon: <LogIn size={15} /> },
  { label: "Sign up", to: "/register", icon: <Plus size={15} /> },
];

/** Sign up: the sign-up page says whether it takes an invite. */
function SignUpButton() {
  const copy = useSignUpCopy();
  return <ButtonLink to="/register">{copy.primary}</ButtonLink>;
}

export function PublicHeader({ user }: { user: User | null | undefined }) {
  const submit = useSubmit();
  const signUp = useSignUpCopy();
  const [palette, setPalette] = useState(false);
  usePaletteShortcut(() => setPalette((open) => !open));
  const params = useParams();
  const repo = params.owner && params.repo ? `${params.owner}/${params.repo}` : null;
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
        <Link to="/" aria-label="g1t home" className="mr-2 flex">
          <Logo />
        </Link>
        <Form action="/search" role="search" className="relative hidden grow sm:block sm:max-w-xs">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"
          />
          <input
            name="q"
            {...notACredential()}
            placeholder="Search g1t"
            aria-label="Search g1t"
            className="w-full rounded-md border border-line bg-bg py-1.5 pr-12 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
          />
          <PaletteKey className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded bg-raised px-1.5 font-mono text-[0.625rem] text-muted ring-1 ring-line" />
        </Form>
        <Button
          type="button"
          aria-label="Search g1t"
          onClick={() => setPalette(true)}
          variant="ghost"
          size="icon-lg"
          className="sm:hidden"
        >
          <Search size={18} />
        </Button>
        <CommandPalette
          open={palette}
          onOpenChange={setPalette}
          commands={[
            ...(user ? PUBLIC_COMMANDS.slice(0, 4) : PUBLIC_COMMANDS.map((command) => (command.to === "/register" ? { ...command, label: signUp.primary } : command))),
            ...THEME_COMMANDS,
          ]}
          repo={repo}
        />
        <nav aria-label="Main" className="hidden items-center gap-0.5 sm:flex">
          <HeaderLink to="/explore">Explore</HeaderLink>
          <HeaderLink to="https://docs.g1t.sh/">Docs</HeaderLink>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {/* On a phone the links fold into one menu, so the bar fits. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-lg" aria-label="Menu" className="sm:hidden">
                <Menu size={18} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem asChild className="min-h-11">
                <Link to="/explore">
                  <Compass />
                  Explore
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild className="min-h-11">
                <Link to="https://docs.g1t.sh/">
                  <BookOpen />
                  Docs
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <ThemeMenuSwitch className="px-2" />
              {!user && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild className="min-h-11">
                    <Link to="/login">
                      <LogIn />
                      Sign in
                    </Link>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {user ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Account menu"
                  className="flex items-center gap-1.5 rounded-md p-1 outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-raised"
                >
                  <Avatar name={user.username} image={user.avatar} size={24} />
                  <ChevronDown size={14} className="text-faint" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    Signed in as{" "}
                    <span className="font-mono font-medium text-fg">
                      {user.username}
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/settings/profile">
                      <Settings />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="https://docs.g1t.sh/quickstart/">
                      <BookOpen />
                      Documentation
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <ThemeMenuSwitch className="px-2" />
                  <DropdownMenuSeparator />
                  {/* Submitted from here: the menu closes on select, and a button
                      that has left the page cannot submit a form. */}
                  <DropdownMenuItem
                    onSelect={() => submit(null, { method: "post", action: "/logout" })}
                  >
                    <LogOut />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <>
              <span className="hidden sm:contents">
                <HeaderLink to="/login">Sign in</HeaderLink>
              </span>
              <SignUpButton />
            </>
          )}
        </div>
      </div>
    </header>
  );
}

