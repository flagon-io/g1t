import type { TaskCheck } from "@g1t/contracts/tasks";

/**
 * The box a `check-task` form names (components/markdown.tsx posts it):
 * its number, its text as the page showed it, and whether to tick it.
 * Anything else is left for the work service to refuse.
 */
export function taskCheckOf(form: FormData): TaskCheck {
  const task = Number(form.get("task"));
  const expected = String(form.get("expected") ?? "");
  return {
    ...(Number.isInteger(task) && task > 0 ? { task } : {}),
    ...(expected ? { expected } : {}),
    checked: form.get("checked") === "1",
  };
}
