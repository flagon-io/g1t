import { BookOpen, FileText, GitBranch, MessagesSquare, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import type { Route } from "./+types/docs";
import { page } from "../../lib/meta";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Docs · ${params.owner} · g1t` });
}

function Point({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3.5 rounded-xl border border-line bg-surface p-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-[0.8125rem] leading-relaxed text-muted">{children}</span>
      </span>
    </li>
  );
}

/** Docs mode, coming: what it will be (docs/WORKSPACE.md, "Docs"). */
export default function Docs() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center gap-2">
        <span className="flex size-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <BookOpen size={20} />
        </span>
        <span className="rounded-full px-2 py-0.5 text-[0.6875rem] font-medium tracking-wide text-muted uppercase ring-1 ring-line">Coming soon</span>
      </div>
      <h1 className="mt-5 text-3xl font-semibold tracking-tight">Docs that keep themselves true</h1>
      <p className="mt-3 max-w-2xl text-[0.9375rem] leading-relaxed text-muted">
        The workspace&apos;s written knowledge: specs, runbooks, decisions and onboarding, edited together in real time. Agents read it before they
        work and keep it current after every merge.
      </p>
      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        <Point icon={<FileText size={16} />} title="Spaces and pages">
          One space per team or project, each a tree of pages with history, comments and backlinks.
        </Point>
        <Point icon={<Sparkles size={16} />} title="Agents read and write">
          Every reply and task draws on it. Without write access, an agent&apos;s edit is a suggestion you accept or reject.
        </Point>
        <Point icon={<GitBranch size={16} />} title="Pages know what they describe">
          A page that cites code is marked stale when a merge changes it, and its owner drafts the update.
        </Point>
        <Point icon={<MessagesSquare size={16} />} title="Conversations become pages">
          &ldquo;Write this up&rdquo; in a thread makes a page from it, linked both ways, so decisions get a home.
        </Point>
      </ul>
    </div>
  );
}
