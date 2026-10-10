/**
 * One skill (docs.g1t.sh/guides/agent-skills/): its instructions and files,
 * where it is attached and at which version, and every version. A draft
 * shows what the agent wrote, for someone to review and publish. g1t's
 * foundational skills show here too, as the SKILL.md they are.
 */
import { ArrowLeft, ArrowUpCircle, FileCode, FileText, History, PenLine, Plus, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Link, data, redirect, useFetcher } from "react-router";

import {
  type AgentSkill,
  FOUNDATIONAL_SKILLS,
  type SkillDetail,
  type SkillLibrary,
  foundationalSkillMd,
  skillSize,
  splitFrontMatter,
} from "@g1t/contracts";

import type { Route } from "./+types/skill";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import { type ActionResult, BUTTONS, Confirm } from "../../../components/agents/dialogs";
import { AttachDialog, AttachmentChip, FromRepository, NeedsComputer, originText, skillsPath } from "../../../components/agents/skills";
import { Markdown } from "../../../components/markdown";
import { TimeAgo } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Hint } from "../../../components/ui/hint";
import { cn } from "../../../lib/cn";
import { page } from "../../../lib/meta";
import { skillLibrary } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${params.name} · Skills · ${params.owner} · g1t` });
}

type Loaded =
  | { kind: "foundational"; slug: string; skill: AgentSkill; skillMd: string }
  | { kind: "library"; slug: string; detail: SkillDetail | null; library: SkillLibrary | null };

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<Loaded> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const foundational = FOUNDATIONAL_SKILLS.find((s) => s.id === params.name);
  if (foundational) return { kind: "foundational", slug, skill: foundational, skillMd: foundationalSkillMd(foundational) };
  const version = new URL(request.url).searchParams.get("version");
  const [found, library] = await Promise.all([
    skillLibrary.skill(slug, viewer, params.name, version ? Number(version) : null).catch(() => null),
    readOrNull(skillLibrary.library(slug, viewer)),
  ]);
  if (found && !found.ok && found.error.code === "not_found") throw data(null, { status: 404 });
  return { kind: "library", slug, detail: found?.ok ? found.value : null, library };
}

/** Attach, detach, move a pin, or delete the skill. */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  const name = params.name;
  if (intent === "attach") {
    const scope = String(form.get("scope") ?? "") as "agent" | "team" | "workspace";
    const target = String(form.get("target") ?? "") || null;
    return answer(intent, skillLibrary.attachSkill(slug, viewer, name, scope, target));
  }
  if (intent === "detach") return answer(intent, skillLibrary.detachSkill(slug, viewer, name, String(form.get("attachment") ?? "")));
  if (intent === "pin") {
    const version = form.get("version");
    return answer(intent, skillLibrary.pinSkill(slug, viewer, name, String(form.get("attachment") ?? ""), version ? Number(version) : null));
  }
  if (intent === "delete") {
    const done = await skillLibrary.deleteSkill(slug, viewer, name).catch(() => null);
    if (!done) return { ok: false, intent, error: "The agents service didn't answer. Try again in a moment." };
    if (!done.ok) return { ok: false, intent, error: done.error.message };
    throw redirect(skillsPath(slug));
  }
  return { ok: false, intent, error: "Unknown request." };
}

export default function SkillPage({ loaderData, params }: Route.ComponentProps) {
  const back = (
    <Link to={skillsPath(params.owner)} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft size={14} />
      Skills
    </Link>
  );
  if (loaderData.kind === "foundational") return <Foundational back={back} skill={loaderData.skill} skillMd={loaderData.skillMd} />;
  const { slug, detail, library } = loaderData;
  if (!detail) {
    return (
      <div className="space-y-4">
        {back}
        <div className="rounded-xl border border-dashed border-line px-6 py-14 text-center">
          <p className="font-medium">{params.name} can&apos;t be shown right now</p>
          <p className="mt-1.5 text-sm text-muted">The agents service didn&apos;t answer. Reload in a moment.</p>
        </div>
      </div>
    );
  }
  const { skill } = detail;
  const latest = detail.shown === skill.version;
  const draft = skill.status === "draft";
  return (
    <div className="space-y-8 pb-4">
      {back}
      {!latest && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-sm text-fg">
          <History size={15} className="shrink-0 text-info" aria-hidden />
          You&apos;re reading version {detail.shown} of {skill.version}.
          <Link to={skillsPath(slug, skill.name)} className="font-medium text-info hover:underline">
            Read the newest
          </Link>
        </p>
      )}
      {draft && (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-fg">
          {originText(skill.origin)}, as a draft. No agent uses it until {skill.can_edit ? "you review and publish it" : "an owner or team maintainer publishes it"}.
        </p>
      )}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 grow basis-md">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-xl font-semibold tracking-tight break-all sm:text-2xl">{skill.name}</h1>
            {draft ? <Badge tone="warn">Draft</Badge> : <Badge tone="neutral">Version {detail.shown}</Badge>}
            {detail.requires_computer && <NeedsComputer />}
            {skill.mirrored && <FromRepository repo={library?.mirror?.repo ?? null} />}
          </div>
          <p className="mt-2 max-w-3xl text-sm text-fg-soft">{detail.versions.find((v) => v.version === detail.shown)?.description || skill.description}</p>
          <p className="mt-2 text-xs text-faint">
            {originText(detail.versions.find((v) => v.version === detail.shown)?.origin ?? skill.origin)} · @{skill.updated_by} · <TimeAgo at={skill.updated_at} />
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {skill.can_edit && (
            <Link to={skillsPath(slug, skill.name, "/edit")} className={`${draft ? BUTTONS.PRIMARY : BUTTONS.QUIET} h-9 py-0`}>
              <PenLine size={15} />
              {draft ? "Review and publish" : "Edit"}
            </Link>
          )}
          {skill.can_delete && (
            <Confirm
              title={draft ? `Discard the draft ${skill.name}?` : `Delete ${skill.name}?`}
              confirm={draft ? "Discard draft" : "Delete skill"}
              fields={{ intent: "delete" }}
              fetcherKey={`delete-${skill.id}`}
              trigger={
                <button type="button" className={`${BUTTONS.QUIET} h-9 py-0 hover:border-danger/50 hover:text-danger`}>
                  <Trash2 size={14} />
                  {draft ? "Discard" : "Delete"}
                </button>
              }
            >
              {draft
                ? "It is gone for good; the session it came from stays."
                : `It is detached from every agent, team and the workspace (${skill.attachments.length} ${skill.attachments.length === 1 ? "place" : "places"}), and its history goes with it. Agents stop seeing it on their next reply.`}
            </Confirm>
          )}
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="instructions" className="rounded-xl border border-line bg-surface">
            <h2 id="instructions" className="border-b border-line/60 px-4 py-2.5 text-xs font-medium text-muted">
              Instructions
            </h2>
            <div className="px-4 py-4 sm:px-5">
              <Markdown source={detail.instructions} />
            </div>
          </section>
          {detail.files.length > 0 && (
            <section aria-labelledby="files">
              <h2 id="files" className="text-sm font-medium">
                Files <span className="text-faint">{detail.files.length}</span>
              </h2>
              <ul className="mt-3 divide-y divide-line/60 overflow-hidden rounded-xl border border-line bg-surface">
                {detail.files.map((file) => (
                  <li key={file.path}>
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-2.5 text-sm select-none hover:bg-raised/40 [&::-webkit-details-marker]:hidden">
                        {file.script ? <FileCode size={14} className="shrink-0 text-faint" aria-hidden /> : <FileText size={14} className="shrink-0 text-faint" aria-hidden />}
                        <span className="min-w-0 grow truncate font-mono text-[0.8125rem]">{file.path}</span>
                        {file.script && <Badge tone="warn">Script · not run</Badge>}
                        <span className="shrink-0 text-xs text-faint">{skillSize(file.bytes)}</span>
                      </summary>
                      <div className="border-t border-line/60 bg-bg/40 px-4 py-3">
                        {file.content != null ? (
                          <pre className="max-h-96 overflow-auto text-xs leading-relaxed whitespace-pre-wrap text-fg-soft">{file.content}</pre>
                        ) : (
                          <p className="text-xs text-faint">{file.encoding === "base64" ? "Not text, so it isn't shown here." : "Too large to show here."}</p>
                        )}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <details className="group rounded-xl border border-line bg-surface">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-xs font-medium text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
              <FileText size={13} aria-hidden />
              <span className="group-open:hidden">Show SKILL.md as written</span>
              <span className="hidden group-open:inline">Hide SKILL.md</span>
            </summary>
            <pre className="overflow-x-auto border-t border-line/60 px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap text-fg-soft">{detail.skill_md}</pre>
          </details>
        </div>

        <aside className="space-y-6">
          <Attached detail={detail} library={library} />
          <section aria-labelledby="tools">
            <h2 id="tools" className="text-sm font-medium">
              Tools it uses
            </h2>
            {detail.tools.length ? (
              <ul className="mt-2 flex flex-wrap gap-1" aria-label="Tools it uses">
                {detail.tools.map((tool) => (
                  <li key={tool} className="rounded-[5px] bg-raised px-1.5 py-px font-mono text-[0.6875rem] text-muted ring-1 ring-line ring-inset">
                    {tool}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">None named.</p>
            )}
            <p className="mt-2 text-xs text-faint">A skill never adds a tool. An agent without one of these is told that part doesn&apos;t work where it is asked.</p>
          </section>
          <Versions detail={detail} slug={slug} />
        </aside>
      </div>
    </div>
  );
}

function Attached({ detail, library }: { detail: SkillDetail; library: SkillLibrary | null }) {
  const { skill } = detail;
  const pin = useFetcher<ActionResult>({ key: `pin-${skill.id}` });
  const detach = useFetcher<ActionResult>({ key: `detach-${skill.id}` });
  const error = [pin, detach].map((f) => (f.state === "idle" && f.data && !f.data.ok ? f.data.error : null)).find(Boolean);
  const canAttach = !!library && skill.status === "published" && (library.can_manage || library.teams.length > 0);
  return (
    <section aria-labelledby="attached">
      <div className="flex items-center justify-between gap-2">
        <h2 id="attached" className="text-sm font-medium">
          Attached to
        </h2>
        {canAttach && (
          <AttachDialog
            skill={skill}
            library={library}
            trigger={
              <button type="button" className={`${BUTTONS.QUIET} h-8 px-2.5 py-0 text-xs`}>
                <Plus size={13} />
                Attach
              </button>
            }
          />
        )}
      </div>
      {skill.status === "draft" ? (
        <p className="mt-1 text-sm text-muted">Nowhere: publish it first.</p>
      ) : skill.attachments.length === 0 ? (
        <p className="mt-1 text-sm text-muted">Nowhere yet. No agent sees it until it is attached.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {skill.attachments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2">
              <span className="min-w-0 grow">
                <AttachmentChip attachment={a} />
                <span className={cn("ml-2 text-xs", a.version < skill.version ? "text-warn" : "text-faint")}>v{a.version}</span>
              </span>
              {a.can_change && a.version < skill.version && (
                <pin.Form method="post">
                  <input type="hidden" name="intent" value="pin" />
                  <input type="hidden" name="attachment" value={a.id} />
                  <Hint label={`Move ${a.label} to version ${skill.version}`}>
                    <button type="submit" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-accent hover:bg-accent/10" disabled={pin.state !== "idle"}>
                      <ArrowUpCircle size={13} />
                      Update to v{skill.version}
                    </button>
                  </Hint>
                </pin.Form>
              )}
              {a.can_change && (
                <detach.Form method="post">
                  <input type="hidden" name="intent" value="detach" />
                  <input type="hidden" name="attachment" value={a.id} />
                  <Hint label={`Detach from ${a.label}`}>
                    <button type="submit" aria-label={`Detach from ${a.label}`} className="flex size-7 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-danger" disabled={detach.state !== "idle"}>
                      <X size={14} />
                    </button>
                  </Hint>
                </detach.Form>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

function Versions({ detail, slug }: { detail: SkillDetail; slug: string }) {
  if (detail.skill.status === "draft") return null;
  return (
    <section aria-labelledby="versions">
      <h2 id="versions" className="text-sm font-medium">
        Versions <span className="text-faint">{detail.versions.length}</span>
      </h2>
      <ol className="mt-2 space-y-px">
        {detail.versions.map((v) => {
          const shown = v.version === detail.shown;
          return (
            <li key={v.version}>
              <Link
                to={v.version === detail.skill.version ? skillsPath(slug, detail.skill.name) : `${skillsPath(slug, detail.skill.name)}?version=${v.version}`}
                aria-current={shown ? "page" : undefined}
                className={cn("block rounded-md px-2.5 py-2 text-sm transition-colors", shown ? "bg-raised" : "hover:bg-raised/60")}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-fg">Version {v.version}</span>
                  <span className="shrink-0 text-xs text-faint">
                    <TimeAgo at={v.created_at} />
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted">{v.note ?? originText(v.origin)}</span>
                <span className="block text-xs text-faint">
                  @{v.created_by} · {skillSize(v.bytes)}
                  {v.files ? ` · ${v.files} ${v.files === 1 ? "file" : "files"}` : ""}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Foundational({ back, skill, skillMd }: { back: ReactNode; skill: AgentSkill; skillMd: string }) {
  const split = splitFrontMatter(skillMd);
  return (
    <div className="space-y-8 pb-4">
      {back}
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-xl font-semibold tracking-tight sm:text-2xl">{skill.id}</h1>
          <Badge tone="accent">From g1t</Badge>
          <Badge tone="neutral">Version {skill.version}</Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-fg-soft">{skill.when}</p>
        <p className="mt-2 text-xs text-faint">Every agent has it, updated with g1t&apos;s releases. Owners turn it off for one agent on that agent&apos;s Skills tab.</p>
      </header>
      <section aria-labelledby="instructions" className="rounded-xl border border-line bg-surface">
        <h2 id="instructions" className="border-b border-line/60 px-4 py-2.5 text-xs font-medium text-muted">
          Instructions
        </h2>
        <div className="px-4 py-4 sm:px-5">
          <Markdown source={split.ok ? split.body : skillMd} />
        </div>
      </section>
      <details className="group rounded-xl border border-line bg-surface">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-xs font-medium text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
          <FileText size={13} aria-hidden />
          <span className="group-open:hidden">Show SKILL.md</span>
          <span className="hidden group-open:inline">Hide SKILL.md</span>
        </summary>
        <pre className="overflow-x-auto border-t border-line/60 px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap text-fg-soft">{skillMd}</pre>
      </details>
    </div>
  );
}
