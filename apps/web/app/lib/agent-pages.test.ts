import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPage, developerResource, pageRepresentation } from "./agent-pages.ts";

test("developer discovery aliases point at the installation's machine endpoints", () => {
  const addresses = { api: "https://api.example", mcp: "https://mcp.example" };
  assert.equal(developerResource("/openapi.json", addresses), "https://api.example/openapi.json");
  assert.equal(developerResource("/mcp", addresses), "https://mcp.example");
  assert.equal(developerResource("/developers", addresses), "https://docs.g1t.sh/reference/developers/");
  assert.equal(developerResource("/private", addresses), null);
});

test("negotiation honors explicit types, quality, specificity, exclusions and browser defaults", () => {
  for (const accept of [null, "*/*", "text/html", "text/html,application/xhtml+xml,*/*;q=0.8", "text/markdown;q=0, */*;q=1", "text/html;q=1,text/markdown;q=0.5"])
    assert.equal(pageRepresentation(accept), "html", String(accept));
  for (const accept of ["text/markdown", "TEXT/MARKDOWN; charset=utf-8", "text/html;q=0.5,text/markdown;q=1", "text/markdown,*/*", "text/html;q=0,text/*"])
    assert.equal(pageRepresentation(accept), "markdown", accept);
  for (const accept of ["application/json", "text/html;q=0,text/markdown;q=0", "text/markdown;q=bad", "text/markdown;q=1.1"])
    assert.equal(pageRepresentation(accept), "none", accept);
});

test("homepage and genuine 404 documents have Markdown with the right status, discovery links and Vary", async () => {
  for (const [path, status] of [["/", 200], ["/__missing", 404]] as const) {
    const headers = new Headers({ vary: "Accept-Encoding", "content-type": "text/html" });
    const answer = agentPage(new Request(`https://g1t.sh${path}`, { headers: { accept: "text/markdown" } }), status, headers)!;
    assert.equal(answer.status, status);
    assert.match(answer.headers.get("content-type")!, /^text\/markdown/);
    assert.equal(answer.headers.get("vary"), "Accept-Encoding, Accept");
    const body = await answer.text();
    assert.ok(body.length > 20);
    assert.match(body, /\[.*\]\(https:\/\/g1t.sh\/llms.txt\)/);
    assert.doesNotMatch(body, /<!DOCTYPE|<html/i);
    const htmlHeaders = new Headers();
    assert.equal(agentPage(new Request(`https://g1t.sh${path}`, { headers: { accept: "text/html" } }), status, htmlHeaders), null);
    assert.equal(htmlHeaders.get("vary"), "Accept");
  }
});

test("HEAD, unsupported types, private refusals and writes preserve protocol boundaries", async () => {
  const head = agentPage(new Request("https://g1t.sh/", { method: "HEAD", headers: { accept: "text/markdown" } }), 200, new Headers())!;
  assert.equal(head.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(await head.text(), "");
  const json = agentPage(new Request("https://g1t.sh/", { headers: { accept: "application/json" } }), 200, new Headers())!;
  assert.equal(json.status, 406);
  for (const status of [301, 302, 401, 403, 500]) assert.equal(agentPage(new Request("https://g1t.sh/"), status, new Headers()), null);
  assert.equal(agentPage(new Request("https://g1t.sh/", { method: "POST" }), 404, new Headers()), null);
  assert.equal(agentPage(new Request("https://g1t.sh/private", { headers: { accept: "text/markdown" } }), 200, new Headers()), null);
});
