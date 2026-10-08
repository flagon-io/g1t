import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KIND_CHOICES,
  KIND_CHOICE_SETS,
  bare,
  choiceOf,
  hasRelease,
  kindLabel,
  latestTag,
  libraryPackages,
  neverDeploys,
  primaryLink,
  projectChanges,
  linksFromForm,
  linksToShow,
  packageLine,
  packagePath,
  publishGuide,
} from "./project-kind.ts";

const pkg = (over: Record<string, unknown>) => ({
  ecosystem: "composer" as const,
  name: "psr/log",
  workspace: "flagon-io",
  latest: "3.0.2",
  versions: 3,
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

test("a package reads as its registry, its name and its latest version", () => {
  assert.equal(packageLine(pkg({})), "Composer · psr/log 3.0.2");
  assert.equal(packageLine(pkg({ ecosystem: "npm", name: "ui", latest: null })), "npm · @flagon-io/ui");
  assert.equal(packagePath(pkg({})), "/flagon-io/-/packages/composer/psr/log");
});

test("what a library publishes comes before an image, released ones first", () => {
  const list = [
    pkg({ ecosystem: "container", name: "img", updated_at: "2026-10-05T00:00:00Z" }),
    pkg({ name: "empty", versions: 0, updated_at: "2026-10-04T00:00:00Z" }),
    pkg({}),
  ];
  assert.deepEqual(libraryPackages(list).map((p) => p.name), ["psr/log", "empty", "img"]);
  assert.equal(hasRelease(list), true);
  assert.equal(hasRelease([pkg({ versions: 0 })]), false);
  assert.equal(hasRelease([]), false);
});

test("each ecosystem links to how it publishes", () => {
  assert.equal(publishGuide("composer")?.guide, "https://docs.g1t.sh/guides/composer/");
  assert.equal(publishGuide("composer")?.start, "git tag v1.0.0 && git push --tags");
  assert.equal(publishGuide("npm")?.start, "npm publish");
  assert.equal(publishGuide("go")?.guide, "https://docs.g1t.sh/guides/go/");
  assert.equal(publishGuide("python")?.guide, "https://docs.g1t.sh/guides/packages/");
  assert.equal(publishGuide(null), null);
});

test("each choice sets a kind and where it runs, and reads back", () => {
  for (const choice of KIND_CHOICES) {
    const set = KIND_CHOICE_SETS[choice.value];
    const setting = { kind: set.kind === "auto" ? null : set.kind, runs: set.runs === "auto" ? null : set.runs };
    assert.equal(choiceOf(setting), choice.value);
  }
  // Set through the API to an app, with where it runs left open: no choice says that.
  assert.equal(choiceOf({ kind: "app", runs: null }), null);
});

test("a project's badge says what it is and where it runs", () => {
  assert.equal(kindLabel({ kind: "app", runs: "elsewhere" }), "App, deployed elsewhere");
  assert.equal(kindLabel({ kind: "app", runs: "g1t" }), "App on g1t");
  assert.equal(kindLabel({ kind: "app", runs: null }), "App");
  assert.equal(kindLabel({ kind: "tool", runs: null }), "Tool");
  assert.equal(kindLabel({ kind: "other", runs: null }), "Project");
});

test("links show homepage, docs, then the rest, never twice", () => {
  const links = {
    homepage: "https://g1t.sh/",
    homepageInherited: false,
    docs: "https://docs.g1t.sh",
    custom: [
      { label: "Status", url: "https://status.g1t.sh" },
      { label: "Docs again", url: "http://docs.g1t.sh/" },
    ],
  };
  assert.deepEqual(
    linksToShow(links).map((link) => [link.type, link.label]),
    [
      ["homepage", "g1t.sh"],
      ["docs", "Docs"],
      ["custom", "Status"],
    ],
  );
  // Production's address already shows on the page: the homepage pointing there is left out.
  assert.deepEqual(linksToShow(links, ["https://g1t.sh"]).map((link) => link.type), ["docs", "custom"]);
  assert.equal(bare("https://g1t.sh/docs/"), "g1t.sh/docs");
});

test("an overview form changes only what it carries", () => {
  const kind = new FormData();
  kind.set("choice", "elsewhere");
  kind.set("productionUrl", "g1t.sh");
  assert.deepEqual(projectChanges(kind), { kind: "app", runs: "elsewhere", productionUrl: "g1t.sh" });
  const about = new FormData();
  about.set("description", "");
  about.set("homepage", "https://g1t.sh");
  about.set("links", "rows");
  // Every row removed: the list is cleared, not left as it was.
  assert.deepEqual(projectChanges(about), { description: "", homepage: "https://g1t.sh", links: [] });
  const bogus = new FormData();
  bogus.set("choice", "sometimes");
  assert.deepEqual(projectChanges(bogus), {});
});

test("the latest release is the newest tag by its commit", () => {
  assert.deepEqual(
    latestTag([
      { name: "v1.0.0", commit: { authoredAt: "2026-09-01T00:00:00Z" } },
      { name: "v1.1.0", commit: { authoredAt: "2026-10-01T00:00:00Z" } },
      { name: "nightly", commit: null },
    ]),
    { name: "v1.1.0", at: "2026-10-01T00:00:00Z" },
  );
  assert.equal(latestTag([]), null);
});

test("cards show production, else the homepage or docs", () => {
  const links = { homepage: "https://acme.dev", homepageInherited: false, docs: "https://docs.acme.dev", custom: [] };
  assert.equal(primaryLink({ runs: "g1t", productionUrl: null, links }, "https://web-acme.g1t.page"), "https://web-acme.g1t.page");
  assert.equal(primaryLink({ runs: "elsewhere", productionUrl: "https://app.acme.dev", links }, null), "https://app.acme.dev");
  assert.equal(primaryLink({ runs: null, productionUrl: null, links }, null), "https://acme.dev");
  assert.equal(primaryLink({ runs: null, productionUrl: null, links: { ...links, homepage: null } }, null), "https://docs.acme.dev");
  assert.equal(neverDeploys({ setting: { kind: "tool", runs: null } }), true);
  assert.equal(neverDeploys({ setting: { kind: "docs", runs: null } }), false);
});

test("custom links are read from a form's rows, blank rows left out", () => {
  const form = new FormData();
  for (const [label, url] of [["Status", "status.g1t.sh"], ["", ""], ["", "npmjs.com/x"]]) {
    form.append("linkLabel", label!);
    form.append("linkUrl", url!);
  }
  assert.deepEqual(linksFromForm(form), [
    { label: "Status", url: "status.g1t.sh" },
    { label: "", url: "npmjs.com/x" },
  ]);
});
