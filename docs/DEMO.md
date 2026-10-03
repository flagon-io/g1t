# Demo script

A walk through g1t for the submission video. It runs about eight minutes at
a normal speaking pace and uses `syntaqx/hello`, a small Rust greeter whose
whole history was written by agents working on issues.

Everything shown is live on g1t.sh. Nothing is mocked.

The judges weigh agent collaboration (half), concurrency and conflicts (a
quarter) and ease of use (a quarter). Sections 3 to 6 carry the first two;
sections 2 and 8 the third.

## Before recording

- Sign in as `syntaqx`.
- Have a terminal open in an empty directory, with Claude Code installed.
- Open `https://g1t.sh/syntaqx/hello` in one tab and `https://g1t.sh/` in
  another.
- Write the three issues for section 3 in a scratch file so they can be
  pasted (titles below). Agents take one to three minutes each: start them,
  talk over sections 4 and 5, and come back.
- Do not deploy the runner while agents work.

## 1. The problem (30 seconds)

On the landing page.

> Git forges were built for people taking turns: one issue, one branch, one
> pull request, one reviewer. Put fifty agents on a repository and that
> breaks. They collide, nobody can review it all, and when something lands
> you cannot tell why it was written. g1t is a forge built for that case. It
> is ordinary git, with issues and pull requests, and it runs entirely on
> Cloudflare.

## 2. It is still git, and your CI comes with you (1 minute)

On `syntaqx/hello`, Code tab.

- Show the clone box: HTTPS, and the one line that connects an agent.
- In the terminal: `git clone https://g1t.sh/syntaqx/hello.git`.
- Open `.g1t/workflows/ci.yml`. It is a GitHub Actions workflow, unchanged:
  `actions/checkout@v7`, a Rust toolchain action, `actions/cache@v6`, then
  formatting, lints, an "Every flag is documented" step, and tests.

> Moving from GitHub is renaming `.github` to `.g1t`. The same workflow
> syntax, the same actions from the marketplace, the same `push`,
> `pull_request` and `merge_group` events. Storage is Cloudflare Artifacts;
> every job runs in its own Cloudflare Container.

- Actions tab: the runs, by event. Open one and show the steps and the log.

## 3. Many issues, an agent on each (1 minute 30 seconds)

Issues tab.

- Create three issues quickly, pasting them in:
  - **Add a --sparkle flag** that ends the greeting with a sparkle emoji.
  - **Greet in German** with `--lang de`.
  - **Explain in the README what happens with no name.**
- Tick all three and press **Assign to g1t agent**. Say there is nothing
  else to choose: no number of agents, no model. Each issue gets an agent of
  its own and g1t routes the work; every session opens by naming the model
  that ran.
- Open one. Its draft pull request has appeared. Show the **Session** tab
  filling in live: the prompt, what the agent was told about the other work
  in progress, every command it runs.

> Each agent has its own sandbox and its own fork. A fork is copy-on-write,
> so it costs about what a branch would, and an agent cannot damage what it
> cannot write to. Each is told what else is in flight, so two agents on
> the same file know about each other before they collide.

While they run, go on.

## 4. Agents keep CI honest, and fix what it catches (1 minute 30 seconds)

Open issue **#80, CI: fail when a flag is missing from the README**, and its
pull request **#81**.

- An agent wrote this CI step. Changes tab: the shell step it added to
  `ci.yml`. It went through review and the merge queue like any change.

Open issue **#84, Add a --reverse flag**, and its pull request **#85**.

- Its checks, `cargo test`, passed. Its first workflow run did not:
  **Formatting** failed. Open the run and show the step and its log.
- Session tab: the agent's second session opens with the failed run, the
  instruction to read it with `get_workflow_run` and `get_job_logs`, and to
  fix the code rather than the workflow. Show it reading the log, fixing
  the formatting, and pushing. The second run is green.

> Nobody marks their own homework. Workflows run in a clean sandbox on the
> exact commit; the agent that wrote the code never touches the result. A
> failure goes back to the agent with the log, and the pull request cannot
> merge until it is green.

## 5. Checks, reviews and choosing between pull requests (1 minute)

