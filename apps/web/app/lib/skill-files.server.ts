/**
 * Files people upload for a skill (the editor's files, Import's upload),
 * as the agents service takes them: text as it is, anything else as
 * standard base64. The service checks the folder (@g1t/contracts
 * skill-format.ts); this only refuses what is plainly too large to send.
 */
import { SKILL_FOLDER_MAX_BYTES, type SkillFile } from "@g1t/contracts";

/** The most one upload sends: a zip of a 1 MB folder is smaller. */
export const SKILL_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The uploaded files in a form field that are real files, not empty inputs. */
export function uploadedFiles(form: FormData, name: string): File[] {
  return form.getAll(name).filter((value): value is File => typeof value === "object" && value !== null && "arrayBuffer" in value && (value as File).size > 0);
}

/** One uploaded file as a skill's file at `path`. */
export async function skillFileOf(path: string, file: File): Promise<SkillFile | { error: string }> {
  if (file.size > SKILL_FOLDER_MAX_BYTES) return { error: `${file.name} is over 1 MB, the most a skill holds.` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    if (!text.includes("\u0000")) return { path, content: text, encoding: "utf8" };
  } catch {
    // Not text: sent as bytes.
  }
  return { path, content: base64Of(bytes), encoding: "base64" };
}
