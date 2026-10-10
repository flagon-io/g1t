import { ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useId } from "react";
import { Link, useFetcher } from "react-router";

import type { Ability, AbilityLevel, AbilitySection, AbilitySource, McpServer } from "@g1t/contracts";
import { ABILITY_LEVEL_LABELS } from "@g1t/contracts/abilities";

import { cn } from "../../lib/cn";
import { Button, ButtonLink, SubmitButton } from "../ui";
import { Badge } from "../ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field";
import { Hint } from "../ui/hint";
import { Input } from "../ui/input";
import { SelectField } from "../ui/select";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { type ActionResult, useDialogFetcher } from "./dialogs";

/** The level choices, short, as the segmented control shows them. */
const SHORT: Record<AbilityLevel, string> = { alone: "Alone", asked: "When asked", ask: "Ask first", never: "Never" };

/** The words a row's kind gets as a tag. */
const KINDS = { read: "Reads", write: "Writes in g1t", send: "Leaves g1t", restricted: "Restricted" } as const;

type Fetcher = ReturnType<typeof useFetcher<ActionResult>>;

/** What a pending change says a row is, before the page reloads. */
function pendingOf(fetcher: Fetcher, id: string): { level?: AbilityLevel; credentials?: string } | null {
  const data = fetcher.formData;
  if (!data || data.get("ability") !== id) return null;
  const intent = data.get("intent");
  if (intent === "level") return { level: String(data.get("level")) as AbilityLevel };
  if (intent === "credentials") return { credentials: String(data.get("credentials")) };
  return null;
}

