# sudo

g1t's staff console, at <https://sudo.g1t.sh>: the back office g1t is
building for itself, for sales, support and finance. It is organised the
way customers know g1t: by **workspace**.

The sidebar (`app/lib/nav.ts`) has Overview and Reach out at the top, then
sections that fold open to their pages: Customers, Revenue, Platform,
Support and Team. Each fold is a `<details>`, drawn open for the section
holding the current page; on a phone the same menu sits behind a "Menu"
button in the top bar. Pages not built yet are marked **Soon**: each is a
real page (`routes/soon.tsx`, made from its entry in `nav.ts`) saying what
it will do, why, and what it will have, so the sidebar doubles as the
roadmap.

- **Overview** (`/`): this month charged, cost and margin; the last six
  months as a chart; this month by kind of usage; paying workspaces; how
  many are stopped, near their limit or declined (each a link into Reach
  out); open invoices; follow-ups due; and the five most urgent signals.
  From billing's `admin_overview` and `admin_signals`.
- **Reach out** (`/reach-out`): every workspace worth a word, most urgent
  first (at limit, declined, near limit, high spend, growing, established,
  first payment), with its owners, the reason in a sentence, the figure,
  and its sales stage and owner at g1t. Filter by why and by whose
  (everyone's, unassigned, mine), or show only **follow-ups due** (a next
  step due today or earlier, on a deal not won or lost; one per
  workspace). Rows show the next step and its day. Each row opens the
  workspace's Sales.
- **Invoices** (`/invoices`): every invoice g1t has sent, workspaces' and
  enterprises', newest first (`admin_invoices`, at most 200). Filter by
  status and month; totals for what is listed (amount, paid, outstanding);
  each links to its workspace or enterprise and to Stripe's page (https
  only).
- **Audit log** (`/audit`): every change made in sudo, and what Stripe told
  billing, newest first, 100 a page with "Older" (`admin_audit`). Filter by
  staff email and kind of change; each line links to its workspace or
  enterprise.
- **Workspaces** (`/workspaces`): every workspace, newest first, 50 to a
  page, with its owners, members, who it is billed to, its terms, this
  month's usage against its limit, what it was charged and what it cost
  g1t. Search by workspace, owner, email or enterprise (across the whole
  list); filter to stopped or warning, comped or custom, or on an
  enterprise. Billing's figures are fetched for exactly the page shown, so
  the filters, and the totals over the list, cover that page; the page
  says so when there is more than one. A workspace's page shows its members;
  **Sales** (its stage, the staff member who has it, the next step and its
  date, and notes, newest first; `admin_sales`, `admin_set_sales`,
  `admin_add_note`); and under **Billing** its limit in words (trust, the
  owners' own spend limit or the default, the most they may set, how it
  grows), its last six months as a chart, its invoices (`admin_workspace_invoices`,
  with Stripe's page and PDF), its terms, who it is billed to (move it onto or off an
  enterprise), a credit form, a Stripe billing link, its ledger and its
  audit log. If billing does not answer for sales or invoices, the page
  still opens and says so in those sections. A protected workspace (one
  nobody can ever delete: identity's `PROTECTED_WORKSPACES`, and
  flagon-io always) says so beside its name.
- **Deleted workspaces** (`/workspaces/deleted`, linked from Workspaces):
  workspaces their owners deleted, newest first (`admin_deleted_workspaces`),
  each with who deleted it and when, when it is purged, what went with it
  (repositories, projects, members, counted at the deletion) and the days
  left. An owner deletes a workspace with everything in it in one step, and
  identity keeps it 30 days (`WORKSPACE_RESTORE_DAYS`) so support can undo a
  deletion that was a mistake or not theirs to make. **Restore**
  (`admin_restore_workspace`) brings it back with its members and tokens,
  and its repositories, projects and apps with `workspace.restored`; its
  plan stays ended, so its owners start it again from Billing. Check that
  whoever asks is an owner of it before restoring. **Purge now**
  (`admin_purge_workspace`, the slug typed to confirm) removes it at once,
  as the sweep does every 15 minutes once its 30 days are up; never for a
  protected workspace. Both go in the workspace's audit log, as g1t, and in
  sudo's (`workspace_restored`, `workspace_purged`), naming the staff
  member.
- **Enterprises**: customers that pay for several workspaces with one
  bill, one limit and one set of terms. Each has its workspaces (add or
  remove them), combined usage, terms, credits, ledger and audit log, and
  **Invoices**: where they go (the billing email, which also makes its
  Stripe customer), a "Send invoice now" button, and every invoice with
  its status (open, paid, overdue, void), a line per workspace, and a link
  to Stripe's hosted invoice page. An invoice also goes out on its own as
  each month closes: one Stripe invoice, a line per workspace for what it
  owes, net 30, emailed by Stripe.
