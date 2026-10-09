/**
 * The top of a project's overview for what g1t does not deploy: an app
 * deployed elsewhere, an app nobody has said where it runs, docs, and
 * anything else. An app on g1t keeps its production card, and a library
 * or a tool its packages (routes/repo/overview.tsx).
 */
import { ArrowUpRight, BookOpen, Box, ChevronDown, GitCommitHorizontal, Globe, Rocket } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { DeployStatus, Project } from "@g1t/contracts";

import { DeployLink, host, StatusDot } from "./deploy";
import { ButtonLink, Input, SubmitButton, TimeAgo } from "./ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Hint } from "./ui/hint";

/**
 * A deployment reported to g1t from outside it, such as by a pipeline that
 * deploys production itself. When there is one for production, the card
 * shows it.
 */
export type ExternalDeployment = {
  environment: string;
  url: string | null;
  /** success, failure, error, pending, queued, in_progress or inactive. */
  state: string;
  sha: string;
  created_at: string;
};

/** A reported deployment's state, as g1t's own deployments show theirs. */
export function deploymentStatus(state: string): DeployStatus {
  switch (state) {
    case "success":
      return "ready";
    case "failure":
    case "error":
      return "failed";
    case "in_progress":
      return "building";
    case "inactive":
      return "replaced";
    default:
      return "queued";
  }
}

type Head = {
  project: Project;
  base: string;
  /** May change the project's settings: what it is, its links. */
  canChange: boolean;
  /** May turn on Deployments. */
  canDeploy: boolean;
};

export function HeadLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase [&_svg]:size-3.25 [&_svg]:text-accent">
      {icon}
      {children}
    </p>
  );
}

function BigLink({ url }: { url: string }) {
  return (
    <DeployLink href={url} className="mt-2 flex min-w-0 items-center gap-1.5 font-mono text-lg font-medium hover:text-accent">
      <span className="truncate">{host(url).replace(/\/$/, "")}</span>
      <ArrowUpRight size={16} className="shrink-0 text-faint" />
    </DeployLink>
  );
}

