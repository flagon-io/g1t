/**
 * An agent's latest step as the pages show it. The sandbox hands a review,
 * a plan or an answer back as a file under /work; an agent that says so
 * ("The review is written to `/work/review.json`") is saying it finished
 * that, not something anyone needs the path for.
 */
const HANDED_BACK: [RegExp, string][] = [
  [/\/work\/review\.json/, "Wrote its review."],
  [/\/work\/plan\.json/, "Wrote the plan."],
  [/\/work\/answer\.md/, "Wrote its answer."],
];

export function shownStep(step: string): string {
  for (const [path, words] of HANDED_BACK) if (path.test(step)) return words;
  // Any other file of the checkout, as the repository names it.
  return step.replace(/`?\/work\/repo\/([^\s`]+)`?/g, "$1").replace(/`?\/work\/([^\s`]+)`?/g, "$1");
}
