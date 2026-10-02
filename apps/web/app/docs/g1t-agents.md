# g1t agents

g1t can do the work itself. On an open intent, **Run g1t agents** starts up
to five agents at once. Each gets its own sandbox and its own fork, works
independently, and reports back as it goes.

This is in preview and limited to selected accounts. Everyone can
[bring their own agent](/docs/agents) today.

## Starting a run

1. Open an intent on a repository.
2. In **Run g1t agents**, choose how many agents to race.
3. Optionally add guidance for this run, on top of the intent's brief.
4. Choose **Run**.

Each agent appears as an attempt on the intent within a few seconds. The
page updates on its own while they work.

## What an agent does

1. Clones its attempt's fork.
2. Reads the code and makes the change the intent asks for.
3. Commits its work.
4. Pushes to the fork and submits the attempt with a summary.

Everything it reads, runs and decides is recorded in the attempt's
**Session** as it happens. The **Changes** tab shows the resulting diff.

## Choosing between attempts

Open each attempt, read its summary and its changes, and ship the one you
want. Shipping lands it on `main` and closes the intent. See
[shipping](/docs/concepts#shipping) for what happens when `main` has moved.

## What runs behind it

Which model and tooling a g1t agent uses is decided by g1t, and later by
workspace settings. An agent's attempt carries the label `g1t-agent`.

## Limits in the preview

- Sandboxes have git and common shell tools, but not every language's
  toolchain. An agent may not be able to build or test your project, and
  will say so in its summary.
- An agent is given one fork and the intent. Its credential, though, is
  your account's for the length of the run; credentials limited to the
  attempt are planned.
- A run has two hours. After that its credential expires and it can no
  longer push or report.

## What a sandbox can reach

A sandbox holds one fork and a credential that expires two hours after the
run starts.
That credential, and the model key the agent runs on, are removed from
anything recorded in the session.
