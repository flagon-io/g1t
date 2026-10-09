/**
 * A release as the Releases page and its own page show it: when and of
 * which tag and commit on the left, its title, notes and downloads on the
 * right; one above the other on a phone.
 */
import { FileArchive, GitCommitHorizontal, Tag as TagIcon } from "lucide-react";
import { Link } from "react-router";

import type { Release, RepoPath } from "@g1t/contracts";

import { Markdown } from "./markdown";
import { Pill, TimeAgo } from "./ui";
import { UserCard } from "./user-card";

export function encodeTag(tag: string): string {
  return tag.split("/").map(encodeURIComponent).join("/");
}

export function ReleaseCard({ release, repo, linkTitle = true }: { release: Release; repo: RepoPath; linkTitle?: boolean }) {
  const base = `/${repo.namespace}/${repo.name}`;
  const title = release.name || release.tagName;
  const when = release.publishedAt ?? release.createdAt;
  return (
    <article className="grid gap-4 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted md:flex-col md:items-start md:pt-4">
        <span className="text-faint">
          <TimeAgo at={when} />
        </span>
        <Link to={`${base}/tree/${encodeTag(release.tagName)}`} className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[0.8125rem] hover:text-accent">
          <TagIcon size={14} className="shrink-0 text-faint" />
          <span className="truncate">{release.tagName}</span>
        </Link>
        <Link to={`${base}/commit/${release.target}`} className="inline-flex items-center gap-1.5 font-mono text-[0.8125rem] hover:text-accent">
          <GitCommitHorizontal size={14} className="shrink-0 text-faint" />
          {release.target.slice(0, 7)}
        </Link>
      </div>
      <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
        <div className="border-b border-line px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 text-xl font-semibold tracking-tight break-words">
              {linkTitle ? (
                <Link to={`${base}/releases/tag/${encodeTag(release.tagName)}`} className="hover:text-accent hover:underline">
                  {title}
                </Link>
              ) : (
                title
              )}
            </h3>
            {release.latest && <Pill>Latest</Pill>}
            {release.prerelease && <Pill>Pre-release</Pill>}
            {release.draft && <Pill>Draft</Pill>}
          </div>
          {release.author && (
            <p className="mt-1 text-xs text-faint">
              <UserCard username={release.author}>
                <Link to={`/u/${release.author}`} className="font-medium text-muted hover:text-accent">
                  {release.author}
                </Link>
              </UserCard>{" "}
              {release.draft ? "drafted this" : "released this"} <TimeAgo at={when} />
            </p>
          )}
        </div>
        <div className="px-5 py-4">
          {release.body.trim() ? (
            <Markdown
              source={release.body}
              repo={repo}
              base={`${base}/blob/${encodeTag(release.tagName)}`}
              rawBase={`${base}/raw/${encodeURIComponent(release.tagName)}`}
            />
          ) : (
            <p className="text-sm text-faint">No notes.</p>
          )}
        </div>
        <div className="border-t border-line px-5 py-3">
          <h4 className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">Downloads</h4>
          <a
            href={`${base}/archive/${encodeTag(release.tagName)}.zip`}
            download
            className="inline-flex items-center gap-2 text-sm text-muted hover:text-accent"
          >
            <FileArchive size={14} className="text-faint" />
            Source code (zip)
          </a>
        </div>
      </div>
    </article>
  );
}
