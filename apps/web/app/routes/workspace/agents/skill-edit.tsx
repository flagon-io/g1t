/**
 * The skill editor (docs.g1t.sh/guides/agent-skills/, "Write a skill"):
 * a name, when to use it, the instructions, the tools it uses and its
 * files. Saving writes SKILL.md and a new version; a draft saved from a
 * session is reviewed and published here.
 */
import { ArrowLeft, Eye, FileCode, FileText, PenLine, Undo2, X } from "lucide-react";
import { useId, useState } from "react";
import { Form, Link, data, redirect, useActionData, useNavigation } from "react-router";

import { AGENT_TOOL_GROUPS, SKILL_DESCRIPTION_MAX, type SkillDetail, type SkillInput, skillSize } from "@g1t/contracts";

import type { Route } from "./+types/skill-edit";
import { agentsAction } from "../../../components/agents/actions.server";
import { type ActionResult, BUTTONS } from "../../../components/agents/dialogs";
import { originText, skillsPath } from "../../../components/agents/skills";
import { Markdown } from "../../../components/markdown";
import { Badge } from "../../../components/ui/badge";
import { CheckboxOption } from "../../../components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "../../../components/ui/field";
import { FileDrop } from "../../../components/ui/file-drop";
import { Input } from "../../../components/ui/input";
import { SelectField } from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import { cn } from "../../../lib/cn";
import { page } from "../../../lib/meta";
import { skillLibrary } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { skillFileOf, uploadedFiles } from "../../../lib/skill-files.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${params.name ? `Edit ${params.name}` : "Write a skill"} · Skills · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ slug: string; detail: SkillDetail | null; unavailable: boolean }> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  if (!params.name) return { slug, detail: null, unavailable: false };
  const found = await skillLibrary.skill(slug, viewer, params.name).catch(() => null);
  if (found && !found.ok && found.error.code === "not_found") throw data(null, { status: 404 });
  if (found?.ok && !found.value.skill.can_edit) throw redirect(skillsPath(slug, params.name));
  return { slug, detail: found?.ok ? found.value : null, unavailable: !found?.ok };
}

/** Saves the skill: a new one, a new version, or a draft published. */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = "save";
  const folder = form.get("folder") === "scripts" ? "scripts" : "resources";
  const added = [];
  for (const file of uploadedFiles(form, "files").slice(0, 50)) {
    const one = await skillFileOf(`${folder}/${file.name.replace(/[\\/]/g, "_")}`, file);
    if ("error" in one) return { ok: false, intent, error: one.error, field: "files" };
    added.push(one);
  }
  const input: SkillInput = {
    name: String(form.get("name") ?? "").trim(),
    description: String(form.get("description") ?? ""),
    instructions: String(form.get("instructions") ?? ""),
    tools: form.getAll("tools").map(String),
    requires_computer: form.get("requires_computer") === "on",
    add_files: added,
    remove_files: form.getAll("remove").map(String),
    note: String(form.get("note") ?? "") || null,
    update_attachments: form.get("update_attachments") !== "off",
  };
  const saved = await skillLibrary.saveSkill(slug, viewer, params.name ?? null, input).catch(() => null);
  if (!saved) return { ok: false, intent, error: "The agents service didn't answer. Try again in a moment." };
  if (!saved.ok) return { ok: false, intent, error: saved.error.message };
  throw redirect(skillsPath(slug, saved.value.skill.name));
}

