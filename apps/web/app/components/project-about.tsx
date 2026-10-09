import { BookOpen, Check, ChevronDown, Globe, Link2, Pencil, Plus, Rocket, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useFetcher } from "react-router";

import { MAX_PROJECT_LINKS, type Project, type ProjectLinks } from "@g1t/contracts";

import { cn } from "../lib/cn";
import { KIND_CHOICES, type KindChoice, type ShownLink, choiceOf, linksToShow } from "../lib/project-kind";
import { DeployLink } from "./deploy";
import { Input, SubmitButton } from "./ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Hint } from "./ui/hint";
import { RadioGroup, RadioOption } from "./ui/radio-group";

const LINK_ICON: Record<ShownLink["type"], ReactNode> = {
  homepage: <Globe size={14} />,
  docs: <BookOpen size={14} />,
  production: <Rocket size={14} />,
  custom: <Link2 size={14} />,
};

/**
 * A project's homepage, docs and other links, one to a line, as its About
 * shows them. Addresses already on the page are given in `shown` and left out.
 */
export function LinkList({ links, shown = [], className }: { links: ProjectLinks; shown?: (string | null | undefined)[]; className?: string }) {
  const list = linksToShow(links, shown);
  if (list.length === 0) return null;
  return (
    <ul className={cn("space-y-1.5 text-sm", className)}>
      {list.map((link) => (
        <li key={link.key} className="min-w-0">
          <DeployLink
            href={link.url}
            rel="nofollow"
            className="flex min-w-0 items-center gap-2 text-fg-soft hover:text-accent [&_svg]:shrink-0 [&_svg]:text-faint"
          >
            {LINK_ICON[link.type]}
            <span className="truncate">{link.label}</span>
          </DeployLink>
        </li>
      ))}
    </ul>
  );
}

type Row = { id: number; label: string; url: string };
let nextRow = 1;
const rowsOf = (links: ProjectLinks["custom"]): Row[] => links.map((link) => ({ id: nextRow++, ...link }));

/**
 * The fields for a project's links: its homepage, its docs, and rows of
 * others, each a label and an address, added and removed in place. Posts
 * `homepage`, `docsUrl`, and `linkLabel`/`linkUrl` per row.
 */
export function LinkFields({ links, compact = false }: { links: ProjectLinks; compact?: boolean }) {
  const [rows, setRows] = useState<Row[]>(() => rowsOf(links.custom));
  const label = "mb-1.5 block text-sm font-medium text-muted";
  return (
    <div className="space-y-4">
      {/* Says the rows below are the whole list, so removing every row clears them. */}
      <input type="hidden" name="links" value="rows" />
      <div className={cn("grid gap-4", !compact && "md:grid-cols-2")}>
        <label className="block">
          <span className={label}>Homepage</span>
          <Input
            name="homepage"
            type="text"
            inputMode="url"
            defaultValue={links.homepageInherited ? "" : (links.homepage ?? "")}
            placeholder={(links.homepageInherited && links.homepage) || "https://example.com"}
            maxLength={255}
          />
          <span className="mt-1.5 block text-xs text-faint">
            {links.homepageInherited ? "Follows the repository's website. Give one to change it here." : "Its site, or production's domain."}
          </span>
        </label>
        <label className="block">
          <span className={label}>Docs</span>
          <Input name="docsUrl" type="text" inputMode="url" defaultValue={links.docs ?? ""} placeholder="https://docs.example.com" maxLength={255} />
          <span className="mt-1.5 block text-xs text-faint">Where its documentation is read.</span>
        </label>
      </div>
      <fieldset>
        <legend className={label}>Other links</legend>
        {rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map((row, index) => (
              <li key={row.id} className="flex items-center gap-2">
                <div className="w-32 shrink-0 sm:w-40">
                  <Input name="linkLabel" defaultValue={row.label} placeholder="Label" maxLength={40} aria-label={`Link ${index + 1} label`} />
                </div>
                <div className="min-w-0 grow">
                  <Input
                    name="linkUrl"
                    type="text"
                    inputMode="url"
                    defaultValue={row.url}
                    placeholder="https://"
                    maxLength={255}
                    aria-label={`Link ${index + 1} address`}
                  />
                </div>
                <Hint label="Remove this link">
                  <button
                    type="button"
                    onClick={() => setRows((current) => current.filter((one) => one.id !== row.id))}
                    className="rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-fg"
                    aria-label={`Remove link ${index + 1}`}
                  >
                    <X size={14} />
                  </button>
                </Hint>
              </li>
            ))}
          </ul>
        )}
        {rows.length < MAX_PROJECT_LINKS ? (
          <button
            type="button"
            onClick={() => setRows((current) => [...current, { id: nextRow++, label: "", url: "" }])}
            className={cn("inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg", rows.length > 0 && "mt-2")}
          >
            <Plus size={13} />
            Add a link
          </button>
        ) : (
          <p className="mt-2 text-xs text-faint">{MAX_PROJECT_LINKS} links is the most a project keeps.</p>
        )}
        <p className="mt-1.5 text-xs text-faint">A status page, a registry listing, a chat: anything with an http or https address.</p>
      </fieldset>
    </div>
  );
}

