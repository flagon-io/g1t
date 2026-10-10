/**
 * Import a skill (docs.g1t.sh/guides/agent-skills/, "Import a skill"):
 * upload a SKILL.md or a zip of a skill's folder, or read a folder from a
 * repository, pinned to the commit it was read at.
 */
import { ArrowLeft, FileUp, GitBranch } from "lucide-react";
import { useId, useState } from "react";
import { Form, Link, data, redirect, useActionData, useNavigation } from "react-router";

import type { SkillImport } from "@g1t/contracts";

import type { Route } from "./+types/skill-import";
import { agentsAction } from "../../../components/agents/actions.server";
import { type ActionResult, BUTTONS } from "../../../components/agents/dialogs";
import { skillsPath } from "../../../components/agents/skills";
import { CheckboxOption } from "../../../components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../../../components/ui/field";
import { FileDrop } from "../../../components/ui/file-drop";
import { Input } from "../../../components/ui/input";
import { cn } from "../../../lib/cn";
import { page } from "../../../lib/meta";
import { skillLibrary } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { SKILL_UPLOAD_MAX_BYTES, base64Of, uploadedFiles } from "../../../lib/skill-files.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Import a skill · Skills · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  return { slug };
}

export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  let source: SkillImport;
  if (intent === "upload") {
    const [file] = uploadedFiles(form, "file");
    if (!file) return { ok: false, intent, error: "Choose a SKILL.md or a zip to upload." };
    if (file.size > SKILL_UPLOAD_MAX_BYTES) return { ok: false, intent, error: "Upload at most 2 MB: a SKILL.md, or a zip of the skill's folder." };
    source = { kind: "upload", filename: file.name, data_base64: base64Of(new Uint8Array(await file.arrayBuffer())) };
  } else if (intent === "repository") {
    source = { kind: "repository", repo: String(form.get("repo") ?? ""), path: String(form.get("path") ?? ""), ref: String(form.get("ref") ?? "") || null };
  } else return { ok: false, intent, error: "Unknown request." };
  const imported = await skillLibrary.importSkill(slug, viewer, source, form.get("replace") === "on").catch(() => null);
  if (!imported) return { ok: false, intent, error: "The agents service didn't answer. Try again in a moment." };
  if (!imported.ok) return { ok: false, intent, error: imported.error.message };
  throw redirect(skillsPath(slug, imported.value.skill.name));
}

export default function ImportSkill({ loaderData }: Route.ComponentProps) {
  const { slug } = loaderData;
  const result = useActionData<ActionResult>();
  const navigation = useNavigation();
  const busyWith = navigation.state !== "idle" ? String(navigation.formData?.get("intent") ?? "") : null;
  const [tab, setTab] = useState<"upload" | "repository">(result && !result.ok && result.intent === "repository" ? "repository" : "upload");
  const id = useId();
  const error = (which: string) =>
    result && !result.ok && result.intent === which ? (
      <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
        {result.error}
      </p>
    ) : null;
  const replace = (
    <CheckboxOption
      name="replace"
      label="If the library has a skill with its name, make this its new version"
      description="Otherwise a skill with the same name is refused. Its attachments you can change move to the new version."
    />
  );
  return (
    <div className="max-w-3xl pb-4">
      <Link to={skillsPath(slug)} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Skills
      </Link>
      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Import a skill</h1>
        <p className="mt-1.5 text-sm text-muted">
          Any skill in the open SKILL.md format: a folder with a SKILL.md whose front-matter has a name and a description, and optional scripts/ and resources/. Front-matter g1t
          doesn&apos;t use is kept as it is.
        </p>
      </header>
      <div role="tablist" aria-label="Import from" className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-surface p-1 ring-1 ring-line sm:inline-grid sm:w-auto">
        {(
          [
            ["upload", "Upload", FileUp],
            ["repository", "From a repository", GitBranch],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn("inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm", tab === value ? "bg-raised font-medium text-fg shadow-sm" : "text-muted hover:text-fg")}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {tab === "upload" ? (
        <Form method="post" encType="multipart/form-data" className="grid gap-5 rounded-xl border border-line bg-surface p-4 sm:p-5">
          <input type="hidden" name="intent" value="upload" />
          <Field>
            <FieldLabel htmlFor={`${id}-file`}>SKILL.md or zip</FieldLabel>
            <FileDrop id={`${id}-file`} name="file" required accept=".md,.zip,text/markdown,application/zip" aria-describedby={`${id}-file-about`} />
            <FieldDescription id={`${id}-file-about`}>A zip of the skill&apos;s folder, as zipping the folder makes it. At most 1 MB once unpacked and 200 files.</FieldDescription>
          </Field>
          {replace}
          {error("upload")}
          <div className="flex justify-end">
            <button type="submit" className={`${BUTTONS.PRIMARY} h-9 py-0`} disabled={busyWith === "upload"}>
              {busyWith === "upload" ? "Importing…" : "Import"}
            </button>
          </div>
        </Form>
      ) : (
        <Form method="post" className="grid gap-5 rounded-xl border border-line bg-surface p-4 sm:p-5">
          <input type="hidden" name="intent" value="repository" />
          <Field>
            <FieldLabel htmlFor={`${id}-repo`}>Repository</FieldLabel>
            <Input id={`${id}-repo`} name="repo" required placeholder={`${slug}/handbook`} autoComplete="off" spellCheck={false} className="font-mono" />
            <FieldDescription>One you can read, as workspace/name.</FieldDescription>
          </Field>
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <Field>
              <FieldLabel htmlFor={`${id}-path`}>Folder</FieldLabel>
              <Input id={`${id}-path`} name="path" placeholder="skills/release-notes" autoComplete="off" spellCheck={false} className="font-mono" />
              <FieldDescription>The folder holding SKILL.md. Empty for the top of the repository.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-ref`}>Branch, tag or commit</FieldLabel>
              <Input id={`${id}-ref`} name="ref" placeholder="Default branch" autoComplete="off" spellCheck={false} className="font-mono placeholder:font-sans" />
            </Field>
          </div>
          <p className="text-xs text-faint">
            It is read once, at the commit the branch or tag points to now, and that commit is kept with the version. To have every push update a skill, link the repository on the
            Skills page and keep the skill in .g1t/skills/.
          </p>
          {replace}
          {error("repository")}
          <div className="flex justify-end">
            <button type="submit" className={`${BUTTONS.PRIMARY} h-9 py-0`} disabled={busyWith === "repository"}>
              {busyWith === "repository" ? "Reading…" : "Import"}
            </button>
          </div>
        </Form>
      )}
    </div>
  );
}