/** The level control: a segmented control for those who may change it, the level as a badge for everyone else. */
export function LevelControl({ ability, agentName, canEdit, fetcher }: { ability: Ability; agentName: string; canEdit: boolean; fetcher: Fetcher }) {
  const pending = pendingOf(fetcher, ability.id);
  const level = pending?.level ?? ability.level;
  if (ability.status === "coming") return <Badge tone="neutral">Coming</Badge>;
  if (!canEdit || !ability.can_change || ability.choices.length <= 1) {
    return (
      <Badge tone={level === "never" ? "danger" : level === "alone" ? "success" : level === "ask" ? "warn" : "info"}>
        {ability.choices.length <= 1 && ability.group === "g1t" ? "Always on" : ABILITY_LEVEL_LABELS[level]}
      </Badge>
    );
  }
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={level}
      aria-label={`${ability.label} for ${agentName}`}
      disabled={fetcher.state !== "idle"}
      onValueChange={(next) => {
        if (!next || next === level) return;
        fetcher.submit({ intent: "level", ability: ability.id, level: next }, { method: "post" });
      }}
    >
      {ability.choices.map((choice) => (
        <ToggleGroupItem key={choice} value={choice} aria-label={ABILITY_LEVEL_LABELS[choice]}>
          {SHORT[choice]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Whose connection an integration ability runs on: the workspace's, or the asking person's own. */
export function CredentialsControl({ ability, source, canEdit, fetcher }: { ability: Ability; source: AbilitySource; canEdit: boolean; fetcher: Fetcher }) {
  if (ability.credentials === null) return null;
  const pending = pendingOf(fetcher, ability.id);
  const value = pending?.credentials ?? ability.credentials;
  const options = [
    { value: "workspace", label: "Workspace connection", description: `Acts as the workspace's ${source.name} connection. Owners choose this.` },
    {
      value: "asker",
      label: "Asker's connection",
      description: ability.personal_available ? `Acts as the asking person's own ${source.name} account; a Connect card when they have none.` : `${source.name} can't be connected per person yet.`,
      disabled: !ability.personal_available,
    },
  ];
  if (!canEdit || !ability.can_change) {
    return <span className="text-xs text-faint">{value === "asker" ? "Asker's connection" : "Workspace connection"}</span>;
  }
  return (
    <SelectField
      size="sm"
      className="w-auto min-w-44"
      aria-label={`Whose ${source.name} connection ${ability.label.toLowerCase()} runs on`}
      options={options}
      value={value}
      disabled={fetcher.state !== "idle"}
      onValueChange={(next) => {
        if (next === value) return;
        fetcher.submit({ intent: "credentials", ability: ability.id, credentials: next }, { method: "post" });
      }}
    />
  );
}

/** One ability's row: what it is, its tools, its level, and whose connection. */
export function AbilityRow({ ability, source, agentName, canEdit, fetcher }: { ability: Ability; source: AbilitySource; agentName: string; canEdit: boolean; fetcher: Fetcher }) {
  const off = ability.level === "never" || ability.status === "coming" || (ability.group === "integration" && !source.connected);
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-start md:gap-6">
      <div className={cn("min-w-0 grow", off && "opacity-70")}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="text-sm font-medium">{ability.label}</h4>
          {ability.status === "ready" && <Badge tone={ability.kind === "restricted" ? "danger" : ability.kind === "send" ? "warn" : "neutral"}>{KINDS[ability.kind]}</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-muted">{ability.about}</p>
        {ability.tools.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Tools it offers">
            {ability.tools.map((tool) => (
              <li key={tool} className="rounded-[5px] bg-raised px-1.5 py-px font-mono text-[0.6875rem] text-muted ring-1 ring-line ring-inset">
                {tool}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 md:flex-col md:items-end">
        <LevelControl ability={ability} agentName={agentName} canEdit={canEdit} fetcher={fetcher} />
        <CredentialsControl ability={ability} source={source} canEdit={canEdit} fetcher={fetcher} />
      </div>
    </li>
  );
}

/** A source's block: its name, whether it is connected, and its rows. */
export function SourceBlock({
  section,
  source,
  agent,
  canEdit,
  isOwner,
  slug,
  fetcher,
}: {
  section: AbilitySection;
  source: AbilitySource;
  agent: { handle: string; display_name: string };
  canEdit: boolean;
  isOwner: boolean;
  slug: string;
  fetcher: Fetcher;
}) {
  const integration = section.group === "integration";
  const mcp = section.group === "mcp";
  const askHref = `/${slug}/-/marketplace/integrations/${source.id}`;
  return (
    <article className="overflow-hidden rounded-xl border border-line bg-surface" aria-labelledby={`source-${source.id}`}>
      {(integration || mcp) && (
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line/60 px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 id={`source-${source.id}`} className="text-sm font-semibold">
              {source.name}
            </h3>
            {integration && <Badge tone={source.connected ? "success" : "neutral"}>{source.connected ? "Connected" : "Not connected"}</Badge>}
            {mcp && (
              <a href={source.href ?? "#"} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 truncate font-mono text-xs text-muted hover:text-fg">
                {source.href}
                <ExternalLink size={11} aria-hidden />
              </a>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {integration && !source.connected && (isOwner ? <ButtonLink to={source.href ?? askHref} variant="quiet">Connect</ButtonLink> : <ButtonLink to={askHref} variant="quiet">Ask an owner</ButtonLink>)}
            {integration && source.connected && source.href && (
              <Link to={source.href} className="text-xs text-muted underline-offset-2 hover:underline">
                Manage
              </Link>
            )}
            {mcp && isOwner && (
              <>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="mcp_refresh" />
                  <input type="hidden" name="server" value={source.id} />
                  <Hint label="List its tools again">
                    <SubmitButton variant="quiet" icon pending="" className="inline-flex size-8 items-center justify-center rounded-md border border-line text-muted hover:border-line-strong hover:text-fg" fetcher={fetcher} match={{ intent: "mcp_refresh", server: source.id }} aria-label={`List ${source.name}'s tools again`}>
                      <RefreshCw size={14} />
                    </SubmitButton>
                  </Hint>
                </fetcher.Form>
                <fetcher.Form method="post" onSubmit={(event) => !confirm(`Remove the ${source.name} server from ${agent.display_name}? Its tools stop being offered at once.`) && event.preventDefault()}>
                  <input type="hidden" name="intent" value="mcp_remove" />
                  <input type="hidden" name="server" value={source.id} />
                  <Hint label="Remove this server">
                    <SubmitButton variant="danger" icon pending="" className="inline-flex size-8 items-center justify-center rounded-md border border-danger/40 text-danger hover:border-danger hover:bg-danger/10" fetcher={fetcher} match={{ intent: "mcp_remove", server: source.id }} aria-label={`Remove ${source.name}`}>
                      <Trash2 size={14} />
                    </SubmitButton>
                  </Hint>
                </fetcher.Form>
              </>
            )}
          </div>
        </header>
      )}
      {source.note && <p className="px-4 py-3 text-sm text-muted">{source.note}</p>}
      {source.abilities.length > 0 && (
        <ul className="divide-y divide-line/60">
          {source.abilities.map((ability) => (
            <AbilityRow key={ability.id} ability={ability} source={source} agentName={agent.display_name} canEdit={canEdit && (!integration || source.connected)} fetcher={fetcher} />
          ))}
        </ul>
      )}
    </article>
  );
}

/** Owners add an MCP server by name and address; its tools are listed from it before it is saved. */
export function AddMcpServerDialog({ agentName, count, max }: { agentName: string; count: number; max: number }) {
  const { fetcher, open, setOpen, error, busy } = useDialogFetcher("mcp-add");
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="quiet" disabled={count >= max}>
          <Plus size={14} />
          Add a server
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an MCP server</DialogTitle>
          <DialogDescription>
            Its tools become abilities of {agentName}: each a write that asks first, unless the server says the tool only reads. The address must be HTTPS on a public host. Servers that need a key aren&apos;t supported yet.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" className="grid gap-5">
          <input type="hidden" name="intent" value="mcp_add" />
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} name="name" placeholder="weather" required autoComplete="off" pattern="[a-z0-9][a-z0-9-]{1,31}" />
            <FieldDescription>Lowercase letters, digits and hyphens. Tools are offered as name__tool.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-url`}>Address</FieldLabel>
            <Input id={`${id}-url`} name="url" type="url" placeholder="https://mcp.example.com/mcp" required autoComplete="off" />
            <FieldDescription>Where it speaks MCP over HTTP.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton variant="accent" fetcher={fetcher} match={{ intent: "mcp_add" }} busy={busy} pending="Listing its tools…">
              Add server
            </SubmitButton>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

export { McpServerCount };

/** "2 of 10 servers". */
function McpServerCount({ servers, max }: { servers: McpServer[]; max: number }) {
  return <span className="text-faint">{servers.length ? `${servers.length} of ${max}` : ""}</span>;
}