/**
 * What a project is, as a choice of one, with production's address beside
 * Deployed elsewhere. Posts `choice` and `productionUrl`. `blocked` says
 * why a choice that stops it deploying cannot be saved yet.
 */
export function KindFields({
  project,
  choice,
  onChoice,
}: {
  project: Pick<Project, "detected" | "productionUrl" | "setting">;
  choice: KindChoice | null;
  onChoice: (choice: KindChoice) => void;
}) {
  return (
    <RadioGroup name="choice" value={choice ?? ""} onValueChange={(value) => onChoice(value as KindChoice)} aria-label="What it is" className="gap-3">
      {KIND_CHOICES.map((option) => (
        <div key={option.value}>
          <RadioOption
            value={option.value}
            label={option.label}
            description={
              option.value === "auto" ? (
                <>
                  Detected: {DETECTED[project.detected.kind]}. {project.detected.reason.detail}
                </>
              ) : (
                option.hint
              )
            }
          />
          {option.value === "elsewhere" && choice === "elsewhere" && (
            <div className="mt-2 ml-6.5 max-w-md">
              <Input
                name="productionUrl"
                type="text"
                inputMode="url"
                defaultValue={project.productionUrl ?? ""}
                placeholder="https://example.com"
                aria-label="Production's address"
                maxLength={255}
              />
              <span className="mt-1 block text-xs text-faint">Production's address, shown on its overview and wherever it is listed.</span>
            </div>
          )}
        </div>
      ))}
    </RadioGroup>
  );
}

const DETECTED: Record<Project["kind"], string> = {
  app: "an app",
  library: "a library",
  tool: "a tool",
  docs: "documentation",
  other: "something else",
};

/** The one-click choices the overview offers, without Detect, in order. */
const MENU: { value: KindChoice; label: string }[] = [
  { value: "g1t", label: "Deployed on g1t" },
  { value: "elsewhere", label: "Deployed elsewhere" },
  { value: "library", label: "Library or package" },
  { value: "tool", label: "Tool or CLI" },
  { value: "docs", label: "Documentation" },
  { value: "other", label: "Something else" },
];

/**
 * The badge of what a project is, which a person who may change its
 * settings opens to change it in one click. Posts `intent=kind` and
 * `choice` to the page's action.
 */
export function KindMenu({ project, label, canChange }: { project: Pick<Project, "setting" | "detected" | "kindReason">; label: string; canChange: boolean }) {
  const fetcher = useFetcher<{ error?: string }>();
  const current = choiceOf(project.setting);
  const badge = "inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-xs font-medium text-fg-soft ring-1 ring-line";
  if (!canChange) {
    return (
      <Hint label={project.kindReason.detail}>
        <span className={badge}>{label}</span>
      </Hint>
    );
  }
  const choose = (choice: KindChoice) => fetcher.submit({ intent: "kind", choice }, { method: "post" });
  return (
    <span className="inline-flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(badge, "transition-colors hover:ring-line-strong", fetcher.state !== "idle" && "opacity-60")}>
          {label}
          <ChevronDown size={12} className="text-faint" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{project.kindReason.detail}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {MENU.map((option) => (
            <DropdownMenuItem key={option.value} onSelect={() => choose(option.value)}>
              <span className="grow">{option.label}</span>
              {current === option.value && <Check size={14} />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => choose("auto")}>
            <span className="grow">Detect automatically</span>
            {current === "auto" && <Check size={14} />}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {fetcher.data?.error && <span className="text-xs text-danger">{fetcher.data.error}</span>}
    </span>
  );
}

/**
 * The About editor: a project's description and links, from its overview.
 * Posts `intent=about` to the page's action, and closes once saved.
 */
export function AboutEditor({ project }: { project: Pick<Project, "description" | "descriptionInherited" | "links" | "name"> }) {
  const fetcher = useFetcher<{ error?: string; notice?: string }>();
  const [open, setOpen] = useState(false);
  const saved = fetcher.state === "idle" && fetcher.data != null && !fetcher.data.error;
  useEffect(() => {
    if (saved) setOpen(false);
  }, [saved, fetcher.data]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Hint label="Edit the description and links">
        <DialogTrigger className="rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-fg" aria-label="Edit About">
          <Pencil size={14} />
        </DialogTrigger>
      </Hint>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit {project.name}'s About</DialogTitle>
          <DialogDescription>Its description and links show here, on its cards, and in its workspace's Projects.</DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" className="space-y-5">
          <input type="hidden" name="intent" value="about" />
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Description</span>
            <Input
              name="description"
              defaultValue={project.descriptionInherited ? "" : (project.description ?? "")}
              placeholder={(project.descriptionInherited && project.description) || "What it is, in a line"}
              maxLength={200}
            />
            {project.descriptionInherited && <span className="mt-1.5 block text-xs text-faint">Follows the repository's description while empty.</span>}
          </label>
          <LinkFields links={project.links} compact />
          {fetcher.data?.error && <p className="text-sm text-danger">{fetcher.data.error}</p>}
          <DialogFooter>
            <SubmitButton fetcher={fetcher} pending="Saving…">
              Save
            </SubmitButton>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}