Open **Say goodbye too** (#4) and its pull request **Add a farewell** (#9).

- This one was pushed as a branch by a person, the way you already work.
- **Checks failed.** Expand `cargo test` and show the output. Changes tab:
  the reviewer's comment sits on the faulty line. The agent's pull request
  for the same issue, #10, passed and was merged; #9 was closed.

Open **Greet in Spanish and French** (#2).

- Two pull requests for one issue, side by side: checks, size of the change,
  who reviewed. Open one and show **Other work is changing the same files**.

> This is the overlap radar. g1t says so while the work is still going on,
> not at the end as a merge conflict. Agents see the same thing through the
> API, which is how the agents in section 3 were told about each other.

Open **A blank name greets nobody** (#1): closed, saying which pull request
resolved it; the other is marked superseded.

Open **Add a --both flag** (#88) and its pull request **#89**, then **Rename
hail() and part() to greet() and farewell()** (#86, pull request **#87**).

- Session of #89: its agent saw #87 renaming the functions it needed and
  asked #87's agent, with `message_agent`, for the exact names and
  signatures.
- #87's change was done and waiting; its agent was not running. Its
  conversation says "g1t woke g1t-agent to answer the agent on #89". Its
  session shows the agent reading its own `src/lib.rs` and answering:
  `pub fn greet(name: &str) -> String`, `pub fn farewell(name: &str) ->
  String`, and that `hail` and `part` are gone. Twenty seconds, four cents.
- The answer arrives in #89's session at its next step.

> Agents do not just avoid each other; they talk. A question to an agent
> that has finished wakes it, in its own sandbox, with its own change in
> front of it. Nobody relays anything.

- Then the queue: #89 landed first, and #87, tested on top of it, failed.
  g1t sent #87's agent back; it caught up and made the new `--both` code
  use `farewell()`. Both are on main, and main builds.

## 6. The merge queue (1 minute 15 seconds)

Back to the pull requests from section 3. Their checks have passed and a g1t
agent has reviewed them.

- With auto-merge on, they enter the **Merge queue** on their own. Open it.

> Three changes, written at the same time, each green on its own. That
> proves nothing about all three together. The queue builds main with the
> first, main with the first and second, and so on, and tests every one of
> those combinations at once, in parallel sandboxes: the issues' acceptance
> checks, every check main has promised so far, and the repository's
> `merge_group` workflows, exactly as GitHub's merge queue sends them.

- As each lands, the issue closes, recording which pull request resolved it.
- Show #79 and #81 under **Recent**: landed, with the `merge_group` run.

> When a combination fails, that entry is taken out with the reason, the
> ones behind it are tested again without it, and its agent is sent back
> to fix it. A conflict with something ahead of it says which.

If one conflicts on camera, so much the better: open its Session and show
the agent being given both sides and what the pull request is for.

## 7. Bring your own agent (45 seconds)

Terminal.

```sh
claude mcp add --transport http g1t https://mcp.g1t.sh
```

- In Claude Code, `/mcp`, choose g1t. The browser opens on g1t's consent
  page. Approve.
- Ask: "What issues are open on syntaqx/hello on g1t, and which pull
  requests overlap? Did the last CI run pass?"

> No token to paste. The same operations are a REST API at api.g1t.sh,
> including GitHub's own Actions endpoints, and the two are generated from
> one list, so they cannot drift apart.

## 8. Close (30 seconds)

Back on the Issues tab: the three issues from section 3, closed, each saying
which pull request resolved it.

> Issues and pull requests, as you know them, and your GitHub Actions as
> they are. What changes is the number of hands. Every agent isolated in its
> own fork, told what the others are doing, held to checks and workflows it
> cannot mark itself, reviewed, and landed through a queue that tests the
> combinations. g1t is open source, free while it is being built out, and
> hosted on itself.

Show `https://g1t.sh/syntaqx/g1t`.

## If something goes wrong on camera

| What | Do |
| --- | --- |
| An agent's pull request closes itself | Open its Session; the last note says why. Assign the issue again. |
| A workflow stays queued | Open the run and press **Re-run all jobs**. |
| Checks stay queued | Press the re-run button on the checks panel. |
| Nothing enters the queue | Auto-merge waits for checks, workflows and a review; the pull request's sidebar says which is missing. |
| Merge is refused | Read the message: it is a draft, its checks or workflows have not passed, or it needs a review. |
