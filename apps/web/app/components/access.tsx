import { Check, Minus } from "lucide-react";
import type { ComponentProps } from "react";

import {
  CAPABILITIES,
  OWNER_ONLY,
  REPO_ROLES,
  REPO_ROLE_LABELS,
  REPO_ROLE_SUMMARIES,
  type RepoRole,
  allows,
} from "@g1t/contracts";

import { Card } from "./ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/** A repository role picker, each role with what it is for. */
export function RoleSelect({
  roles = REPO_ROLES,
  label,
  size = "default",
  className,
  ...props
}: Omit<ComponentProps<typeof Select>, "children"> & {
  roles?: readonly RepoRole[];
  label: string;
  size?: "sm" | "default";
  className?: string;
}) {
  return (
    <Select {...props}>
      <SelectTrigger size={size} aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" className="w-72">
        {roles.map((role) => (
          <SelectItem key={role} value={role} description={REPO_ROLE_SUMMARIES[role]}>
            {REPO_ROLE_LABELS[role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * What each role can do, from the permission table itself: a row for each
 * capability, a column for each role.
 */
export function RolesTable() {
  return (
    <>
      {/* On a phone: each capability with the least role that has it. */}
      <Card asChild tone="plain" divided className="sm:hidden">
        <ul>
          {CAPABILITIES.map((row) => {
            const owners = (OWNER_ONLY as readonly string[]).includes(row.capability);
            return (
              <li key={row.capability} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 text-fg/90">{row.about}</span>
                <span className="shrink-0 text-xs whitespace-nowrap text-muted">
                  {owners ? "Owners" : row.role === "admin" ? "Admin" : `${REPO_ROLE_LABELS[row.role]} and up`}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
    <Card tone="plain" className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="border-b border-line bg-surface text-left text-xs text-muted">
            <th scope="col" className="px-4 py-2.5 font-medium">
              Can
            </th>
            {REPO_ROLES.map((role) => (
              <th key={role} scope="col" className="w-[4.5rem] px-1 py-2.5 text-center font-medium">
                {REPO_ROLE_LABELS[role]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {CAPABILITIES.map((row) => {
            const owners = (OWNER_ONLY as readonly string[]).includes(row.capability);
            return (
              <tr key={row.capability}>
                <th scope="row" className="px-4 py-2 text-left font-normal text-fg/90">
                  {row.about}
                </th>
                {REPO_ROLES.map((role) => (
                  <td key={role} className="px-1 py-2 text-center">
                    {allows(role, row.capability) ? (
                      <Check size={15} aria-label="Yes" className={`inline ${owners ? "text-muted" : "text-success"}`} />
                    ) : (
                      <Minus size={13} aria-label="No" className="inline text-line-strong" />
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
    </>
  );
}
