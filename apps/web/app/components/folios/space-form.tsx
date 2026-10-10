/**
 * A space's settings, as a new space asks for them and its settings page
 * changes them: name, icon, address, who it is for, what they may do,
 * how agents change what is in it, and the projects it is about.
 */
import { DOC_AGENT_MODE_LABELS, DOC_ROLE_LABELS, DOC_SPACE_KIND_LABELS, type DocAgentMode, type DocRole, type DocSpace, type DocSpaceKind } from "@g1t/contracts";
import { type FormEvent, useState } from "react";

import { ErrorText } from "../ui";
import { Button } from "../ui/button";
import { SelectField } from "../ui/select";

export type SpaceFormValue = {
  name: string;
  icon: string;
  slug: string;
  description: string;
  kind: DocSpaceKind;
  team: string;
  default_role: DocRole;
  agent_mode: DocAgentMode;
  projects: string;
};

export function initialSpace(space?: DocSpace | null): SpaceFormValue {
  return {
    name: space?.name ?? "",
    icon: space?.icon ?? "",
    slug: space?.slug ?? "",
    description: space?.description ?? "",
    kind: space?.kind ?? "workspace",
    team: space?.team ?? "",
    default_role: space?.default_role ?? "edit",
    agent_mode: space?.agent_mode ?? "suggest",
    projects: (space?.projects ?? []).join(", "),
  };
}

const FIELD = "h-9 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/60";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-faint">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function SpaceForm({
  initial,
  teams,
  isDefault = false,
  submitLabel,
  busy,
  error,
  onSubmit,
}: {
  initial: SpaceFormValue;
  teams: { slug: string; name: string }[];
  isDefault?: boolean;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (value: SpaceFormValue) => void;
}) {
  const [v, setV] = useState(initial);
  const set = <K extends keyof SpaceFormValue>(key: K, value: SpaceFormValue[K]) => setV((was) => ({ ...was, [key]: value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(v);
  };
  const roles = (["view", "comment", "edit"] as DocRole[]).map((r) => ({ value: r, label: DOC_ROLE_LABELS[r] }));
  return (
    <form onSubmit={submit} className="space-y-6">
      <Row label="Name">
        <div className="flex gap-2">
          <input aria-label="Icon (an emoji)" value={v.icon} onChange={(e) => set("icon", e.target.value)} placeholder="📚" maxLength={8} className={`${FIELD} w-14 text-center`} />
          <input aria-label="Name" required value={v.name} onChange={(e) => set("name", e.target.value)} placeholder="Engineering" maxLength={80} className={FIELD} />
        </div>
      </Row>
      <Row label="Description" hint="One line on what belongs here.">
        <input aria-label="Description" value={v.description} onChange={(e) => set("description", e.target.value)} maxLength={300} placeholder="Specs, runbooks and decisions for the platform team" className={FIELD} />
      </Row>
      <Row label="Address" hint="In the space's links. Left empty, it comes from the name.">
        <input aria-label="Address" value={v.slug} onChange={(e) => set("slug", e.target.value.toLowerCase())} placeholder="engineering" pattern="[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?" className={`${FIELD} font-mono`} />
      </Row>
      <Row label="Who it's for" hint={isDefault ? "The General space is always the whole workspace's." : "Members-only spaces are only their members'. Not even owners see them unless added."}>
        <SelectField
          aria-label="Who it's for"
          value={v.kind}
          disabled={isDefault}
          onValueChange={(kind) => set("kind", kind as DocSpaceKind)}
          options={(["workspace", "team", "private"] as DocSpaceKind[]).filter((k) => k !== "team" || teams.length > 0).map((k) => ({ value: k, label: DOC_SPACE_KIND_LABELS[k] }))}
          className="h-9 w-full"
        />
      </Row>
      {v.kind === "team" && (
        <Row label="Team">
          <SelectField aria-label="Team" value={v.team} onValueChange={(team) => set("team", team)} placeholder="Choose a team" options={teams.map((t) => ({ value: t.slug, label: t.name }))} className="h-9 w-full" />
        </Row>
      )}
      {v.kind !== "private" && (
        <Row label={v.kind === "team" ? "The team can" : "Everyone can"} hint="Members you add below can be given more.">
          <SelectField aria-label="What they can do" value={v.default_role} onValueChange={(r) => set("default_role", r as DocRole)} options={roles} className="h-9 w-full" />
        </Row>
      )}
      <Row label="Agents in this space" hint="An agent never does more than the person it works for. With Suggest, its changes wait for a person to accept them.">
        <SelectField
          aria-label="Agents in this space"
          value={v.agent_mode}
          onValueChange={(m) => set("agent_mode", m as DocAgentMode)}
          options={(["suggest", "edit"] as DocAgentMode[]).map((m) => ({
            value: m,
            label: DOC_AGENT_MODE_LABELS[m],
            description: m === "suggest" ? "Tracked changes you accept or reject (recommended)" : "Agents edit directly; every edit is in the history",
          }))}
          className="h-9 w-full"
        />
      </Row>
      <Row label="Projects" hint="owner/name, comma separated. Artifacts can be filtered by project.">
        <input aria-label="Projects" value={v.projects} onChange={(e) => set("projects", e.target.value)} placeholder="acme/web, acme/api" className={`${FIELD} font-mono`} />
      </Row>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex justify-end">
        <Button type="submit" variant="accent" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** The form's value as the service takes it. */
export function spaceInput(v: SpaceFormValue) {
  return {
    name: v.name.trim(),
    icon: v.icon.trim() || null,
    slug: v.slug.trim() || null,
    description: v.description.trim() || null,
    kind: v.kind,
    team: v.kind === "team" ? v.team : null,
    default_role: v.kind === "private" ? null : v.default_role,
    agent_mode: v.agent_mode,
    projects: v.projects
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter(Boolean),
  };
}
