import assert from "node:assert/strict";
import { test } from "node:test";

import { hasRelease, libraryPackages, packageLine, packagePath, publishGuide } from "./project-kind.ts";

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
