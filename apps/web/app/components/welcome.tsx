import { PartyPopper } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The one-time "You're in" at the top of the workspace or repository an
 * invite led to, on the first view after joining (lib/invites.ts's
 * welcome cookie, cleared as it is shown).
 */
export function WelcomeBanner({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
      <PartyPopper size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-muted">{children}</p>
      </div>
    </div>
  );
}
