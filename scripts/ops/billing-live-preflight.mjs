// Read-only live configuration check. Never installs secrets or creates charges.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const key = readFileSync('.secrets/stripe-live-key.txt', 'utf8').trim();
const signingSecret = readFileSync('.secrets/stripe-live-webhook.txt', 'utf8').trim();
assert.ok(/^(sk|rk)_live_/.test(key), 'Expected a live API key');
assert.ok(/^whsec_\S+$/.test(signingSecret), 'Expected a webhook signing secret');
const source = readFileSync('services/billing/src/webhooks.rs', 'utf8');
const url = source.match(/WEBHOOK_URL: &str = "([^"]+)"/)[1];
const required = [...source.match(/const EVENTS: &\[&str\] = &\[([\s\S]*?)\];/)[1].matchAll(/"([a-z_.]+)"/g)].map(m => m[1]);
const version = readFileSync('services/billing/src/stripe.rs', 'utf8').match(/STRIPE_VERSION: &str = "([^"]+)"/)[1];
async function get(path) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': version },
  });
  if (!response.ok) throw Error(`Stripe read failed: HTTP ${response.status}`);
  return response.json();
}
const [account, tax] = await Promise.all([get('/account'), get('/tax/settings')]);
const endpoints = [];
let after;
do {
  const page = await get(`/webhook_endpoints?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
  endpoints.push(...page.data.filter(e => e.url === url));
  after = page.has_more ? page.data.at(-1)?.id : undefined;
  assert.ok(!page.has_more || after, 'Malformed endpoint pagination');
} while (after);
const matching = endpoints.map(e => ({
  id: e.id, url: e.url, status: e.status, live: e.livemode, apiVersion: e.api_version,
  missingEvents: e.enabled_events.includes('*') ? [] : required.filter(t => !e.enabled_events.includes(t)),
}));
const ready = account.charges_enabled && tax.status === 'active'
  && matching.some(e => e.live && e.status === 'enabled' && e.apiVersion === '2026-08-26.dahlia' && !e.missingEvents.length);
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(), account: account.id,
  chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled,
  taxStatus: tax.status, endpoints: matching, configurationReady: ready,
  signingSecretFilePresent: true,
  limitations: ['Stored signing secret cannot be matched to an existing endpoint through the read API',
    'Does not verify deployed secrets, delivery, application readiness, or settlement'],
}, null, 2));
if (!ready) process.exitCode = 1;
