import { KeyRound, LayoutDashboard, Settings, ShieldQuestion } from "lucide-react";

import { TabLink } from "./ui";

/** The workspace's Security pages, as tabs. */
export function WorkspaceSecurityTabs({ owner, pending }: { owner: string; pending?: number }) {
  const base = `/${owner}/-/security`;
  return (
    <nav aria-label="Security" className="mb-6 flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
      <TabLink to={base} end icon={<LayoutDashboard size={14} />}>
        Overview
      </TabLink>
      <TabLink to={`${base}/bypass-requests`} icon={<ShieldQuestion size={14} />} count={pending}>
        Bypass requests
      </TabLink>
      <TabLink to={`${base}/patterns`} icon={<KeyRound size={14} />}>
        Custom patterns
      </TabLink>
      <TabLink to={`${base}/settings`} icon={<Settings size={14} />}>
        Settings
      </TabLink>
    </nav>
  );
}

/** A Security sub-page's own heading, where the layout gives it none. */
export function WorkspaceSecurityHeading({ title, about }: { title: string; about: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-sm text-muted">{about}</p>
    </header>
  );
}