/** An address, saved for the project in place: production's, or its docs'. */
function AddressForm({
  field,
  placeholder,
  label,
  extra,
}: {
  field: "productionUrl" | "docsUrl";
  placeholder: string;
  label: string;
  /** Hidden fields sent with it. */
  extra: Record<string, string>;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  return (
    <fetcher.Form method="post" className="mt-3 max-w-lg">
      {Object.entries(extra).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="flex items-center gap-2">
        <div className="min-w-0 grow">
          <Input name={field} type="text" inputMode="url" required placeholder={placeholder} aria-label={label} maxLength={255} />
        </div>
        <SubmitButton fetcher={fetcher} variant="quiet" pending="Saving…">
          Save
        </SubmitButton>
      </div>
      {fetcher.data?.error && <p className="mt-1.5 text-xs text-danger">{fetcher.data.error}</p>}
    </fetcher.Form>
  );
}

/** Deploying on g1t, offered as an option and never as a step. */
function DeployQuietly({ base, canDeploy, what }: { base: string; canDeploy: boolean; what: string }) {
  if (!canDeploy) return null;
  return (
    <p className="mt-4 text-xs text-faint">
      g1t can deploy {what} on g1t.page instead, with a preview for every pull request.{" "}
      <Link to={`${base}/settings/deployments`} className="underline-offset-4 hover:text-fg hover:underline">
        Deployment settings
      </Link>
    </p>
  );
}

/**
 * An app deployed by its own pipeline: production at the address it was
 * given, with the latest reported deployment, or else the default branch's
 * latest commit and its checks.
 */
export function ElsewhereHead({
  project,
  base,
  canChange,
  canDeploy,
  deployment,
  commit,
  checks,
}: Head & {
  deployment?: ExternalDeployment | null;
  commit: { hash: string; authoredAt: string } | null;
  /** The commit's checks, as a badge; left out until there is one to show. */
  checks?: ReactNode;
}) {
  const url = deployment?.url ?? project.productionUrl;
  return (
    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
      <div className="min-w-0">
        <HeadLabel icon={<Rocket />}>Production</HeadLabel>
        {url ? (
          <>
            <BigLink url={url} />
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {deployment ? (
                <>
                  <StatusDot status={deploymentStatus(deployment.state)} />
                  <span className="inline-flex items-center gap-1 font-mono">
                    <GitCommitHorizontal size={13} className="text-faint" />
                    {deployment.sha.slice(0, 7)}
                  </span>
                  <span>
                    deployed <TimeAgo at={deployment.created_at} />
                  </span>
                </>
              ) : (
                <>
                  <span>Deployed by its own pipeline</span>
                  {commit && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-faint">·</span>
                      <Link to={`${base}/commit/${commit.hash}`} className="inline-flex items-center gap-1 font-mono hover:text-fg">
                        <GitCommitHorizontal size={13} className="text-faint" />
                        {commit.hash.slice(0, 7)}
                      </Link>
                      {checks}
                      <TimeAgo at={commit.authoredAt} />
                    </span>
                  )}
                </>
              )}
            </p>
          </>
        ) : canChange ? (
          <>
            <p className="mt-2 text-lg font-medium">Where is production?</p>
            <p className="mt-1 max-w-lg text-sm text-muted">
              {project.name} is deployed by its own pipeline. Give production's address, and this card links to it.
            </p>
            <AddressForm field="productionUrl" placeholder="https://example.com" label="Production's address" extra={{ intent: "kind", choice: "elsewhere" }} />
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">Deployed by its own pipeline.</p>
        )}
        <DeployQuietly base={base} canDeploy={canDeploy} what="it" />
      </div>
      {url && (
        <div className="flex shrink-0 items-center gap-2">
          <ButtonLink to={url} variant="accent" reloadDocument target="_blank" rel="noopener noreferrer">
            Visit
            <ArrowUpRight size={14} />
          </ButtonLink>
        </div>
      )}
    </div>
  );
}

const NOT_DEPLOYED: { value: string; label: string }[] = [
  { value: "library", label: "A library or package" },
  { value: "tool", label: "A tool or CLI" },
  { value: "docs", label: "Documentation" },
  { value: "other", label: "Something else" },
];

/**
 * An app that nobody has said where it runs, with Deployments off: one
 * question, answered in place, instead of a push to turn Deployments on.
 */
export function WhereItRuns({ project, base, canChange, canDeploy }: Head) {
  const fetcher = useFetcher<{ error?: string }>();
  const [elsewhere, setElsewhere] = useState(false);
  if (!canChange) {
    return (
      <div className="p-5 sm:p-6">
        <HeadLabel icon={<Globe />}>Homepage</HeadLabel>
        {project.links.homepage ? <BigLink url={project.links.homepage} /> : <p className="mt-2 text-sm text-muted">No homepage given.</p>}
      </div>
    );
  }
  return (
    <div className="p-5 sm:p-6">
      <HeadLabel icon={<Rocket />}>Production</HeadLabel>
      <p className="mt-2 text-lg font-medium">Where does {project.name} run?</p>
      <p className="mt-1 max-w-xl text-sm text-muted">
        Say once, and this page follows: production where it is deployed, or its packages and releases if it isn't
        deployed at all. <span className="text-faint">{project.detected.reason.detail}</span>
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canDeploy && (
          <ButtonLink to={`${base}/settings/deployments`} variant="quiet">
            <Rocket size={14} />
            Deploy on g1t
          </ButtonLink>
        )}
        <button
          type="button"
          onClick={() => setElsewhere((open) => !open)}
          aria-expanded={elsewhere}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-medium text-fg/80 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg"
        >
          <Globe size={14} />
          It's deployed elsewhere
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex items-center justify-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-medium text-fg/80 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg">
            <Box size={14} />
            It isn't deployed
            <ChevronDown size={13} className="text-faint" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {NOT_DEPLOYED.map((option) => (
              <DropdownMenuItem key={option.value} onSelect={() => fetcher.submit({ intent: "kind", choice: option.value }, { method: "post" })}>
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {elsewhere && (
        <AddressForm field="productionUrl" placeholder="Production's address, such as https://example.com" label="Production's address" extra={{ intent: "kind", choice: "elsewhere" }} />
      )}
      {fetcher.data?.error && <p className="mt-2 text-xs text-danger">{fetcher.data.error}</p>}
    </div>
  );
}

/** Documentation: where it is read, or a place to say so. */
export function DocsHead({ project, base, canChange, canDeploy }: Head) {
  const url = project.links.docs ?? project.productionUrl ?? project.links.homepage;
  return (
    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
      <div className="min-w-0">
        <HeadLabel icon={<BookOpen />}>Documentation</HeadLabel>
        {url ? (
          <BigLink url={url} />
        ) : canChange ? (
          <>
            <p className="mt-2 text-lg font-medium">Where are its docs read?</p>
            <p className="mt-1 max-w-lg text-sm text-muted">Give the address, and this card and its listing link to it.</p>
            <AddressForm field="docsUrl" placeholder="https://docs.example.com" label="Where its docs are read" extra={{ intent: "about" }} />
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">Its docs are in its repository.</p>
        )}
        <DeployQuietly base={base} canDeploy={canDeploy && project.runs == null} what="its docs as a site" />
      </div>
      {url && (
        <div className="flex shrink-0 items-center gap-2">
          <ButtonLink to={url} variant="accent" reloadDocument target="_blank" rel="noopener noreferrer">
            Read
            <ArrowUpRight size={14} />
          </ButtonLink>
        </div>
      )}
    </div>
  );
}

/** Anything else: its homepage, or where to add its links. */
export function OtherHead({ project, base, canChange }: Omit<Head, "canDeploy">) {
  const url = project.links.homepage ?? project.links.docs ?? project.links.custom[0]?.url ?? null;
  return (
    <div className="p-5 sm:p-6">
      <HeadLabel icon={<Globe />}>Homepage</HeadLabel>
      {url ? (
        <BigLink url={url} />
      ) : canChange ? (
        <p className="mt-2 text-sm text-muted">
          No links yet.{" "}
          <Link to={`${base}/settings#links`} className="text-accent hover:underline">
            Add a homepage, docs or others
          </Link>{" "}
          and they show here, on its card and in its workspace's Projects.
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">No homepage given.</p>
      )}
    </div>
  );
}

/** Production as g1t serves it, with the project's homepage when that is somewhere else. */
export function AlsoAt({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <Hint label="Its homepage">
      <DeployLink href={url} className="inline-flex items-center gap-1 text-faint hover:text-fg">
        <Globe size={12} />
        {host(url).replace(/\/$/, "")}
      </DeployLink>
    </Hint>
  );
}
