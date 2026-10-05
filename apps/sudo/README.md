# sudo

g1t's staff console, at <https://sudo.g1t.sh>. Staff use it to manage how
accounts pay: comp a workspace, set custom terms (a discount, a ceiling on
unpaid usage, an end date), create Enterprise accounts that pay for several
workspaces, move workspaces on and off them, issue credits, and see where
every account stands this month with its ledger and audit log.

It holds no data. Everything goes to the billing service's staff methods
(`admin_*`, see `BillingAdminApi` in `packages/contracts/src/billing.ts`),
and each change is recorded there with the staff member's email.

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
   `Referer`, must be `https://sudo.g1t.sh`). Terms, enterprise moves and new
   enterprises show a confirmation step first; a credit needs the workspace's
   slug typed out.
5. **The pages ship no JavaScript.** The content security policy forbids
   every script and inline style; responses are `no-store`, `noindex` and
   cannot be framed. The worker has no `workers.dev` address or preview URLs.

## Setting up Access (once, in the Cloudflare dashboard)

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
   - Application name: `sudo`.
   - Session duration: short, such as 8 hours.
   - Public hostname: `sudo.g1t.sh` (path empty, so it covers everything).
2. **Add a policy:** action *Allow*, include *Emails* → the owner's address
   (the same addresses as `STAFF_EMAILS`). Add more staff here *and* in
   `STAFF_EMAILS`; either one alone is not enough.
3. Save, then open the application's **Overview** (or *Basic information*)
   and copy the **Application Audience (AUD) tag**.
4. Find the **team domain** under **Zero Trust → Settings → Custom pages**
   (or *Team name and domain*): it looks like `<team>.cloudflareaccess.com`.
5. Put both into `wrangler.jsonc`:

   ```jsonc
   "vars": {
     "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
     "ACCESS_AUD": "<the AUD tag>",
     "STAFF_EMAILS": "syntaqx@gmail.com"
   }
   ```

6. Deploy: `scripts/deploy.sh sudo` (after `billing`, whose `admin_*`
   methods it calls).

Visit <https://sudo.g1t.sh>: Access asks you to sign in, then the accounts
list opens. Anyone else gets Access's own refusal; anyone Access lets in who
is not in `STAFF_EMAILS` gets a 403 from the worker.

## Working on it

```sh
npm run typecheck -w @g1t/sudo
npm test -w @g1t/sudo     # JWT verification, forms, money
npm run build -w @g1t/sudo
```

`npm run dev` serves the pages, but every request is refused without a real
Access token, by design.