- **Stripe**: whether billing's key is in test or live mode (or off), the
  webhook Stripe calls (URL, endpoint id, events, who registered it and
  when), and the events Stripe sent lately with what billing did with
  each. "Register webhook" (or "Replace") has billing delete the endpoint
  it made before, create a new one and keep its signing secret, which no
  one sees. Do it once per mode, and again after switching to live keys.

Sales changes are not money, so they have no confirmation step; they are
still POSTs from sudo's own pages, recorded with who made them.

Billing's internal account ids (`ws_<slug>` for a workspace's own,
`ent_…` for an enterprise) are never shown as names; an enterprise's id
appears only as small "Billing account id" text. Old `/accounts/…` links
redirect to the workspace or enterprise they meant.

**Cards stay on Stripe.** sudo never shows a card field. To help a customer
update their card or see invoices, staff make a Stripe billing link on the
workspace's page (it is recorded) and send it to the owner.

It holds no data. Workspaces, owners and members come from identity's
staff methods (`admin_workspaces`, `admin_workspace`; `IdentityAdminApi` in
`packages/contracts/src/identity.ts`); everything about money goes to the
billing service's (`admin_*`, `BillingAdminApi` in
`packages/contracts/src/billing.ts`), where each change is recorded with
the staff member's email. Both are reached over service bindings only, and
nothing but sudo binds to them.

## How it is locked

1. **Cloudflare Access** sits in front of `sudo.g1t.sh` and signs people in.
2. **The worker checks Access's work** on every request, the stylesheet
   included (`run_worker_first`): it verifies the `Cf-Access-Jwt-Assertion`
   JWT itself (RS256 against the team's published keys, audience, issuer,
   expiry), then requires its email to be in `STAFF_EMAILS`. That email is
   who every change is recorded as. See `app/lib/access.ts`.
3. **It fails closed.** Until `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and
   `STAFF_EMAILS` are all set, every request gets a 403 saying sudo is not
   configured.
4. **Changes** are POSTs only, and only from sudo's own pages (`Origin`, or
   `Referer`, must be `https://sudo.g1t.sh`). Terms, enterprise moves, new
   enterprises, Stripe billing links, invoice emails, invoices and the
   webhook show a confirmation step first; a credit needs the workspace's
   slug typed out.
5. **The pages ship no JavaScript.** The content security policy forbids
   every script and inline style; responses are `no-store`, `noindex` and
   cannot be framed. The worker has no `workers.dev` address or preview URLs.

## Setting up Access (once, in the Cloudflare dashboard)

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
   - Application name: `sudo`.
   - Session duration: short, such as 8 hours.
   - Public hostname: `sudo.g1t.sh` (path empty, so it covers everything).
2. **Add a policy** (`g1t staff`): action *Allow*, include *Emails* → the
   owner's address, and *Emails ending in* → `g1t.sh` for everyone with a
   g1t address (the same entries as `STAFF_EMAILS`, where a domain is
   written `@g1t.sh`). Add more staff here *and* in `STAFF_EMAILS`; either
   one alone is not enough.
3. Save, then open the application's **Overview** (or *Basic information*)
   and copy the **Application Audience (AUD) tag**.
4. Find the **team domain** under **Zero Trust → Settings → Custom pages**
   (or *Team name and domain*): it looks like `<team>.cloudflareaccess.com`.
5. Put both into `wrangler.jsonc`:

   ```jsonc
   "vars": {
     "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
     "ACCESS_AUD": "<the AUD tag>",
     "STAFF_EMAILS": "syntaqx@gmail.com, @g1t.sh"
   }
   ```

6. Deploy: `scripts/deploy.sh sudo` (after `billing` and `identity`, whose
   `admin_*` methods it calls).

Visit <https://sudo.g1t.sh>: Access asks you to sign in, then the workspaces
list opens. Anyone else gets Access's own refusal; anyone Access lets in who
is not in `STAFF_EMAILS` gets a 403 from the worker.

## Signing in through WARP

Staff signed in to the Zero Trust org in the Cloudflare One agent (WARP)
reach sudo without the login page: the org allows WARP sessions as Access
sign-ins (8 hours), the sudo app accepts them, and the `g1t staff` policy
is also on the WARP enrollment app, so staff can enroll their devices.
The same two checks still apply: the Access policy, and `STAFF_EMAILS`.

## Working on it

```sh
npm run typecheck -w @g1t/sudo
npm test -w @g1t/sudo     # JWT verification, forms, money, the workspace join, paging, nav, charts, signals
npm run build -w @g1t/sudo
```

`npm run dev` serves the pages, but every request is refused without a real
Access token, by design.