export default function SkillEditor({ loaderData, params }: Route.ComponentProps) {
  const { slug, detail, unavailable } = loaderData;
  const result = useActionData<ActionResult>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formMethod === "POST";
  const id = useId();
  const editing = !!params.name;
  const draft = detail?.skill.status === "draft";
  const [description, setDescription] = useState(detail?.skill.description ?? "");
  const [instructions, setInstructions] = useState(detail?.instructions ?? "");
  const [preview, setPreview] = useState(false);
  const [removed, setRemoved] = useState<string[]>([]);
  const [folder, setFolder] = useState("resources");
  const [updateAll, setUpdateAll] = useState(true);
  const back = editing ? skillsPath(slug, params.name) : skillsPath(slug);

  if (editing && unavailable) {
    return (
      <div className="space-y-4">
        <Link to={back} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft size={14} />
          {params.name}
        </Link>
        <div className="rounded-xl border border-dashed border-line px-6 py-14 text-center">
          <p className="font-medium">{params.name} can&apos;t be edited right now</p>
          <p className="mt-1.5 text-sm text-muted">The agents service didn&apos;t answer. Reload in a moment.</p>
        </div>
      </div>
    );
  }
  const title = !editing ? "Write a skill" : draft ? "Review the draft" : `Edit ${params.name}`;
  const attached = detail?.skill.attachments.length ?? 0;
  return (
    <div className="pb-4">
      <Link to={back} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        {editing ? params.name : "Skills"}
      </Link>
      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">
          {draft
            ? `${originText(detail!.skill.origin)}. Read it as you would a pull request: change what's wrong, take out anything private, then publish it. No agent uses it before then.`
            : "Agents see the name and when to use it on every reply, and read the instructions when a request matches, so keep the first short and the second complete."}
        </p>
      </header>
      <Form method="post" encType="multipart/form-data" className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="grid min-w-0 gap-6">
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} name="name" defaultValue={detail?.skill.name ?? ""} required maxLength={64} placeholder="release-notes" autoComplete="off" spellCheck={false} className="font-mono" />
            <FieldDescription>Lowercase letters, digits and hyphens. Agents ask for it by this name.</FieldDescription>
          </Field>
          <Field>
            <div className="flex items-baseline justify-between gap-2">
              <FieldLabel htmlFor={`${id}-description`}>When to use it</FieldLabel>
              <span className={cn("text-xs tabular-nums", description.length > SKILL_DESCRIPTION_MAX ? "text-danger" : "text-faint")}>
                {description.length} / {SKILL_DESCRIPTION_MAX}
              </span>
            </div>
            <Textarea
              id={`${id}-description`}
              name="description"
              rows={3}
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Use when someone asks for release notes or a changelog for a version."
            />
            <FieldDescription>The SKILL.md description. Start with &ldquo;Use when&rdquo; and name the requests it is for.</FieldDescription>
          </Field>
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor={`${id}-instructions`}>Instructions</FieldLabel>
              <div role="tablist" aria-label="Instructions" className="flex rounded-md bg-surface p-0.5 ring-1 ring-line">
                <button type="button" role="tab" aria-selected={!preview} onClick={() => setPreview(false)} className={cn("inline-flex items-center gap-1 rounded px-2 py-1 text-xs", !preview ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg")}>
                  <PenLine size={12} />
                  Write
                </button>
                <button type="button" role="tab" aria-selected={preview} onClick={() => setPreview(true)} className={cn("inline-flex items-center gap-1 rounded px-2 py-1 text-xs", preview ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg")}>
                  <Eye size={12} />
                  Preview
                </button>
              </div>
            </div>
            <Textarea
              id={`${id}-instructions`}
              name="instructions"
              rows={18}
              required
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={"# Release notes\n\n1. Read the pull requests merged since the last tag (recent_activity).\n2. Group them by area: Added, Changed, Fixed.\n3. Write the notes as a doc, linking each pull request."}
              className={cn("font-mono text-[0.8125rem]", preview && "hidden")}
            />
            {preview && (
              <div className="min-h-40 rounded-md border border-line bg-surface px-4 py-3">
                {instructions.trim() ? <Markdown source={instructions} /> : <p className="text-sm text-faint">Nothing to preview yet.</p>}
              </div>
            )}
            <FieldDescription>Markdown, in the second person: the steps, what to read first, the checks before it&apos;s done. Agents get it word for word.</FieldDescription>
          </Field>

          <fieldset className="min-w-0">
            <legend className="text-sm font-medium text-fg-soft">Tools it uses</legend>
            <p className="mt-1 text-xs text-faint">Naming a tool never gives it to an agent. An agent without one is told that part doesn&apos;t work where it&apos;s asked.</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {AGENT_TOOL_GROUPS.map((group) => (
                <div key={group.group} className="rounded-lg border border-line bg-surface px-3 py-2.5">
                  <p className="mb-2 text-xs font-medium text-muted">{group.group}</p>
                  <div className="grid gap-1.5">
                    {group.tools.map((tool) => (
                      <CheckboxOption key={tool} name="tools" value={tool} defaultChecked={detail?.tools.includes(tool)} label={<span className="font-mono text-[0.8125rem]">{tool}</span>} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="text-sm font-medium text-fg-soft">Files</legend>
            <p className="mt-1 text-xs text-faint">
              Templates and references go in resources/, and agents read them when the instructions point to them. Scripts go in scripts/: they run only on an agent&apos;s own
              computer, which is coming, so for now they&apos;re kept with the skill and never run. At most 1 MB for everything.
            </p>
            {detail && detail.files.length > 0 && (
              <ul className="mt-3 divide-y divide-line/60 overflow-hidden rounded-lg border border-line bg-surface">
                {detail.files.map((file) => {
                  const gone = removed.includes(file.path);
                  return (
                    <li key={file.path} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                      {file.script ? <FileCode size={14} className="shrink-0 text-faint" aria-hidden /> : <FileText size={14} className="shrink-0 text-faint" aria-hidden />}
                      <span className={cn("min-w-0 grow truncate font-mono text-[0.8125rem]", gone && "text-faint line-through")}>{file.path}</span>
                      <span className="shrink-0 text-xs text-faint">{skillSize(file.bytes)}</span>
                      {gone && <input type="hidden" name="remove" value={file.path} />}
                      <button
                        type="button"
                        onClick={() => setRemoved((now) => (gone ? now.filter((p) => p !== file.path) : [...now, file.path]))}
                        aria-label={gone ? `Keep ${file.path}` : `Remove ${file.path}`}
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg"
                      >
                        {gone ? <Undo2 size={14} /> : <X size={14} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap items-start gap-2">
              <input type="hidden" name="folder" value={folder} />
              <SelectField
                aria-label="Folder"
                options={[
                  { value: "resources", label: "resources/" },
                  { value: "scripts", label: "scripts/" },
                ]}
                value={folder}
                onValueChange={setFolder}
                className="w-36 font-mono"
              />
              <FileDrop name="files" multiple compact label="Add files" className="min-w-0 grow basis-56" />
            </div>
            <FieldError>{result && !result.ok && result.field === "files" ? result.error : null}</FieldError>
          </fieldset>

          <CheckboxOption
            name="requires_computer"
            defaultChecked={detail?.requires_computer && !detail.files.some((f) => f.script)}
            label="Needs a computer of its own"
            description="For a skill that only works with a shell, a browser or code it runs. Agents don't have their own computer yet, so it is marked Coming and agents follow only the parts they can. A skill with scripts is marked anyway."
          />

          {editing && !draft && (
            <div className="grid gap-4 rounded-lg border border-line bg-surface px-4 py-3.5">
              <Field>
                <FieldLabel htmlFor={`${id}-note`}>What changed</FieldLabel>
                <Input id={`${id}-note`} name="note" maxLength={200} placeholder="Optional, shown in its history" />
              </Field>
              {attached > 0 && (
                <>
                  <input type="hidden" name="update_attachments" value={updateAll ? "on" : "off"} />
                  <CheckboxOption
                    checked={updateAll}
                    onCheckedChange={(checked) => setUpdateAll(checked === true)}
                    label="Use the new version wherever I can change it"
                    description={`It is attached in ${attached} ${attached === 1 ? "place" : "places"}. Left unticked, they keep their version and show an update available.`}
                  />
                </>
              )}
            </div>
          )}

          {result && !result.ok && result.field !== "files" && (
            <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {result.error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
            <Link to={back} className={`${BUTTONS.QUIET} h-9 py-0`}>
              Cancel
            </Link>
            <button type="submit" className={`${BUTTONS.PRIMARY} h-9 py-0`} disabled={busy}>
              {busy ? "Saving…" : draft ? "Publish" : editing ? "Save a new version" : "Add to the library"}
            </button>
          </div>
        </div>

        <aside className="space-y-4 text-sm text-muted lg:pt-7">
          <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
            <p className="font-medium text-fg">A good skill</p>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-relaxed">
              <li>Covers one kind of work, the way your team does it.</li>
              <li>Says when to use it in one sentence, so agents pick it at the right time.</li>
              <li>Lists the steps, where to look first, and the checks before it&apos;s done.</li>
              <li>Points to its files by path, such as resources/template.md.</li>
            </ul>
          </div>
          <div className="rounded-xl border border-line bg-surface px-4 py-3.5 text-xs leading-relaxed">
            <p className="text-sm font-medium text-fg">Saved as SKILL.md</p>
            <p className="mt-1.5">The open format other tools read, so a skill moves between them and can live in a repository. Every save is a new version; attachments pin the one they use.</p>
            {detail && !draft && (
              <p className="mt-2">
                <Badge tone="neutral">Now version {detail.skill.version}</Badge>
              </p>
            )}
          </div>
        </aside>
      </Form>
    </div>
  );
}
