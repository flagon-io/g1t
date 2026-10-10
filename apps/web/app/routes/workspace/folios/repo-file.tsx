import type { DocRepoPage } from "@g1t/contracts";
import { FolderGit2, GitPullRequestArrow, PencilLine, Trash2 } from "lucide-react";
import { Link, data, useNavigate } from "react-router";

import type { Route } from "./+types/repo-file";
import { useFoliosAction } from "../../../components/folios/actions";
import { Crumbs } from "../../../components/folios/parts";
import { Markdown } from "../../../components/markdown";
import { ErrorText, TimeAgo } from "../../../components/ui";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { page as pageMeta } from "../../../lib/meta";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  const file = loaded?.found.file;
  return pageMeta(args, { title: `${file?.title ?? "Project docs"} · ${params.repoOwner}/${params.repoName} · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ found: DocRepoPage }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const repo = `${params.repoOwner}/${params.repoName}`;
  const found = await docs.repoPage(params.owner.toLowerCase(), viewer, repo, params["*"] ?? "").catch(() => null);
  if (!found?.ok) throw data(null, { status: 404 });
  return { found: found.value };
}

/**
 * One file of a project's docs, read-only: rendered as Code renders it,
 * with its links and pictures pointing into the repository. Changes go
 * through the repository: Edit in Code opens the file there.
 */
export default function RepoDocFile({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { space, file } = loaderData.found;
  const navigate = useNavigate();
  const { send, error } = useFoliosAction(slug);
  const [namespace, name] = space.repo.split("/") as [string, string];
  const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const encode = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  return (
    <div>
      <div data-page-head="sticky" className="sticky top-(--topbar-h) z-20 -mx-4 flex h-14 items-center gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur sm:-mx-6 sm:px-5 lg:-mx-8">
        <div className="min-w-0 grow">
          <Crumbs items={[{ label: "Artifacts", to: `/${slug}/-/artifacts` }, { label: space.repo }, ...file.path.split("/").map((part) => ({ label: part }))]} />
        </div>
        <Link to={file.code_href} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-fg/85 hover:bg-raised">
          <PencilLine size={13} /> Edit in Code
        </Link>
        {space.can_remove && (
          <Hint label={`Stop showing ${space.repo}'s docs in Artifacts`}>
            <Button
              type="button"
              aria-label={`Stop showing ${space.repo}'s docs`}
              onClick={async () => {
                const done = await send("remove_repo_space", { id: space.id });
                if (done.ok) navigate(`/${slug}/-/artifacts`);
              }}
              variant="ghost"
              size="icon-sm"
              className="text-faint hover:text-danger"
            >
              <Trash2 size={15} />
            </Button>
          </Hint>
        )}
      </div>
      <article className="mx-auto max-w-3xl pt-10">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
          <span className="inline-flex items-center gap-1.5">
            <FolderGit2 size={13} /> {space.repo} · {space.default_branch}
          </span>
          <span className="font-mono">{file.path}</span>
          {space.indexed_at && (
            <span>
              Read <TimeAgo at={space.indexed_at} />
            </span>
          )}
        </p>
        <Card asChild radius="lg" className="mt-3 flex items-start gap-2 px-3 py-2 text-xs leading-relaxed text-muted">
          <p>
            <GitPullRequestArrow size={14} className="mt-px shrink-0 text-faint" aria-hidden="true" />
            This file lives in the repository and changes through pull requests. Edit it in Code, or ask an agent to open a pull request for it.
          </p>
        </Card>
        {error && (
          <div className="mt-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
        <div className="docs-read mt-6">
          <Markdown
            source={file.markdown}
            repo={{ namespace, name }}
            // Relative links point into the repository at its default
            // branch, and pictures at its files there.
            base={`/${space.repo}/blob/${encodeURIComponent(space.default_branch)}${folder ? `/${encode(folder)}` : ""}`}
            rawBase={`/${space.repo}/raw/${encodeURIComponent(space.commit ?? space.default_branch)}${folder ? `/${encode(folder)}` : ""}`}
          />
        </div>
      </article>
    </div>
  );
}
