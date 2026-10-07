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

test("an npm package is installed after .npmrc names its scope's registry, and a token for private ones", () => {
  const pkg = { ecosystem: "npm" as const, address: "g1t.sh/-/npm/@acme/ui", name: "ui", workspace: "acme" };
  assert.deepEqual(installCommands(pkg, "1.2.0", "ada"), {
    registry: "npm config set @acme:registry=https://g1t.sh/-/npm/",
    login: "npm config set //g1t.sh/-/npm/:_authToken=YOUR_TOKEN",
    install: "npm install @acme/ui@1.2.0",
  });
  assert.equal(installCommands(pkg, null, "ada").install, "npm install @acme/ui");
});

test("a Composer package is required after its workspace's repository is added, with credentials for private ones", () => {
  const pkg = { ecosystem: "composer" as const, address: "g1t.sh/-/composer/acme/acme/lib", name: "acme/lib", workspace: "acme" };
  assert.deepEqual(installCommands(pkg, "v1.1.0", "ada"), {
    registry: "composer config repositories.acme composer https://g1t.sh/-/composer/acme/",
    login: "composer config --global --auth http-basic.g1t.sh ada YOUR_TOKEN",
    install: "composer require acme/lib:v1.1.0",
  });
});

test("a container image is pulled by its address and tag", () => {
  const pkg = { ecosystem: "container" as const, address: "g1t.sh/acme/web", name: "web", workspace: "acme" };
  assert.deepEqual(installCommands(pkg, "latest", "ada"), {
    login: "docker login g1t.sh -u ada",
    install: "docker pull g1t.sh/acme/web:latest",
  });
  assert.equal(installCommands(pkg, null, "ada").install, "docker pull g1t.sh/acme/web");
});
