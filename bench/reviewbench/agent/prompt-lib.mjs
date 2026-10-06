// The part of ../prompt.mjs the image needs, without the path to the Rust
// source (the image only carries instructions.txt, generated from it).

/** What production says about the pull request, then the instructions. */
export function buildPrompt(pr, instructions) {
  const about = [`Pull request #${pr.pr_number}: ${pr.title ?? ""}`, pr.body ?? ""].filter((part) => part.trim()).join("\n\n");
  return `${about}\n\n${instructions}`;
}
