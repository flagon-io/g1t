import { BookMarked, Lock } from "lucide-react";
import { Link } from "react-router";

import type { Repo } from "@g1t/contracts";

import { EmptyState, Pill, TimeAgo } from "./ui";

export function RepoList({ repos }: { repos: Repo[] }) {
  if (repos.length === 0) {
    return (
      <div className="mt-4">
        <EmptyState title="No repositories yet" />
      </div>
    );
  }
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2">
      {repos.map((repo) => (
        <li key={repo.id}>
          <Link
            to={`/${repo.namespace}/${repo.name}`}
            className="flex h-full flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
          >
            <span className="flex items-center gap-2">
              {repo.isPrivate ? (
                <Lock size={15} className="text-faint" />
              ) : (
                <BookMarked size={15} className="text-faint" />
              )}
              <span className="truncate font-mono text-sm">
                <span className="text-muted">{repo.namespace}/</span>
                <span className="font-medium">{repo.name}</span>
              </span>
              {repo.isPrivate && <Pill>private</Pill>}
            </span>
            <span className="mt-2 line-clamp-2 grow text-sm text-muted">
              {repo.description ?? "No description."}
            </span>
            <span className="mt-3 text-xs text-faint">
              Created <TimeAgo at={repo.createdAt} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
