# apps/web

## A part that fails stays in its part

Every page is built so one failed read or one broken card never takes the
page down. Follow this on any page you add or change; older pages are
brought up to it as they are worked on.

- **What a page is about is read strictly.** The pull request on its page,
  the settings being edited, anything that decides access or a redirect:
  if that fails, the page fails, inside its frame (routes/page-boundary.tsx).
- **Everything beside it is a part.** Read it through
  `part(promise, "What it is")` (app/lib/partial.ts). It gives the value, or
  `Failed` when the service did not answer or answered with a 5xx. A 404 or
  a refusal (`{ ok: false }`) is an answer, not a failure: read it as before.
- **A failed part says so in its own place**, the way a form says what is
  wrong beside the field: `<Unavailable what="…" />`
  (app/components/boundary.tsx; `compact` in a sidebar or small slot),
  under the card's heading. Never let a failure read as an empty or false
  state ("No deployments yet", "Checks are off").
- **A form whose data failed is not shown.** Show Unavailable instead, so
  nothing is saved over values that were never read.
- **Quiet fallback only for what nobody would miss** (a decoration, a
  suggestion the server checks again): `orElse(await part(…), fallback)`,
  with a comment saying why.
- **A complex card sits in `<Boundary what="…">`**, so an error while
  drawing stays in the card. `Panel` does this already.
- **A streamed promise never rejects into an `<Await>` without an
  `errorElement`**: resolve it through `part`, or give it one.

Network blips are handled once for every page (app/lib/resilient-fetch.ts,
components/connection-toast.tsx); the root error page is the last resort.
