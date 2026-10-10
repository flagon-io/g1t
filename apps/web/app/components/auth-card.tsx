import type { ReactNode } from "react";

/**
 * The column shared by the sign-in and sign-up pages, under the logo the
 * standalone frame draws (components/standalone.tsx): a short heading, a
 * line under it, the form, and what else there is to do.
 */
export function AuthCard({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-85 flex-col pt-8">
      <h1 className="text-center text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-center text-sm text-muted">{subtitle}</p>
      <div className="mt-7">{children}</div>
      <p className="mt-6 text-center text-sm text-muted">{footer}</p>
    </main>
  );
}
