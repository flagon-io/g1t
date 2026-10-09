#!/usr/bin/env node
// After a deploy: the ways in for someone new still work. The pages a
// visitor lands on load, and the waitlist's Request access form reaches
// identity and answers. It writes nothing: the form is sent an address
// identity refuses before it keeps or counts anything, so a real waitlist
// is never touched.
//
//   node scripts/ops/smoke.mjs                      # https://g1t.sh
//   node scripts/ops/smoke.mjs --site http://localhost:5173
//
// Exits 1 with what failed. The Deploy workflow runs it once every stage
// has deployed.

import { pathToFileURL } from "node:url";

/** The checks, in order. `body` is the page's text with tags removed. */
export const CHECKS = [
  { name: "Landing page", path: "/", expect: ["Sign up", "Start for free"] },
  { name: "Sign in", path: "/login", expect: ["Sign in"] },
  {
    name: "Sign up: invite and waitlist",
    path: "/register",
    expect: ["Have an invite?", "Request access"],
  },
  { name: "Pricing", path: "/pricing", expect: ["Pricing"] },
  {
    name: "Waitlist reaches identity",
    path: "/register",
    // Not an address, so identity answers "Enter a valid email address."
    // before its rate limit and before any write.
    form: { intent: "request-access", email: "smoke-test-not-an-address", about: "" },
    status: 422,
    expect: ["Enter a valid email address."],
  },
];

/** A page's visible text: scripts and styles dropped, tags removed, spaces collapsed. */
export function pageText(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** What is wrong with one answer, or null when it is as expected. */
export function verdict(check, status, html) {
  const want = check.status ?? 200;
  if (status !== want) return `answered ${status}, expected ${want}`;
  const text = pageText(html);
  const missing = check.expect.filter((phrase) => !text.includes(phrase));
  return missing.length ? `missing ${missing.map((m) => JSON.stringify(m)).join(", ")}` : null;
}

async function run(site) {
  const origin = new URL(site).origin;
  let failed = 0;
  for (const check of CHECKS) {
    const url = new URL(check.path, origin);
    const started = Date.now();
    let problem;
    try {
      const response = await fetch(url, {
        method: check.form ? "POST" : "GET",
        redirect: "manual",
        headers: {
          "user-agent": "g1t-smoke/1 (+https://g1t.sh)",
          ...(check.form ? { origin, "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        body: check.form ? new URLSearchParams(check.form).toString() : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      problem = verdict(check, response.status, await response.text());
    } catch (error) {
      problem = String(error?.message ?? error);
    }
    const took = `${Date.now() - started} ms`;
    if (problem) {
      failed += 1;
      console.log(`FAIL ${check.name} (${check.form ? "POST" : "GET"} ${url.pathname}): ${problem} · ${took}`);
    } else {
      console.log(`ok   ${check.name} · ${took}`);
    }
  }
  return failed;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}`) {
  const at = process.argv.indexOf("--site");
  const site = at > -1 ? process.argv[at + 1] : "https://g1t.sh";
  const failed = await run(site);
  if (failed) {
    console.log(`${failed} of ${CHECKS.length} checks failed on ${site}`);
    process.exit(1);
  }
}
