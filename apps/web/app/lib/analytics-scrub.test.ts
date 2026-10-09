import assert from "node:assert/strict";
import { test } from "node:test";

import { isPublicPath, scrubEvent, scrubPath, scrubUrl } from "./analytics-scrub.ts";

const ORIGIN = "https://g1t.sh";

test("the front door is sent as it is", () => {
  for (const path of ["/", "/pricing", "/explore", "/register", "/policies/privacy", "/pricing/"]) {
    assert.equal(isPublicPath(path), true, path);
    assert.equal(scrubPath(path), path);
  }
});

test("names in other addresses are replaced, and g1t's own words kept", () => {
  assert.equal(scrubPath("/acme/web/pull/12/files"), "/:name/:name/pull/:n/files");
  assert.equal(scrubPath("/acme/-/chat/secret-launch"), "/:name/-/chat/:name");
  assert.equal(scrubPath("/u/sam"), "/u/:name");
  assert.equal(scrubPath("/invite/abc123"), "/invite/:name");
  assert.equal(scrubPath("/acme/web/blob/main/src/keys.ts"), "/:name/:name/blob/:name/:name/:name");
});

test("a URL on the site keeps only campaign parameters; another site's is left alone", () => {
  assert.equal(scrubUrl("https://g1t.sh/reset?token=s3cret&utm_source=x", ORIGIN), "https://g1t.sh/reset?utm_source=x");
  assert.equal(scrubUrl("https://g1t.sh/search?q=private", ORIGIN), "https://g1t.sh/search");
  assert.equal(scrubUrl("https://g1t.sh/acme/web#L4", ORIGIN), "https://g1t.sh/:name/:name");
  assert.equal(scrubUrl("https://news.example/acme?x=1", ORIGIN), "https://news.example/acme?x=1");
});

test("a click inside the app goes without its text, link, attributes or title", () => {
  const event = scrubEvent(
    {
      event: "$autocapture",
      properties: {
        $current_url: "https://g1t.sh/acme/secret/issues/3",
        $pathname: "/acme/secret/issues/3",
        $title: "Rotate the prod key · acme/secret · g1t",
        $el_text: "Rotate the prod key",
        $elements_chain: 'a.link:text="Rotate the prod key"href="/acme/secret/issues/3"nth-child="1"attr__class="link"',
        $elements: [{ tag_name: "a", $el_text: "Rotate", href: "/acme/secret", attr__title: "x", nth_child: 1 }],
        $set_once: { $initial_current_url: "https://g1t.sh/acme/secret" },
      },
    },
    "/acme/secret/issues/3",
    ORIGIN,
  );
  assert.deepEqual(event?.properties, {
    $current_url: "https://g1t.sh/:name/:name/issues/:n",
    $pathname: "/:name/:name/issues/:n",
    $title: "g1t",
    $elements_chain: 'a.link:nth-child="1"',
    $elements: [{ tag_name: "a", nth_child: 1 }],
    $set_once: { $initial_current_url: "https://g1t.sh/:name/:name" },
  });
});

test("on the front door a click keeps its text", () => {
  const event = scrubEvent(
    { event: "$autocapture", properties: { $el_text: "Start for free", $title: "g1t · Your team", $pathname: "/" } },
    "/",
    ORIGIN,
  );
  assert.deepEqual(event?.properties, { $el_text: "Start for free", $title: "g1t · Your team", $pathname: "/" });
});

test("recordings and error reports are never sent, and heatmaps only from the front door", () => {
  assert.equal(scrubEvent({ event: "$snapshot", properties: {} }, "/", ORIGIN), null);
  assert.equal(scrubEvent({ event: "$exception", properties: {} }, "/", ORIGIN), null);
  assert.equal(scrubEvent({ event: "$$heatmap", properties: {} }, "/acme/web", ORIGIN), null);
  const heatmap = scrubEvent({ event: "$$heatmap", properties: { $heatmap_data: { "https://g1t.sh/pricing?ref=mail": [1] } } }, "/pricing", ORIGIN);
  assert.deepEqual(heatmap?.properties, { $heatmap_data: { "https://g1t.sh/pricing": [1] } });
});

test("pages after signing in keep their address but not their text, which can show an email address", () => {
  assert.equal(scrubPath("/confirm-email"), "/confirm-email");
  assert.equal(scrubPath("/login/two-factor"), "/login/two-factor");
  const event = scrubEvent({ event: "$autocapture", properties: { $el_text: "Resend to sam@example.com" } }, "/confirm-email", ORIGIN);
  assert.deepEqual(event?.properties, {});
});
