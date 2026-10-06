import { BookMarked, Building2, CircleDot, CircleCheck, CircleSlash, FileCode2, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Lock, User } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Segment, SiteHit } from "@g1t/contracts";

import { Avatar, TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { PersonLink } from "./work";

/** Text with the parts that matched the query marked. */
export function Highlighted({ parts, className }: { parts: Segment[]; className?: string }) {
  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.highlight ? (
          <mark key={index} className="rounded-[3px] bg-accent/20 px-px text-fg">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function stateIcon(hit: SiteHit): ReactNode {
  if (hit.kind === "issue") {
    return hit.state === "open" ? (
      <CircleDot size={15} className="text-accent" aria-label="Open" />
    ) : (
      <CircleCheck size={15} className="text-merged" aria-label="Closed" />
    );
  }
  switch (hit.state) {
    case "merged":
      return <GitMerge size={15} className="text-merged" aria-label="Merged" />;
    case "closed":
      return <GitPullRequestClosed size={15} className="text-danger" aria-label="Closed" />;
    case "draft":
      return <GitPullRequestDraft size={15} className="text-faint" aria-label="Draft" />;
    default:
      return <GitPullRequest size={15} className="text-accent" aria-label="Open" />;
  }
}

/** The icon for a kind of result, for lists that mix them. */
export function hitIcon(hit: SiteHit, size = 15): ReactNode {
  switch (hit.kind) {
    case "repository":
      return hit.private ? <Lock size={size} /> : <BookMarked size={size} />;
    case "code":
      return <FileCode2 size={size} />;
    case "issue":
      return hit.state === "open" ? <CircleDot size={size} /> : <CircleSlash size={size} />;
    case "pull":
      return <GitPullRequest size={size} />;
    case "user":
      return <User size={size} />;
    case "workspace":
      return <Building2 size={size} />;
  }
}

function RepoLink({ repo }: { repo: string }) {
  return (
    <Link to={`/${repo}`} className="font-mono text-xs text-muted hover:text-fg">
      {repo}
    </Link>
  );
}

function Repository({ hit }: { hit: SiteHit }) {
  const [owner, name] = (hit.repo ?? hit.title).split("/");
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-faint">{hitIcon(hit)}</span>
        <Link to={hit.url} className="font-mono text-[0.9375rem] hover:underline">
          <span className="text-muted">{owner}/</span>
          <span className="font-semibold text-fg">{name}</span>
        </Link>
        {hit.private && <Badge>private</Badge>}
      </div>
      {hit.snippet.length > 0 && <Highlighted parts={hit.snippet} className="mt-1.5 block text-sm text-muted" />}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-faint">
        {hit.language && <span className="font-mono">{hit.language}</span>}
        {hit.topics.slice(0, 6).map((topic) => (
          <Link
            key={topic}
            to={`/explore?topic=${encodeURIComponent(topic)}`}
            className="rounded-full bg-raised px-2 py-px text-muted ring-1 ring-line hover:text-fg"
          >
            {topic}
          </Link>
        ))}
        {hit.updatedAt && (
          <span>
            Updated <TimeAgo at={hit.updatedAt} />
          </span>
        )}
      </div>
    </div>
  );
}

function Code({ hit }: { hit: SiteHit }) {
  const base = hit.url.split("#")[0];
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface px-3 py-2">
        {hit.repo && <RepoLink repo={hit.repo} />}
        <span className="text-line-strong">/</span>
        <Link to={hit.url} className="min-w-0 truncate font-mono text-sm font-medium hover:underline">
          {hit.path}
        </Link>
        {hit.private && <Badge>private</Badge>}
        {hit.language && <span className="ml-auto font-mono text-xs text-faint">{hit.language}</span>}
      </div>
      {hit.lines.length > 0 && (
        <table className="w-full table-fixed border-collapse font-mono text-[0.8125rem] leading-6">
          <tbody>
            {hit.lines.map((line, index) => {
              const gap = index > 0 && line.number !== hit.lines[index - 1]!.number + 1;
              return (
                <tr key={line.number} className={gap ? "border-t border-dashed border-line" : undefined}>
                  <td className="w-14 select-none pr-3 text-right align-top">
                    <Link to={`${base}#L${line.number}`} className="text-faint hover:text-fg">
                      {line.number}
                    </Link>
                  </td>
                  <td className="overflow-hidden pr-3 whitespace-pre text-ellipsis text-fg/90">
                    <Highlighted parts={line.parts} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Item({ hit }: { hit: SiteHit }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 shrink-0">{stateIcon(hit)}</span>
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {hit.repo && <RepoLink repo={hit.repo} />}
          <span className="font-mono text-xs text-faint">#{hit.number}</span>
          {hit.private && <Badge>private</Badge>}
        </div>
        <Link to={hit.url} className="mt-0.5 block font-medium hover:underline">
          {hit.title}
        </Link>
        {hit.snippet.length > 0 && <Highlighted parts={hit.snippet} className="mt-1 block text-sm text-muted" />}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
          {hit.author && (
            <span>
              <PersonLink name={hit.author} className="hover:text-fg" />
              {hit.requestedBy && (
                <>
                  {" "}
                  for{" "}
                  <PersonLink name={hit.requestedBy} className="hover:text-fg" />
                </>
              )}
            </span>
          )}
          {hit.labels.map((label) => (
            <span key={label} className="rounded-full px-2 py-px text-muted ring-1 ring-line">
              {label}
            </span>
          ))}
          {hit.updatedAt && (
            <span>
              Updated <TimeAgo at={hit.updatedAt} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Person({ hit }: { hit: SiteHit }) {
  const workspace = hit.kind === "workspace";
  return (
    <div className="flex items-start gap-3">
      <Avatar name={hit.slug ?? hit.title} image={hit.avatar} size={36} square={workspace} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={hit.url} className="font-medium hover:underline">
            {hit.title}
          </Link>
          <span className="font-mono text-xs text-faint">{hit.slug}</span>
          <Badge>{workspace ? "workspace" : "person"}</Badge>
        </div>
        {hit.snippet.length > 0 && <Highlighted parts={hit.snippet} className="mt-1 block text-sm text-muted" />}
      </div>
    </div>
  );
}

/** One result, drawn for its kind. */
export function SearchHitView({ hit }: { hit: SiteHit }) {
  switch (hit.kind) {
    case "repository":
      return <Repository hit={hit} />;
    case "code":
      return <Code hit={hit} />;
    case "issue":
    case "pull":
      return <Item hit={hit} />;
    case "user":
    case "workspace":
      return <Person hit={hit} />;
  }
}
