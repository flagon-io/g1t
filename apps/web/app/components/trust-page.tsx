import type { ReactNode } from "react";

/**
 * The frame of a trust page (policies, security, support, status): an
 * eyebrow, a title, a lede, and the page. Apart from the policies'
 * Markdown renderer (legal-doc.tsx), so pages without a policy on them do
 * not load it.
 */
export function TrustPage({
  eyebrow,
  title,
  lede,
  aside,
  children,
}: {
  eyebrow: ReactNode;
  title: string;
  lede?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12 sm:py-16">
      <p className="text-sm font-medium text-accent">{eyebrow}</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
      {lede && <div className="mt-3 max-w-2xl text-muted">{lede}</div>}
      <div className={aside ? "mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_14rem]" : "mt-10"}>
        <div className="min-w-0">{children}</div>
        {/* On a phone the page is read top to bottom; its contents would only push it down. */}
        {aside && <aside className="hidden lg:block">{aside}</aside>}
      </div>
    </main>
  );
}
