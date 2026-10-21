// Pays a Stripe sandbox Checkout page in headless Chrome, for
// billing-sandbox.mjs's prepay phase: a test card that always asks for 3DS,
// a Seattle billing address (Washington taxes g1t's product; Colorado does
// not), then the test 3DS challenge. Screenshots of each step go to the
// shots folder. Refuses anything but a sandbox page.
//
//   node scripts/ops/billing-sandbox-pay.mjs <url> [shots folder]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [url, shots = "target/billing-audit/prepay-shots"] = process.argv.slice(2);
if (!/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/.test(url)) throw Error("Expected a sandbox Checkout URL");
mkdirSync(shots, { recursive: true });
const port = 9333;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(shots, "profile")}`,
    "--window-size=1280,1100",
    "--disable-site-isolation-trials",
    "--disable-features=IsolateOrigins,site-per-process",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${port}/json`)
    .then((r) => r.json())
    .then((t) => t.find((x) => x.type === "page"))
    .catch(() => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (msg) => (msg.error ? reject(Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
let shot = 0;
const snap = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(shots, `${++shot}-${name}.png`), Buffer.from(data, "base64"));
};
const frames = async () => {
  const out = [];
  const walk = (node) => {
    out.push(node.frame.id);
    (node.childFrames ?? []).forEach(walk);
  };
  walk((await send("Page.getFrameTree")).frameTree);
  return out;
};
// Runs `fn` (source) in every frame; returns the first truthy result.
const inFrames = async (fn) => {
  for (const frameId of await frames()) {
    try {
      const { executionContextId } = await send("Page.createIsolatedWorld", { frameId, worldName: "pay" });
      const { result } = await send("Runtime.evaluate", { expression: `(${fn})()`, contextId: executionContextId, returnByValue: true });
      if (result.value) return result.value;
    } catch {}
  }
  return null;
};
const type = async (selector, text) => {
  const found = await inFrames(
    `() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.value) return false; el.focus(); return true; }`,
  );
  if (found) await send("Input.insertText", { text });
  return found;
};

let done = false;
try {
  await send("Page.enable");
  await send("Page.navigate", { url });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await inFrames(`() => !!document.querySelector('#cardNumber')`)) break;
  }
  await sleep(1000);
  await snap("page");
  await inFrames(
    `() => { const a = [...document.querySelectorAll('button, a, span')].find((x) => x.textContent.trim() === 'Enter address manually'); if (!a) return false; a.click(); return true; }`,
  );
  await sleep(800);
  await type("#email", "prepay-audit@example.com");
  await type("#cardNumber", "4000002760003184");
  await type("#cardExpiry", "1234");
  await type("#cardCvc", "123");
  await type("#billingName", "Prepay Audit");
  await type("#billingAddressLine1", "1301 2nd Ave");
  await type("#billingLocality", "Seattle");
  await type("#billingPostalCode", "98101");
  await inFrames(
    `() => { const s = document.querySelector('#billingAdministrativeArea'); if (!s || s.value) return false; s.value = 'WA'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }`,
  );
  await sleep(1500);
  // Link's "save my information" is ticked by default and wants a phone.
  await inFrames(
    `() => { const c = document.querySelector('#enableStripePass') || [...document.querySelectorAll('input[type=checkbox]')].find((x) => /Link/.test(x.closest('label')?.textContent ?? x.parentElement?.parentElement?.textContent ?? '')); if (!c || !c.checked) return false; c.click(); return true; }`,
  );
  await sleep(1500);
  await snap("filled");
  const submitted = await inFrames(
    `() => { const b = document.querySelector('[data-testid="hosted-payment-submit-button"], .SubmitButton'); if (!b) return false; b.click(); return true; }`,
  );
  if (!submitted) throw Error("No submit button");
  for (let i = 0; i < 60 && !done; i++) {
    await sleep(2000);
    const clicked = await inFrames(
      `() => { const b = document.querySelector('#test-source-authorize-3ds') || [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Complete'); if (!b) return false; b.click(); return 'clicked'; }`,
    );
    if (clicked) {
      await snap("3ds");
      console.log("3DS challenge completed");
    }
    const { result } = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    if (result.value.startsWith("http://127.0.0.1")) done = true;
  }
  await snap("after");
  console.log(done ? "Returned to the success URL" : "Did not reach the success URL; see screenshots");
} finally {
  ws.close();
  chrome.kill();
}
process.exit(done ? 0 : 1);
