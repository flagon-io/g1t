# Measuring g1t's reviewer with ReviewBench

Internal research, 2026-10-06. Prompted by GitHub's "ReviewBench: an open
benchmark for AI code review" (github.blog). It covers:

- what the benchmark is;
- how g1t's review agent maps onto it;
- a harness in `bench/reviewbench/`, written but not run, because running
  it costs model credit;
- the cost of running it;
- where our reviewer is likely weak, and what to try;
- how to make review quality a tracked number.

Internal only. User-facing copy never names other review products or
leaderboard positions.

## Verdict

- **Worth doing.** ReviewBench is open (the code and the 219-PR corpus with
  labeled findings are MIT, in one repository). It scores the output shape
  our reviewer already produces: file, line, message. Its judge runs
  locally with our own key. It gives us the first quality number for
  `@g1t-agent review` that is not anecdote.
- **Harness status.** The code skeleton is complete in
  `bench/reviewbench/`. The image builds from the production sandbox base
  image. The prompt is generated from `crates/runner/src/review.rs`, and
  `prompt.mjs --check` passes. Nothing has been run against a model.
- **Cost, Sonnet 5.5 reviewer and Sonnet 5 judge.** These estimates come
  from a token model and are plus or minus 50%. Calibrate them against the
  billing ledger's real review runs.

  | Run | PRs | Review | Judge | Total |
  |---|---:|---:|---:|---:|
  | 50-PR sample | 50 | about $62 | about $17 | **about $80** |
  | Test set | 25 | | | about $38 |
  | Full set, one round | 219 | about $274 | about $73 | **about $350** |
  | Full set, three rounds (leaderboard protocol) | 657 | | | **about $1,040** |

  The 50-PR sample on Opus 5.5 is about $103.
