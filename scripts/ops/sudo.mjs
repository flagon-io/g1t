#!/usr/bin/env node
// Uses sudo (https://sudo.g1t.sh) without a browser, through the Access
// service token in .credentials/sudo-service-token.json. sudo records it
// as claude@service.g1t.sh (apps/sudo/README.md, "Service tokens").
//
//   node scripts/ops/sudo.mjs get /costs
//   node scripts/ops/sudo.mjs post /costs intent=run
//   node scripts/ops/sudo.mjs get /users/g1t-reviewer --html
//
// Prints the status, where a redirect goes, and the page as text (or the
// raw HTML with --html). POSTs are form-encoded, the way sudo's pages send
// them, with sudo's own Origin. The secret is never printed.
import { readFileSync } from "node:fs";

const SUDO = "https://sudo.g1t.sh";
const CREDENTIALS = new URL("../../.credentials/sudo-service-token.json", import.meta.url);

/** The headers that get a request past Access. */
export function accessHeaders() {
  const { client_id, client_secret } = JSON.parse(readFileSync(CREDENTIALS, "utf8"));
  if (!client_id || !client_secret) throw new Error("sudo-service-token.json needs client_id and client_secret");
  return { "CF-Access-Client-Id": client_id, "CF-Access-Client-Secret": client_secret };
}

/** A page's readable text: no scripts, styles or tags, one line per block. */
export function pageText(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/summary)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** GETs or POSTs `path`; `fields` are the form's name=value pairs. */
export async function sudo(method, path, fields = []) {
  const headers = { ...accessHeaders() };
  let body;
  if (method === "POST") {
    headers.origin = SUDO;
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(fields.map((field) => field.split(/=(.*)/s).slice(0, 2))).toString();
  }
  const response = await fetch(new URL(path, SUDO), { method, headers, body, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location"), html: await response.text() };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/sudo.mjs")) {
  const [verb = "get", path = "/", ...rest] = process.argv.slice(2);
  const html = rest.includes("--html");
  const fields = rest.filter((arg) => arg !== "--html");
  const result = await sudo(verb.toUpperCase() === "POST" ? "POST" : "GET", path, fields);
  console.log(`${result.status}${result.location ? ` -> ${result.location}` : ""}`);
  if (result.location?.includes("cloudflareaccess.com")) {
    console.log("Access did not accept the service token: the sudo application needs a Service Auth policy that includes it.");
  } else {
    console.log(html ? result.html : pageText(result.html));
  }
}
