/**
 * The skill library's shared parts (docs.g1t.sh/guides/agent-skills/):
 * where a skill came from, where it is attached, the "needs a computer"
 * mark, and the dialogs that attach one.
 */
import { Bot, Building2, Cpu, GitBranch, Users } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import type { LibrarySkill, SkillAttachment, SkillLibrary, SkillOrigin, SkillScope } from "@g1t/contracts";

import { Badge } from "../ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field";
import { Hint } from "../ui/hint";
import { SelectField } from "../ui/select";
import { BUTTONS, useDialogFetcher } from "./dialogs";

/** `/acme/-/agents/skills`, or one skill's page. */
export function skillsPath(slug: string, name?: string, rest = ""): string {
  return `/${slug}/-/agents/skills${name ? `/${encodeURIComponent(name)}` : ""}${rest}`;
}

/** Where a version came from, in a few words. */
export function originText(origin: SkillOrigin): string {
  switch (origin.kind) {
    case "written":
      return "Written in g1t";
    case "upload":
      return `Uploaded from ${origin.filename}`;
    case "repository":
      return `From ${origin.repo}${origin.path && origin.path !== "." ? `, ${origin.path}` : ""} at ${origin.commit.slice(0, 7)}`;
    case "session":
      return `Drafted by @${origin.agent} from “${origin.title}”`;
    case "mirror":
      return `From ${origin.repo} at ${origin.commit.slice(0, 7)}`;
  }
}

const SCOPE_ICONS: Record<SkillScope, typeof Bot> = { agent: Bot, team: Users, workspace: Building2 };

/** Where a skill is attached, as a small chip. */
export function AttachmentChip({ attachment, latest }: { attachment: Pick<SkillAttachment, "scope" | "label" | "version">; latest?: number }) {
  const Icon = SCOPE_ICONS[attachment.scope];
  const behind = latest != null && attachment.version < latest;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-raised px-2 py-0.5 text-xs text-fg-soft ring-1 ring-line ring-inset">
      <Icon size={12} className="shrink-0 text-faint" aria-hidden />
      <span className="truncate">{attachment.label}</span>
      {behind && <span className="shrink-0 text-faint">v{attachment.version}</span>}
    </span>
  );
}

/** Marked on a skill that needs the agent's own computer, which is coming. `plain` inside a link, where a hint can't be focused. */
export function NeedsComputer({ plain }: { plain?: boolean }) {
  if (plain) {
    return (
      <Badge tone="warn">
        <Cpu size={11} aria-hidden />
        Needs a computer · Coming
      </Badge>
    );
  }
  return (
    <Hint label="Its scripts run only on an agent's own computer, which is coming. Until then agents follow its instructions and never run its scripts.">
      <span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <Badge tone="warn">
          <Cpu size={11} aria-hidden />
          Needs a computer · Coming
        </Badge>
      </span>
    </Hint>
  );
}

/** Marked on a skill that follows the linked repository. */
export function FromRepository({ repo, plain }: { repo: string | null; plain?: boolean }) {
  if (plain) {
    return (
      <Badge tone="info">
        <GitBranch size={11} aria-hidden />
        From the repository
      </Badge>
    );
  }
  return (
    <Hint label={repo ? `Changed in ${repo}, under .g1t/skills/: a push there publishes a new version.` : "Changed in the linked repository."}>
      <span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <Badge tone="info">
          <GitBranch size={11} aria-hidden />
          From the repository
        </Badge>
      </span>
    </Hint>
  );
}

/** Where a skill may be attached by this viewer: every agent and agents for owners, the teams they maintain. */
function targets(library: Pick<SkillLibrary, "can_manage" | "teams" | "agents">, attached: SkillAttachment[]) {
  const taken = new Set(attached.map((a) => `${a.scope}:${a.target ?? ""}`));
  const options: { value: string; label: string; disabled?: boolean }[] = [];
  if (library.can_manage) options.push({ value: "workspace:", label: "Every agent in the workspace", disabled: taken.has("workspace:") });
  for (const team of library.teams) options.push({ value: `team:${team.slug}`, label: `Team: ${team.name}`, disabled: taken.has(`team:${team.slug}`) });
  if (library.can_manage) for (const agent of library.agents) options.push({ value: `agent:${agent.handle}`, label: `${agent.display_name} (@${agent.handle})`, disabled: taken.has(`agent:${agent.handle}`) });
  return options;
}

/** Attach a skill to every agent, a team or one agent: the newest version is pinned. */
export function AttachDialog({
  skill,
  library,
  action,
  trigger,
}: {
  skill: LibrarySkill;
  library: Pick<SkillLibrary, "can_manage" | "teams" | "agents">;
  action?: string;
  trigger: ReactNode;
}) {
  const { fetcher, open, setOpen, error, busy } = useDialogFetcher(`attach-${skill.id}`);
  const id = useId();
  const options = targets(library, skill.attachments);
  const [where, setWhere] = useState(options.find((o) => !o.disabled)?.value ?? "");
  const [scope, target] = where ? [where.slice(0, where.indexOf(":")), where.slice(where.indexOf(":") + 1)] : ["", ""];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach {skill.name}</DialogTitle>
          <DialogDescription>
            Agents it reaches see its name and when to use it, and read it when a request matches. Version {skill.version} is pinned there; a newer version reaches them when someone
            moves the pin.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={action} className="grid gap-5">
          <input type="hidden" name="intent" value="attach" />
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="target" value={target} />
          <Field>
            <FieldLabel htmlFor={`${id}-where`}>Attach to</FieldLabel>
            {options.length ? (
              <SelectField id={`${id}-where`} options={options} value={where} onValueChange={setWhere} placeholder="Choose where" />
            ) : (
              <p className="text-sm text-muted">There is nowhere you can attach it. Owners attach skills anywhere; team maintainers attach them to their teams.</p>
            )}
            <FieldDescription>A team&apos;s skills reach every agent on it. A skill never gives an agent a tool or access it doesn&apos;t have.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <button type="button" className={BUTTONS.QUIET} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className={BUTTONS.PRIMARY} disabled={busy || !where}>
              {busy ? "Attaching…" : "Attach"}
            </button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/** From an agent's Skills tab: attach one of the library's skills to this agent. */
export function AttachToAgentDialog({ agentName, skills, trigger }: { agentName: string; skills: Pick<LibrarySkill, "name" | "description" | "version">[]; trigger: ReactNode }) {
  const { fetcher, open, setOpen, error, busy } = useDialogFetcher("attach-to-agent");
  const id = useId();
  const [name, setName] = useState(skills[0]?.name ?? "");
  const chosen = skills.find((s) => s.name === name);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach a skill to {agentName}</DialogTitle>
          <DialogDescription>From your workspace&apos;s library. Its newest version is pinned; {agentName} reads it when a request matches.</DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" className="grid gap-5">
          <input type="hidden" name="intent" value="attach" />
          <input type="hidden" name="name" value={name} />
          <Field>
            <FieldLabel htmlFor={`${id}-skill`}>Skill</FieldLabel>
            {skills.length ? (
              <SelectField id={`${id}-skill`} options={skills.map((s) => ({ value: s.name, label: s.name }))} value={name} onValueChange={setName} />
            ) : (
              <p className="text-sm text-muted">Every published skill in the library already reaches {agentName}.</p>
            )}
            {chosen && <FieldDescription>{chosen.description}</FieldDescription>}
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <button type="button" className={BUTTONS.QUIET} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className={BUTTONS.PRIMARY} disabled={busy || !name}>
              {busy ? "Attaching…" : "Attach"}
            </button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}
