/**
 * Agents → Skills: the workspace's skill library (docs.g1t.sh/guides/agent-skills/).
 * Every skill it wrote, imported, saved from a session or follows from a
 * repository, where each is attached, and g1t's foundational skills; the
 * drafts waiting for review first. Owners link the repository it follows.
 */
import { ArrowLeft, BookOpen, ChevronRight, FileUp, GitBranch, PenLine, RefreshCw, Store } from "lucide-react";
import { Link, data, useFetcher } from "react-router";

import { FOUNDATIONAL_SKILLS, FOUNDATIONAL_SKILLS_VERSION, type LibrarySkill, type SkillLibrary, type SkillMirror } from "@g1t/contracts";

import type { Route } from "./+types/skill-library";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import { type ActionResult, BUTTONS, Confirm } from "../../../components/agents/dialogs";
import { AttachmentChip, FromRepository, NeedsComputer, originText, skillsPath } from "../../../components/agents/skills";
import { EmptyState, TimeAgo } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Input } from "../../../components/ui/input";
import { page } from "../../../lib/meta";
import { skillLibrary } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Skills · Agents · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ slug: string; library: SkillLibrary | null }> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  return { slug, library: await readOrNull(skillLibrary.library(slug, viewer)) };
}

/** Link the repository the library follows, read it again, or stop following it. */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  if (intent === "link") {
    const repo = String(form.get("repo") ?? "").trim();
    if (!repo) return { ok: false, intent, error: "Name the repository as workspace/name." };
    return answer(intent, skillLibrary.setMirror(slug, viewer, repo));
  }
  if (intent === "unlink") return answer(intent, skillLibrary.setMirror(slug, viewer, null));
  if (intent === "sync") return answer(intent, skillLibrary.syncMirror(slug, viewer));
  return { ok: false, intent, error: "Unknown request." };
}

