import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes, installCommands, shortDigest } from "./packages.ts";

test("sizes read as registries show them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(812), "812 B");
  assert.equal(formatBytes(12_340_000), "12.3 MB");
  assert.equal(formatBytes(1_400_000_000), "1.4 GB");
  assert.equal(formatBytes(250_000_000), "250 MB");
});

test("digests shorten for lists", () => {
  assert.equal(shortDigest("sha256:3f2a9c1b7d0e55aa"), "3f2a9c1b7d0e");
});

test("a container image is pulled by its address and tag", () => {
  const pkg = { ecosystem: "container" as const, address: "g1t.sh/acme/web", name: "web", workspace: "acme" };
  assert.deepEqual(installCommands(pkg, "latest", "ada"), {
    login: "docker login g1t.sh -u ada",
    install: "docker pull g1t.sh/acme/web:latest",
  });
  assert.equal(installCommands(pkg, null, "ada").install, "docker pull g1t.sh/acme/web");
});
