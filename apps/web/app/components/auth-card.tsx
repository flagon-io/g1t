import type { ReactNode } from "react";

import { Mark } from "./logo";

/** The centred panel shared by the sign-in and sign-up pages. */
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
    <main className="mx-auto flex max-w-sm flex-col px-4 pt-20 pb-10">
      <Mark className="size-9" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-2xl tracking-tight text-faint">{subtitle}</p>
      <div className="mt-8">{children}</div>
      <p className="mt-6 text-center text-sm text-muted">{footer}</p>
    </main>
  );
}
