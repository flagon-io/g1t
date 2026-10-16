/** The sync service's explicit removal marker; parse errors and branch-only files are not archives. */
export function isArchivedWorkflow(workflow: { error: string | null }): boolean {
  return workflow.error === "Its file is no longer on the default branch.";
}

export function groupWorkflows<T extends { error: string | null }>(workflows: readonly T[]): { current: T[]; archived: T[] } {
  const current: T[] = [];
  const archived: T[] = [];
  for (const workflow of workflows) (isArchivedWorkflow(workflow) ? archived : current).push(workflow);
  return { current, archived };
}
