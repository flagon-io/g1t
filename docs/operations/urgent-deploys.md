# Urgent deploys

Owner: whoever is on the incident. The full reference is the deploy guide's
[Urgent deploys](https://docs.g1t.sh/guides/deploy-to-cloudflare/#urgent-deploys);
this page is the checklist.

An ordinary deploy reaches every Worker within seconds, but lets each busy
runner sandbox and git edge (Cloudflare Containers) finish its job first, for
up to two hours. An urgent deploy replaces all of them now and stops the jobs
running on them. Use it when a fix to the runner cannot wait: a security fix,
an unsafe or broken sandbox image, an edge serving bad data.

## Checklist

1. **Contain first, if the fix will take a while.** sudo → Costs & margin →
   Platform pause: **compute** stops new jobs' sandboxes from starting; **git
   edge** sends every clone to Artifacts. Both take effect within 30 seconds,
   with no deploy. Record why in the pause's reason.
2. **Land the fix on `main`** (a pull request, or a direct push in an
   emergency). Its ordinary deploy starts; an urgent one makes sure the
   runner goes out now, whatever the ordinary one decided.
3. **Make the urgent deploy**, one of:
   - g1t: Actions → Deploy → Run workflow → tick **urgent** → run.
   - CLI: `g1t workflow run deploy.yml -F urgent=true`.
   - MCP: `workflow` → `dispatch`, workflow `deploy.yml`, inputs `{"urgent": true}`.
   - When Actions itself is broken, from a checkout of `main` with Cloudflare
     credentials: `node scripts/deploy.mjs deploy --only runner --force --urgent`.
4. **Check it took.** The deploy log's container lines say "no rollout in
   progress" for every `g1t-runner-*` application (or run
   `npx wrangler containers list` in `services/runner`). Start a job a few
   minutes later (`g1t workflow run ci.yml`) and confirm it has the fix.
5. **Resume** whatever you paused in step 1.
6. **Tell people whose jobs were stopped** when it matters: those runs show as
   failed and can be run again.

To go back instead of forward, see the guide's
[Rolling back](https://docs.g1t.sh/guides/deploy-to-cloudflare/#rolling-back);
the runner's older image is still in the registry.