export default function SkillLibraryPage({ loaderData }: Route.ComponentProps) {
  const { slug, library } = loaderData;
  const drafts = library?.skills.filter((s) => s.status === "draft") ?? [];
  const published = library?.skills.filter((s) => s.status === "published") ?? [];
  return (
    <div className="pb-4">
      <Link to={`/${slug}/-/agents`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Agents
      </Link>
      <header className="mt-4 mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 grow basis-lg">
          <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            How your agents do a kind of work, in the open SKILL.md format: a name, when to use it, and instructions, with files if it needs them. Attach a skill to an agent,
            a team or every agent. Agents see each skill&apos;s name and when to use it, and read the rest when a request matches. A skill never gives an agent a tool or
            access it doesn&apos;t have.
          </p>
        </div>
        {library?.can_write && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link to={skillsPath(slug, undefined, "/import")} className={`${BUTTONS.QUIET} h-9 py-0`}>
              <FileUp size={15} />
              Import
            </Link>
            <Link to={skillsPath(slug, undefined, "/new")} className={`${BUTTONS.PRIMARY} h-9 py-0`}>
              <PenLine size={15} />
              Write a skill
            </Link>
          </div>
        )}
      </header>

      {!library ? (
        <EmptyState title="The library can't be shown right now">The agents service didn&apos;t answer. Reload in a minute.</EmptyState>
      ) : (
        <div className="space-y-10">
          {drafts.length > 0 && (
            <section aria-labelledby="drafts">
              <h2 id="drafts" className="text-sm font-medium">
                Drafts to review <span className="text-faint">{drafts.length}</span>
              </h2>
              <p className="mt-1 text-xs text-faint">Saved from finished sessions. No agent uses a draft until someone who writes skills reviews and publishes it.</p>
              <ul className="mt-3 divide-y divide-line/60 overflow-hidden rounded-xl border border-warn/30 bg-surface">
                {drafts.map((skill) => (
                  <SkillRow key={skill.id} slug={slug} skill={skill} />
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="library">
            <h2 id="library" className="text-sm font-medium">
              Your workspace&apos;s skills <span className="text-faint">{published.length}</span>
            </h2>
            {published.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-line px-6 py-10 text-center">
                <p className="font-medium">No skills yet</p>
                <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
                  {library.can_write
                    ? "Write one, such as how you cut a release or your brand voice, import a SKILL.md or a zip, or save a finished session as a skill."
                    : "Owners and team maintainers write skills. You can save a finished session as a skill for them to review."}
                </p>
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-line/60 overflow-hidden rounded-xl border border-line bg-surface">
                {published.map((skill) => (
                  <SkillRow key={skill.id} slug={slug} skill={skill} mirror={library.mirror} />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="foundational">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id="foundational" className="text-sm font-medium">
                From g1t <span className="text-faint">{FOUNDATIONAL_SKILLS.length}</span>
              </h2>
              <p className="text-xs text-faint">Version {FOUNDATIONAL_SKILLS_VERSION}, updated with every release</p>
            </div>
            <p className="mt-1 text-xs text-faint">Every agent has these. Owners turn one off for an agent on its Skills tab.</p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {FOUNDATIONAL_SKILLS.map((skill) => (
                <li key={skill.id}>
                  <Link
                    to={skillsPath(slug, skill.id)}
                    className="flex h-full items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong hover:bg-raised/40"
                  >
                    <BookOpen size={15} className="mt-0.5 shrink-0 text-faint" aria-hidden />
                    <span className="min-w-0">
                      <span className="block font-mono text-[0.8125rem] font-medium text-fg">{skill.id}</span>
                      <span className="mt-0.5 block text-xs text-muted">{skill.description}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <MirrorPanel slug={slug} mirror={library.mirror} canManage={library.can_manage} canWrite={library.can_write} />

          <section aria-labelledby="marketplace" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
            <div className="flex min-w-0 items-start gap-3">
              <Store size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0">
                <h2 id="marketplace" className="text-sm font-medium">
                  From the Marketplace
                </h2>
                <p className="mt-0.5 text-sm text-muted">Skills that extensions bring, added to the library in one step.</p>
              </div>
            </div>
            <Badge tone="neutral">Coming</Badge>
          </section>
        </div>
      )}
    </div>
  );
}

function SkillRow({ slug, skill, mirror }: { slug: string; skill: LibrarySkill; mirror?: SkillMirror | null }) {
  const behind = skill.attachments.filter((a) => a.version < skill.version).length;
  return (
    <li>
      <Link to={skillsPath(slug, skill.name, skill.status === "draft" && skill.can_edit ? "/edit" : "")} className="group flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-raised/40">
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-sm font-medium text-fg">{skill.name}</span>
            {skill.status === "draft" ? <Badge tone="warn">Draft</Badge> : <span className="text-xs text-faint">v{skill.version}</span>}
            {skill.requires_computer && <NeedsComputer plain />}
            {skill.mirrored && <FromRepository plain repo={mirror?.repo ?? null} />}
          </div>
          <p className="mt-0.5 line-clamp-2 text-sm text-muted">{skill.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {skill.status === "draft" ? (
              <span className="text-xs text-faint">{originText(skill.origin)}</span>
            ) : skill.attachments.length ? (
              skill.attachments.slice(0, 4).map((a) => <AttachmentChip key={a.id} attachment={a} latest={skill.version} />)
            ) : (
              <span className="text-xs text-faint">Not attached yet</span>
            )}
            {skill.attachments.length > 4 && <span className="text-xs text-faint">and {skill.attachments.length - 4} more</span>}
            {behind > 0 && <span className="text-xs text-warn">Update available on {behind}</span>}
          </div>
        </div>
        <div className="hidden shrink-0 text-right text-xs text-faint sm:block">
          <p>
            @{skill.updated_by} · <TimeAgo at={skill.updated_at} />
          </p>
        </div>
        <ChevronRight size={16} className="mt-0.5 shrink-0 text-faint group-hover:text-fg" aria-hidden />
      </Link>
    </li>
  );
}

/** The repository the library follows, read after every push there; writing back to it is coming. */
function MirrorPanel({ slug, mirror, canManage, canWrite }: { slug: string; mirror: SkillMirror | null; canManage: boolean; canWrite: boolean }) {
  const link = useFetcher<ActionResult>({ key: "skills-link" });
  const sync = useFetcher<ActionResult>({ key: "skills-sync" });
  const linkError = link.state === "idle" && link.data && !link.data.ok ? link.data.error : null;
  const syncError = sync.state === "idle" && sync.data && !sync.data.ok ? sync.data.error : null;
  const problems = mirror?.error?.split("\n").filter(Boolean) ?? [];
  return (
    <section aria-labelledby="repository" className="rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <GitBranch size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0">
            <h2 id="repository" className="text-sm font-medium">
              Keep skills in a repository
            </h2>
            {mirror ? (
              <p className="mt-0.5 text-sm text-muted">
                Follows{" "}
                <Link to={`/${mirror.repo}/tree/${mirror.branch}/.g1t/skills`} className="font-mono text-fg hover:underline">
                  {mirror.repo}
                </Link>
                : each folder in <code className="font-mono text-[0.8125rem]">.g1t/skills/</code> on {mirror.branch} is a skill, and a push there publishes a new version.
                {mirror.synced_at && (
                  <span className="text-faint">
                    {" "}
                    Read <TimeAgo at={mirror.synced_at} />
                    {mirror.commit ? ` at ${mirror.commit.slice(0, 7)}` : ""}.
                  </span>
                )}
              </p>
            ) : (
              <p className="mt-0.5 max-w-2xl text-sm text-muted">
                Optional. Link a repository and each <code className="font-mono text-[0.8125rem]">.g1t/skills/&lt;name&gt;/</code> folder on its default branch becomes a skill
                here, updated by every push, so skills go through the same pull requests and reviews as code.
              </p>
            )}
          </div>
        </div>
        {mirror && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {canWrite && (
              <sync.Form method="post">
                <input type="hidden" name="intent" value="sync" />
                <button type="submit" className={`${BUTTONS.QUIET} h-8 px-3 py-0 text-xs`} disabled={sync.state !== "idle"}>
                  <RefreshCw size={13} className={sync.state !== "idle" ? "animate-spin" : undefined} />
                  {sync.state !== "idle" ? "Reading…" : "Read it again"}
                </button>
              </sync.Form>
            )}
            {canManage && (
              <Confirm
                title="Stop following the repository?"
                confirm="Stop following"
                fields={{ intent: "unlink" }}
                fetcherKey="skills-unlink"
                trigger={
                  <button type="button" className={`${BUTTONS.QUIET} h-8 px-3 py-0 text-xs hover:border-danger/50 hover:text-danger`}>
                    Stop following
                  </button>
                }
              >
                Its skills stay in the library as they are, and can be edited here again. Pushes to {mirror.repo} no longer change them.
              </Confirm>
            )}
          </div>
        )}
      </div>
      {(problems.length > 0 || syncError) && (
        <ul className="space-y-1 border-t border-line/60 px-4 py-3 text-sm text-warn" aria-label="What couldn't be read">
          {syncError && <li>{syncError}</li>}
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {!mirror && canManage && (
        <link.Form method="post" className="flex flex-wrap items-start gap-2 border-t border-line/60 px-4 py-3">
          <input type="hidden" name="intent" value="link" />
          <label htmlFor="skills-repo" className="sr-only">
            Repository
          </label>
          <Input id="skills-repo" name="repo" placeholder={`${slug}/agents`} autoComplete="off" spellCheck={false} className="h-9 max-w-xs grow font-mono" />
          <button type="submit" className={`${BUTTONS.QUIET} h-9 py-0`} disabled={link.state !== "idle"}>
            {link.state !== "idle" ? "Linking…" : "Link repository"}
          </button>
          {linkError && <p className="w-full text-sm text-danger">{linkError}</p>}
        </link.Form>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 px-4 py-2.5">
        <p className="text-xs text-faint">Writing edits made here back to the repository as a commit</p>
        <Badge tone="neutral">Coming</Badge>
      </div>
    </section>
  );
}
