/** Branch health and deployed-code checks refer to different commits after a no-op deploy. */
export function projectCheckSections(head: string | null | undefined, branch: string | null | undefined, deployed: string | null | undefined) {
  const sections: { kind: "branch" | "production"; label: string; sha: string }[] = [];
  if (head) sections.push({ kind: "branch", label: `Latest on ${branch ?? "default branch"}`, sha: head });
  if (deployed && deployed !== head) sections.push({ kind: "production", label: "Checks for deployed commit", sha: deployed });
  return sections;
}

/** A retry of the same SHA is still a separate attempt, including when no deployment ID was returned. */
export function hasSeparateAttempt(currentId: string | null | undefined, servingSha: string | null | undefined, latest: { id: string; sha: string; state: string }): boolean {
  if (!servingSha) return false;
  return currentId ? latest.id !== currentId : latest.sha !== servingSha || latest.state !== "success";
}
