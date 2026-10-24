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
  billing, newest first, 100 a page with "Older" (`admin_audit`). Changes
  other services make for staff are written to it with `admin_log`:
  identity's (deleted workspaces and accounts, aliases, suspensions) and storage holds
  released on Storage holds. Filter by staff email and kind of change; each
  line links to its workspace or enterprise.
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
- **Suspend and clean up** (`/workspaces/<slug>/abuse`, linked from a
  workspace's page): suspend the workspace, with a reason (identity's
  `admin_suspend_workspace`): its own tokens stop, and a billing hold
  (`Suspended: <reason>`) stops its runs, checks, deploys, new
  self-hosted runners and telemetry. Lifting it lifts that hold, never one
  staff set otherwise. Remove its self-hosted runners one at a time or all
  at once, which also ends its registration tokens (actions'
  `admin_runners`, `admin_remove_runners`), and revoke its projects'
  telemetry ingest tokens. Every change is in sudo's audit log.
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
- **A person's page** (`/users/<username>`, linked from a workspace's
  members): their addresses (remove one, with a reason they see), their
  security log, and **Delete account**. An account made with a shared
  invite link, before registration opened, says **Joined through
  <label>** under its name. Delete only when the person asks
  (from one of the account's confirmed addresses) or for abuse: give the
  reason, which goes in sudo's audit log (`account_deleted`), and type the
  username (`admin_delete_account`). It does what deleting their own
  account from Settings does: signs them out everywhere, ends their tokens,
  SSH keys, deploy keys they added and applications, takes them out of
  every workspace, team and repository, and emails their addresses that
  staff deleted it. While the account is the **only owner of a live
  workspace**, the page lists those workspaces, each linking to its page,
  and the form becomes **Delete account and the workspaces it alone
  owns**: the reason, the username typed, and a box ticked to say the
  named workspaces go too (`admin_delete_account` with
  `withSoleWorkspaces`). Use it for an account g1t no longer needs, such
  as a retired test account and its personal workspace; for a customer,
  prefer another owner first (an owner makes one under People). Identity
  checks every one of those workspaces before anything is deleted: one
  that is protected, or whose billing cannot settle (`close_workspace`:
  an unpaid invoice, prepaid credit, usage still metering, an enterprise
  account), refuses the whole deletion, and the page says which and why
  beside each, instead of the form. Then it deletes each workspace exactly
  as its owner would (billing closes it, `workspace.deleting`, its
  repositories and apps go with it, kept 30 days), with the staff member
  as who deleted it, and the account last. Each workspace is recorded in
  its own audit log as g1t (rule `staff`) and in sudo's
  (`workspace_deleted`, with the reason); the account in sudo's
  (`account_deleted`, naming the workspaces). Should one fail on the way
  (a card declined that moment), the account is not deleted and the
  error names the workspace and any that went before; restore those from
  Deleted workspaces, or try again. Accounts that can never be deleted (`g1t`, `g1t-agent`, `ghost`,
  and whatever identity's `PROTECTED_ACCOUNTS` names, by username or id)
  are marked **Protected** and offer no form. A deleted account's page
  says so, with who deleted it, why, when it is purged, and **Restore** and
  **Purge now**, as on Deleted accounts; both work at once, with no wait.
  When workspaces were deleted with it, it lists them too, each with its
  own **Purge now** (`admin_purge_workspace`, the slug typed; identity
  purges only a workspace that is still deleted, never a protected one),
  so staff can remove everything straight away. Purge the workspaces
  first: once the account is purged its page is gone (they stay on
  Deleted workspaces). To undo it all, restore the account first, then
  each workspace, so it comes back with its owner.
- **Suspending an account**, on a person's page: with a reason, it cannot
  sign in (with a password or GitHub), is signed out everywhere, and its
  tokens, SSH keys and git passwords stop until the suspension is lifted
  (identity's `admin_suspend_user`). Nothing is deleted.
- **Blocked domains** (`/blocked-domains`, under Platform): email domains,
  and their subdomains, no new account may sign up with or add, each with
  a reason (`admin_blocked_domains`, `admin_block_domain`). Accounts
  already there are not touched.
- **Storage holds** (`/storage`, under Platform): public storage that
  writes reserved before reaching the git store, and the locks native
  forks put on their source, oldest first (the repos service's
  `admin_storage_holds`): each with its repository, the write behind it
  (push, merge, fork, import and so on) and who made it, its age, its
  lease, and whether it is **provably abandoned** and why. **Inspect**
  (`admin_inspect_storage_hold`) adds what the git store lists for each
  repository the hold names (refs, the default branch's commit), what g1t
  counts for it (stored, reserved, how much of that the ledger accounts
  for), and for a push that ended, each ref it asked for against the
  store's. **Release** (`admin_release_storage_hold`) is offered only on a
  provably abandoned hold and takes a reason; the repos service inspects
  it again, checks the same rules in the batch that releases, and writes a
  row of `storage_recoveries` with the evidence, listed under **Released**
  (`admin_storage_recoveries`). The same batch keeps the release's line
  for the audit log (`storage_released`): under the charged repository's
  workspace, or the `storage` account when its row is gone, naming the
  staff member, the hold, the reason and the `storage_recoveries` row. The
  repos service sends it to billing's `admin_log` right after, keyed by
  that row, and again every hour until billing confirms it, so a lost
  answer or a request cut short neither loses it nor writes it twice; sudo
  writes nothing itself. While billing has not confirmed it, the page and
  the row under **Released** say so. (Against a repos service from before
  it wrote the line, sudo writes it, keyed the same way, and says if that
  failed. While a deploy has the new repos service but sudo from before
  it, a release can be in the audit log twice, since that sudo still writes
  its own line, unkeyed; it is never missing.) Provably abandoned means: the
  write recorded that it ended; or its one-hour lease passed 15 minutes ago; or,
  for bytes reserved before the ledger began and locks without a lease,
  24 hours have passed since it began. A release never changes
  `stored_bytes`, which is billed. **Drift** (`admin_storage_drift`) streams
  a small random sample of repositories from the store and sets what it
  holds beside `stored_bytes`; it reads only. The runbook is
  `docs/operations/storage-holds.md`.
- **Deleted accounts** (`/users/deleted`, linked from Workspaces):
  accounts deleted by the person or by staff, newest first
  (`admin_deleted_accounts`), each with who deleted it (the person, or the
  staff member and why), when it is purged, the days left and what it
  left (workspaces, teams, repositories, tokens, SSH keys). Identity keeps
  each 30 days (`ACCOUNT_RESTORE_DAYS`). **Restore**
  (`admin_restore_account`) clears the deletion and puts back the
  memberships, teams and repository roles it left where they still exist;
  its sessions, tokens and keys stay ended, and the person signs in with
  their password. Check that whoever asks owns one of its addresses first.
  **Purge now** (`admin_purge_account`, the username typed) removes it at
  once, as the sweep does every 15 minutes once its 30 days are up: its
  row, addresses, keys, two-factor secret, GitHub link, profile and
  security log go; its username is kept in `deleted_users` and never given
  out again; what it wrote shows as `ghost`. Both go in sudo's audit log
  (`account_restored`, `account_purged`), naming the staff member. There
  is no API route for deleting an account; only the site and sudo can.
- **Access requests** (`/waitlist`, under Customers): at the top, the
  **sign-up switch**: open to everyone, or invite only (private preview),
  with who last flipped it and when. One button flips it
  (`admin_set_registration`, kept in identity's `identity_settings`): no
  deploy, the site follows within a minute, and the change goes in the
  audit log under flagon-io (`registration_changed`). Until anyone has
  flipped it, identity's `REGISTRATION_MODE` var says (`invite` on
  g1t.sh). In private preview a new account, with a password or through
  GitHub, needs an invite for its own address. People without one ask on
  the sign-up page, saying what they
  will build, and wait here: Waiting (oldest first, with its count in the
  sidebar), Invited, Dismissed or All, searchable by address or what they
  said (`admin_waitlist`, `admin_waitlist_pending`). **Approve and
  invite** makes an invite to g1t bound to the address, charged to nobody,
  and emails it with an optional note (up to 500 characters);
  **Dismiss** only marks the request and tells nobody
  (`admin_decide_waitlist`). Each decided row says who decided and when,
  the note sent, and **Joined as @them** once the invite made an account.
  Staff hear about new requests by email at identity's
  `WAITLIST_NOTIFY_EMAIL`, at most one summary every 15 minutes, covering
  every request since the last. While sign-up is open, the waitlist
  stays as it is and nothing new waits here.
- **Invites** (`/invites`): every invite code: those sent with an
  invitation into a workspace or onto a repository, those approved from
  Access requests, and invites to g1t that people send their friends with
  Invite a friend (20 each), on their own tab. In private preview each is
  a way in.
  Searchable by a code's start, an email or a username; a pending one can
  be revoked (`admin_invites`, `admin_revoke_invite`). The Invites to g1t
  tab also grants a person more of them, or takes some back, with why
  (`admin_grant_invites`, kept in `invite_grants`). The old shared links
  stay in identity's database, untouched.
- **Aliases** (`/aliases`, under Customers): names that lead to a
  workspace, set by staff only; there is no way for a customer to make
  one, and nothing user-facing mentions them. `g1t`, the product's name,
  leads to `flagon-io`, Flagon, Inc. (seeded by identity's migration
  `0029_workspace_aliases.sql`), so nobody mistakes the trading name for
  the organization. Every address under an alias leads to the workspace:
  pages answer with a 301 to the same page (`/g1t/g1t/pulls` to
  `/flagon-io/g1t/pulls`), git over HTTPS is answered in place as the
  workspace's repository (pushes do not follow redirects), the API and MCP
  run the call again under the workspace's slug, and the package
  registries answer a 301 (308 for a publish). An alias points at the
  workspace's id, so it follows a rename; it goes when the workspace is
  purged. Each row shows the workspace, why the alias exists, and who added
  it and when. **Add** (`admin_set_alias`) takes the alias, the
  workspace's slug and why: identity refuses the site's own routes
  (`settings`, `api`…), anyone's username, a workspace's slug (deleted, or
  held after a rename for another workspace) and an existing alias.
  Reserved names such as `g1t` can be aliases, and an alias is nobody's to
  register or rename a workspace to while it exists. **Remove**
  (`admin_remove_alias`) needs a reason. Both go in sudo's audit log
  (`alias_added`, `alias_removed`), naming the staff member. `@g1t` in
  text still means g1t itself (Ask g1t), never the alias's `/g1t`.
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
   **Service tokens.** A program (Claude, working without a browser) signs
   in with an Access service token instead: it sends `CF-Access-Client-Id`
   and `CF-Access-Client-Secret`, the Access application has a policy with
   the **Service Auth** action that includes the token, and Access sends
   sudo a JWT with no email whose `common_name` is the token's client id.
   sudo lets it in only if that client id is in `STAFF_SERVICE_TOKENS`
   (`<client id>=<name>`, comma separated, in `wrangler.jsonc`), after the
   same signature, audience, issuer and expiry checks, and records it as
   `<name>@service.g1t.sh`: `claude@service.g1t.sh` for
   `claude-sudo`. Its secret lives in `.credentials/sudo-service-token.json`
   and is used by `scripts/ops/sudo.mjs`, which sends sudo's own `Origin`
   with each POST so the same-origin check applies to it as to a browser.
   To take its access away, remove its entry here, or delete or revoke the
   token in Zero Trust.
3. **It fails closed.** Until `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and
   `STAFF_EMAILS` are all set, every request gets a 403 saying sudo is not
   configured.
4. **Changes** are POSTs only, and only from sudo's own pages (`Origin`, or
   `Referer`, must be `https://sudo.g1t.sh`). Terms, enterprise moves, new
   enterprises, Stripe billing links, invoice emails, invoices and the
   webhook show a confirmation step first; a credit needs the workspace's
   slug typed out.
5. **The pages run only sudo's own scripts.** Each page is rendered on the
   server and hydrated in the browser, as apps/web's are. Its content
   security policy names a nonce made for that page
   (`script-src 'self' 'nonce-…'`, `app/entry.server.tsx` and
   `app/lib/guard.ts`): sudo's files and the inline scripts React Router
   writes carrying the nonce run, and nothing else, no other site's and no
   other inline script; requests go only back to sudo; no inline style.
   Every other answer (data, redirects, files) forbids every script.
   Responses are `no-store`, `noindex` and cannot be framed. The worker has
   no `workers.dev` address or preview URLs.

## Setting up Access (once, in the Cloudflare dashboard)

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
   - Application name: `sudo`.
   - Session duration: short, such as 8 hours.
   - Public hostname: `sudo.g1t.sh` (path empty, so it covers everything).
2. **Add a policy** (`g1t staff`): action _Allow_, include _Emails_ → the
   owner's address, and _Emails ending in_ → `g1t.sh` for everyone with a
   g1t address (the same entries as `STAFF_EMAILS`, where a domain is
   written `@g1t.sh`). Add more staff here _and_ in `STAFF_EMAILS`; either
   one alone is not enough.
3. Save, then open the application's **Overview** (or _Basic information_)
   and copy the **Application Audience (AUD) tag**.
4. Find the **team domain** under **Zero Trust → Settings → Custom pages**
   (or _Team name and domain_): it looks like `<team>.cloudflareaccess.com`.
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
