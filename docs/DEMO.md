# Demo script

A walk through g1t for the submission video. It runs seven to eight minutes
at a normal speaking pace and uses `syntaqx/hello`, which is seeded for it.

Everything shown is live on g1t.sh. Nothing is mocked.

## Before recording

- Sign in as `syntaqx`.
- Have a terminal open in an empty directory, with Claude Code installed.
- Open `https://g1t.sh/syntaqx/hello` in one tab and `https://g1t.sh/` in
  another.
- Agents take one to three minutes. Start them, talk over something else,
  and come back. Do not deploy the runner while they work.

## 1. The problem (30 seconds)

On the landing page.

> Git forges were built for people taking turns: one issue, one branch, one
> pull request, one reviewer. Put fifty agents on a repository and that
> breaks. They collide, nobody can review it all, and when something lands
> you cannot tell why it was written. g1t is a forge built for that case. It
> is ordinary git, with issues and pull requests, and it runs entirely on
> Cloudflare.

## 2. It is still git (45 seconds)

On `syntaqx/hello`, Code tab.

- Show the clone box: HTTPS, and the one line that connects an agent.
- In the terminal: `git clone https://g1t.sh/syntaqx/hello.git`.
- Mention: storage is Cloudflare Artifacts; the site, the API and every
  service are Workers.

## 3. Many issues, an agent on each (2 minutes)

Issues tab.

- Point out labels, and that issues come from people, agents or anything
  with a token, such as an error tracker.
- Tick several open issues and press **Assign to g1t agent**. Say that
  there is nothing else to choose: no number of agents and no model. Each
  issue gets an agent of its own and g1t routes the work; every session
  opens by naming the model that ran.
- Open **Document the command-line options**. Its draft pull request has
  appeared. Show the **Session** tab filling in live: the prompt, the
  agent's reasoning, every command.

> Each agent has its own sandbox, a Cloudflare Container, and its own fork.
> A fork is copy-on-write, so it costs about what a branch would, and an
> agent cannot damage what it cannot write to.

While they run, go to the next section.

## 4. Checks nobody can fake (1 minute)

Open **Say goodbye too** and its pull request, **Add a farewell**.

- This one was pushed as a branch by a person, the way you already work.
- **Checks failed.** Expand `cargo test` and show the output.
- Changes tab: the reviewer's comment sits on the faulty line.

> The issue says what done means: here, `cargo test`. g1t runs that itself,
> in a clean sandbox that holds only this commit. The agent that wrote the
> code never touches the result, so a pass means something. And a pull
> request that has not passed cannot be merged.

## 5. Choosing between pull requests (1 minute 15 seconds)

Open **Greet in Spanish and French**.

- Two pull requests for the same issue, side by side: checks, size of the
  change, who reviewed.
- Open one. Show **Review by a g1t agent**: comments on lines, a summary, a
  verdict. Say that an agent cannot review its own pull request.
- Show **Other work is changing the same files**.

> This is the overlap radar. Two pull requests for different issues are
> editing the same file. g1t says so while the work is still going on, not
> at the end as a merge conflict. Agents see the same thing through the API.

## 6. Converging on main (1 minute 15 seconds)

Open **A blank name greets nobody**.

- It is closed, and it says which pull request resolved it. The other one
  is marked superseded.

> Two pull requests for one issue, one merged. The issue records which.

Go back to a pull request for the Spanish and French issue that says main
has moved.

- Press **Catch up with main**. Open the Session tab.

> Something else landed first, so this pull request is behind. A g1t agent
> merges main in. If that conflicts, the agent is given both sides and what
> this pull request is for, and resolves it. Then the checks run again on
> the result.

- When it is done, merge it. The issue closes; the other pull request for
  it closes as superseded.

## 7. Bring your own agent (45 seconds)

Terminal.

```sh
claude mcp add --transport http g1t https://mcp.g1t.sh
```

- In Claude Code, `/mcp`, choose g1t. The browser opens on g1t's consent
  page. Approve.
- Ask: "What issues are open on syntaqx/hello on g1t, and which pull
  requests overlap?"

> No token to paste. The same operations are a REST API at api.g1t.sh, and
> the two are generated from one list, so they cannot drift apart.

## 8. Close (30 seconds)

Back on the first issue: the three pull requests from section 3 are ready,
with their checks.

> Issues and pull requests, as you know them. What changes is the number of
> hands. Every pull request isolated in its own fork, every decision
> recorded with the code, checks that agents cannot mark themselves, overlap
> flagged while it is happening, and one clear answer to which change you
> took. g1t is open source, and it is hosted on itself.

Show `https://g1t.sh/syntaqx/g1t`.

## If something goes wrong on camera

| What | Do |
| --- | --- |
| An agent's pull request closes itself | Open its Session; the last note says why. Assign another. |
| Checks stay queued | Press the re-run button on the checks panel. |
| Catch up does nothing | The pull request was already up to date; refresh. |
| Merge is refused | Read the message: it is a draft, its checks have not passed, or main moved. |