- **Expected result as the prompt stands:** high precision and low recall.
  The prompt asks for brevity and "only real problems". Production drops
  comments outside changed files and anchors each comment to a single
  line. The benchmark rewards several distinct, located findings per PR:
  the golden set averages 12 true positives per PR, and 59% of them are
  low severity. The first changes to try are in
  [Improvements](#improvements-to-try-in-order).

## The benchmark

| | |
|---|---|
| Announcement | github.blog, "ReviewBench: an open benchmark for AI code review" |
| Site, leaderboard | https://review-bench.ai (the site text is CC BY-NC 4.0) |
| Repository | https://github.com/review-bench/ReviewBench, **MIT**; pinned at `ceb0794a` in the harness |
| Data in the repository | `corpus/manifest.json` (219 PRs), `corpus/test/test.json` (the 25-PR test set), `golden/<pr_key>.json` (labeled findings, 7.8 MB). Each source repository is mirrored at `github.com/review-bench/<owner>_<repo>` with the base and head commits. |
| Corpus | 219 PRs from 187 repositories, 19 languages: TypeScript 31%, Python 19%, C# 11%, Go 9%, JS 7%. Sizes: 36% over 1,000 changed lines; median 562 lines and 9 files. Types: 36% features, 27% bug fixes. |
| Golden set | 4,632 findings, **2,623 TP** and 2,009 FP. The labeled FPs are kept so that a reviewer repeating a known false alarm is penalized. |
| TP labels | Severity: high 181, medium 891, low **1,551**. Categories: correctness 1,068, maintainability 365, reliability 362, documentation 306, testing 223, security 98, api-architecture 81, performance 63, accessibility 57. Scope: introduced-by-pr 2,391, pre-existing 173, exacerbated 59. Context needed: diff-only 940, diff plus related files 1,529, broader project 154. 78% of TPs span several lines (median span 4 lines). |
| Producers of the TPs | LLM reviewers 1,391; Copilot code review 1,185; human reviewers 39; deterministic tools 8. This is a source of bias, discussed below. |
| Agent contract | One container per PR, `linux/amd64`, 15 minutes. Mounts: `/work/repo` (checkout at head, frozen, shallow, no network to GitHub), `/work/pr/diff.patch` (three-dot diff), `/work/pr/pr.json` (title and body). The agent writes `RB_OUT` as `{pr, agent, findings: [{file, start_line, end_line, message, producer}]}`. Egress is allowlisted. |
| Judge | An LLM matcher compares candidate and golden findings per file, in chunks, semantically, many-to-many. Unmatched findings are then classified TP/FP with the same rubric used to build the golden set. Official judge: Claude Sonnet 5. Local judging uses your own provider key (`npm run judge -- --provider anthropic --model …`). |
| Metrics | Grounded precision (matched TPs over matched) and grounded recall (golden TPs covered); the comparable pair. Augmented precision and recall, which also credit or penalize unmatched findings by the classifier. Novel TP count. F-beta with an adjustable β. Results can be split by severity and category, and reported macro and micro. Duration is reported but not scored. Leaderboard rows are the mean of 3 rounds on the full set. |
| Leaderboard snapshot (2026-10-01) | Top rows: grounded precision 84 to 90%, **grounded recall 16 to 26%**, augmented F1 33 to 50, with 490 to 1,190 findings over 219 PRs. Precision is about the same for everyone; rank follows recall, and recall follows how many distinct, correct findings a reviewer emits. Every row is a vendor's product. |
| Validity notes (from the docs) | The golden set is the union of what its producers found, so issues none of them found are invisible. The labels depend on the classifier (96.6% agreement with independent senior engineers). Augmented recall's denominator differs per agent; compare agents on grounded recall. |

The bias matters for reading our score. Almost half the golden TPs were
found by one commercial reviewer and most of the rest by LLM reviewers. A
reviewer phrasing issues the way those producers do will match more
easily. A finding nobody in the producer set made can still score through
augmented metrics, but not grounded ones. Read our grounded recall as
"agreement with the producer set", not as absolute coverage.

## What g1t's reviewer does today

Sources:

- `services/runner/src/index.ts` (`review`, `startReviewRun`, `withMemory`,
  `guidance`, `modelEnv`);
- `crates/runner/src/review.rs` and `harness.rs`;
- `services/work/src/reviews.rs` and `confidence.rs`;
- `services/runner/wrangler.jsonc`.

**Trigger.** A person asks for a review (`@g1t-agent review`, or the API).
g1t also starts one by itself, from lifecycle and wait queues (`index.ts`
around line 1870). Admission and guardrails apply. The default time cap
for a review is 30 minutes, the cost cap comes from the workspace plan, and
Claude Code enforces `--max-budget-usd`.

**Inputs (the prompt, in order):**

1. `Pull request #N: <title>`, then the description.
2. The linked issue's title and body, if there is one.
3. What people have said on the PR (`peopleSaid`: its comments).
4. Repository instructions (`instructionsFor`, task `review`): `AGENTS.md`,
   `CLAUDE.md`, `.g1t/review.md`, and the same files in directories the
   change touches. Up to 8,000 characters per file and 24,000 in total,
   read from the head only for same-repository branches, never from forks.
5. Workspace and project memory (`memoryContext`), and the context hub
   (`hubContext`: catalog, relevant memory, recent decisions).
6. The fixed `INSTRUCTIONS` in `review.rs`: read `/work/change.diff`,
   then surrounding code, run tests if you like, don't modify anything;
   judge whether it does what it's for, whether it is correct, and whether
   it would break anything; "Be specific and brief. Comment only on real
   problems…"; write
   `{verdict, body, comments: [{path, line, body}]}` to
   `/work/review.json`.

**The sandbox.**

- Full clone at head, merge-base with the target branch, `git diff base
  HEAD` (equivalent to ReviewBench's three-dot diff).
- Claude Code headless (`--print`, `stream-json`, `--max-turns 80`,
  `--dangerously-skip-permissions`) with the repository's toolchains, so it
  can run tests.
- Fork checkouts get `UNTRUSTED_FLAGS`, so the repository's own Claude
  settings are not loaded.
- A review gets no g1t MCP tools and no steer hooks, because no
  `G1T_AGENT_TOKEN` is set.

**What it does not see:**

- Required checks and their results (the review env has no `CHECKS`).
- The CI status of the head.
- Other open PRs touching the same files, although the work service
  computes them (`overlaps`).
- Previous reviews of the same PR, beyond comments via `peopleSaid`.

**Model.** The production route for `review` is **Claude Sonnet 5.5**
(`claude-sonnet-5-5`, `AGENT_ROUTES` in `services/runner/wrangler.jsonc`).
A workspace can route reviews to its own provider through the model proxy
(`openModelSession`). No effort level is set, so it uses the Claude Code
default. The model-env test uses Opus 5.5 for review as a fixture only.

**Outputs and post-processing** (`reviews.rs`, `report_review`):

- Verdict `approve` / `request_changes`, or none if invalid.
- A summary capped at 20,000 characters, signed with the model name.
- Line comments: empty bodies dropped; **comments on files the PR does
  not change are dropped**; at most **30** comments; one `line` (no
  ranges).
- Posted as `g1t-agent`, with a `review.completed` event.
- Confidence (`confidence.rs`) uses the result: `request_changes` sinks
  the change's confidence; `approve` with 3 or more comments costs a
  point; no review costs a point.
- The reviewer reports no confidence or severity of its own. `confidence::ASK`
  is added to implement and revise runs, not to reviews.

### How it would be scored

The adapter (`bench/reviewbench/agent/agent.mjs`) maps each surviving line
comment to `{file: path, start_line: line, end_line: line, message: body}`.
The verdict and summary are kept beside the findings for analysis
(`findings.g1t.json`) but not scored. ReviewBench scores only located
findings.

So:

- A problem described only in the summary scores nothing.
- An empty comment list on a PR with golden TPs costs recall and nothing
  else.
- Every comment counts toward precision. A comment matching a golden *FP*
  counts against grounded precision; an unmatched one is classified by the
  judge.

Benchmark repositories have no g1t memory, issue, comments or
`.g1t/review.md`. The prompt is title, body and `INSTRUCTIONS`, plus
whatever `CLAUDE.md` or `AGENTS.md` the repository carries (Claude Code
reads `CLAUDE.md` itself). This measures the reviewer's core, which is
what we want. Memory and instructions are product features to measure
online.

## The harness (`bench/reviewbench/`)

| File | What it does |
|---|---|
| `run.mjs` | The driver. `setup` clones ReviewBench at the pinned commit and installs its judge. `build` builds the image. `estimate` prices a run without spending. `review` runs our reviewer through ReviewBench's own `scripts/try-agent.sh`, one fresh container per PR, with the benchmark's mounts and validation. `judge` runs ReviewBench's judge with our key. `report` prints a summary or one JSON line. Nothing that spends runs without `--yes`. There is a per-PR cap (`--budget-usd`, default $5, passed to `--max-budget-usd`) and a per-run cap (`--max-total-usd`, default $150). |
| `Dockerfile` | `FROM` the production sandbox base image named in `services/runner/base.json` (pinned by digest, same Claude Code CLI version), plus the adapter. |
| `agent/agent.mjs` | The contract adapter: what `review.rs` does after its clone (writes `/work/change.diff`, runs Claude Code with `harness.rs`'s flags, reads `/work/review.json`), then the filters `reviews.rs` applies (changed files only, at most 30, 20,000 characters), then findings. It also writes a `findings.g1t.json` sidecar: verdict, summary, cost, turns, and comments dropped. |
| `agent/instructions.txt` | Generated from `review.rs` by `prompt.mjs`. `node bench/reviewbench/prompt.mjs --check` fails if production's prompt has moved, which can run in CI. |
| `agent/variants/*.txt` | Alternative instructions to A/B against `production` (`--variant`). `findings-first.txt` is the first candidate (see below). |
| `.cache/` | Gitignored: the ReviewBench clone, repository mirrors, runs, scores. |

Model access goes into each container from the environment:

- `ANTHROPIC_API_KEY` alone sends requests straight to the provider.
- `ANTHROPIC_BASE_URL=<MODELS_URL>/anthropic` plus a model-proxy session
  token sends them through g1t's model proxy. The spend then lands on a
  workspace like any run: use an internal workspace such as flagon-io so
  it is visible in billing.

The judge needs `ANTHROPIC_API_KEY` (or another provider ReviewBench's
`pi` registry supports).

```sh
node bench/reviewbench/run.mjs setup
node bench/reviewbench/run.mjs build
node bench/reviewbench/run.mjs estimate --set sample:50
node bench/reviewbench/run.mjs review   --set sample:50 --seed 1 --yes                 # production prompt
node bench/reviewbench/run.mjs review   --set sample:50 --seed 1 --variant findings-first --yes
node bench/reviewbench/run.mjs judge    --run <id> --yes
node bench/reviewbench/run.mjs report   --run <id>
```

`sample:N` is stratified by change size in the corpus's proportions
(≤200 / 201 to 1,000 / >1,000 lines) and fixed by `--seed`, so week-over-week
runs see the same PRs. The leaderboard's own protocol is `--set full`, three
times.

Before the first paid run:

1. Run `build` and one PR (`try-agent.sh … --pr 0`) with a capped key, to
   check that the adapter writes valid findings. This costs about $1.
2. Check that the image runs as a user that can write `/work`. The base
   image's default user is used.
3. Calibrate `estimateOne` in `run.mjs` against the billing ledger's real
   `review` runs. Every run reports `total_cost_usd`, and spend is kept per
   pull request.

The adapter re-implements about 40 lines of `review.rs` rather than
calling it, because `review.rs` clones from g1t and posts back to the API.
To remove that duplication, a small product change would add
`MODE=review-local` to `g1t-runner`: read `/work/pr/*`, skip the clone and
the report, and write `RB_OUT`. The adapter would then be `exec g1t-runner`.
That is worth doing once the benchmark is in regular use.

### Cost model

Per PR, an agentic review re-reads a growing context from cache every turn.
`run.mjs` models it as follows:

- turns: 12 + 0.8·√lines + 0.4·files, capped at 80;
- context: from about 18K tokens plus the diff, growing about 2.5K tokens
  per turn, capped at 180K;
- 90%+ of input served as cache reads ($0.20/M on Sonnet 5.5);
- new context written once ($2.50/M);
- about 450 output tokens per turn ($10/M).

This gives about $0.90 for a median PR and about $1.25 averaged over the
corpus, which is skewed by the 36% of PRs over 1,000 lines. The judge is
estimated at about $0.33 per PR: matching calls plus a tool-using
classification of each unmatched finding.

## Likely weaknesses against the benchmark

These come from reading the prompt and code; none is measured yet.

1. **Recall is capped by the instructions.** "Be specific and brief.
   Comment only on real problems" and nothing asking for coverage. The
   golden set has 12 TPs per PR (median 10) and 59% are low severity, which
   the benchmark counts as worth fixing: small correctness slips, missing
   tests, stale docs. The best reviewers emit about 5 findings per PR. We
   probably emit 0 to 3. Expect grounded recall well under 15%.
2. **Category blind spots.** The instructions frame the review as
   "correct, does what it's for, doesn't break anything". That covers
   correctness (41% of TPs) and reliability (14%). It gives no prompt for
   maintainability (14%), documentation (12%), testing (9%), security (4%),
   API design, performance or accessibility.
3. **Problems that live only in the summary.** Nothing requires every
   issue in `body` to also be a line comment. Those issues score zero, and
   in the product they are not anchored where an author fixes them.
4. **Comments outside the changed files are dropped.** `reviews.rs`
   discards them. The benchmark anchors some TPs in untouched files, for
   example a missing dependency in `pyproject.toml`, a caller the change
   breaks, or 173 pre-existing-scope TPs. That is a product decision (the
   UI has nowhere to put them), and it costs recall.
5. **Single-line anchors.** 78% of golden TPs span several lines. Matching
   is semantic within a file, so this matters less than the wrong file
   would. A range still helps the matcher and helps a person.
6. **Large changes.** 36% of the corpus is over 1,000 lines (median 9
   files, mean 28). One agent with 80 turns, a 30-minute cap and a
   30-comment cap will read the first files carefully and skim the rest.
   No fan-out by file group.
7. **No verification or calibration.** There is no second pass that checks
   each candidate against the code, so precision rests on the "brief"
   instruction, which also caps recall. There is no per-comment severity or
   confidence, so we cannot pick an operating point (β), and
   `confidence.rs` can only count comments.
8. **Context the product has but the reviewer does not get.** Required
   checks and CI results, overlapping PRs, and earlier reviews. These do
   not matter on the benchmark but matter online.

## Improvements to try, in order

Each is one `--variant` (or a flag) on the same 50-PR sample with the same
seed. The comparison is grounded precision and recall, by severity and
category.

1. **Prompt: findings first** (`agent/variants/findings-first.txt`,
   written). It works in three passes:
   - map the change and its callers;
   - hunt by an explicit category checklist;
   - verify each candidate and drop what isn't true at head.

   It asks for every distinct problem rather than "brief", requires every
   summary issue as a line comment, and adds `end_line` and `severity`.
   The adapter already reads `end_line`. Expect the largest recall gain
   for little cost.
2. **Self-critique as a separate pass.** A second, cheaper call (Sonnet
   5.5 at low effort, or Haiku 4.5) gets each candidate plus the exact
   code lines and answers "true at head? worth the author's time?". Keep
   the survivors. This lets the first pass be generous (recall) while
   holding precision. It costs about 10 to 20% more.
3. **Context retrieval.** Before the agent starts, compute the changed
   symbols (from diff hunks) and their references (`git grep`, or the
   context service where indexed), and put the list in the prompt. Point
   it at the tests that cover the touched files. This targets the 1,529
   TPs needing "diff plus related files".
4. **Fan-out on large diffs.** Over about 800 lines or 15 files, split by
   directory or file group. Run parallel reviewers (Claude Code subagents,
   or separate runs) with the shared PR context, then merge and dedupe by
   file, line and meaning. This targets item 6, the long tail where recall
   collapses.
5. **Confidence calibration.** Have each comment carry `severity` and
   `confidence`. On the benchmark, sweep a threshold to draw the
   precision/recall curve and pick the product's operating point, for
   example post only medium and above inline and fold the low items into
   the summary. Feed the same fields to `confidence.rs`, so that one
   high-severity comment counts for more than three nits.
6. **Model and effort.** Run the same sample on Sonnet 5.5 at
   `medium`/`high` effort and on Opus 5.5. The review route can change in
   `AGENT_ROUTES` without a code change. Opus 5.5 is about 1.4x the cost
   per review at our token profile.
7. **Product-side follow-ups** (not benchmark-visible):
   - allow file-level comments on unchanged files when the change breaks
     them, instead of dropping them;
   - add required-check results and overlapping PRs to the review prompt.

## Making review quality a tracked metric

**Offline (ReviewBench).**

- A weekly g1t Actions workflow, `.g1t/workflows/reviewbench.yml`, runs
  `review --set sample:50 --seed 1` with the production variant and the
  production model, then `judge` and `report --json`.
- The runner base image already has the toolchains. The job needs Docker,
  or, more simply, it can run `agent.mjs` directly in a sandbox that *is*
  the same image, with `/work` laid out by a small wrapper instead of
  `try-agent.sh`.
- Budget: about $80 a week (about $350 a month), billed to the flagon-io
  workspace through the model proxy so it shows in spend.
- Also run on demand for any change to `review.rs`'s instructions or to
  the review route. `prompt.mjs --check` in CI flags such a change.
- Do a full-set run (about $350) monthly, or before a model switch.

**Where results go.**

- Append each `report --json` line to an internal results store: a D1
  table in the work service, or a JSON file committed to `docs/research/`.
- Show it on a **sudo "Review quality"** page, with a trend of:
  - grounded precision and recall;
  - recall by severity (high and medium matter most) and by category;
  - findings per PR;
  - cost per PR.

  Mark the g1t commit and model on each point.
- Not on public docs: our own numbers are fine internally, but
  user-facing copy compares to no one.

**Online, the metric that matters.** Track the *addressed rate* of
`g1t-agent` line comments: the share followed by a commit touching those
lines before merge, or resolved by a person. Also track the share of
`request_changes` verdicts that led to a revision. g1t has the comments,
the commits and the review runs, so this is a query, not a model call. Put
it next to the offline number on the same sudo page. The article's lesson
is that the offline number earns trust only while it moves the same way as
the online one.

## Open questions

- Run once on the public leaderboard? Onboarding is self-service (a GHCR
  image and our key). The final run is three rounds on 219 PRs at our
  inference cost (about $820) with their judge free. A ranking is
  marketing-adjacent, and the no-comparisons rule applies to anything we
  say about it.
- The judge is a Claude model and so is our reviewer. The ReviewBench docs
  report human agreement for the labels but no per-family judge bias.
  Treat small differences (under 2 points, inside the leaderboard's
  round-to-round deviation of about 0.5 to 2) as noise.
