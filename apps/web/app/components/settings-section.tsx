import type { ReactNode } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { SwitchCard } from "./ui/switch";

/** A group of settings: its name and what it is for on the left, the settings on the right. */
export function SettingsSection({
  id,
  title,
  about,
  children,
}: {
  id?: string;
  title: string;
  about: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="grid gap-x-10 gap-y-4 border-t border-line pt-8 first:border-t-0 first:pt-0 lg:grid-cols-[16rem_1fr]"
    >
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted">{about}</p>
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}

/** A setting that is on or off, with what it means. */
export function SettingToggle({
  name,
  on,
  title,
  disabled,
  children,
}: {
  name: string;
  on: boolean;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <SwitchCard name={name} defaultChecked={on} title={title} disabled={disabled}>
      {children}
    </SwitchCard>
  );
}

/** A setting chosen from a few numbers. */
export function SettingChoice({
  name,
  value,
  options,
  title,
  disabled,
  children,
}: {
  name: string;
  value: number;
  options: [number, string][];
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 rounded-xl border border-line bg-surface p-4">
      <div className="grow">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted">{children}</p>
      </div>
      <Select name={name} defaultValue={String(value)} disabled={disabled}>
        <SelectTrigger size="sm" aria-label={title} className="w-auto min-w-28 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {options.map(([option, label]) => (
            <SelectItem key={option} value={String(option)}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
