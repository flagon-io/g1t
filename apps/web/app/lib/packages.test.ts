import assert from "node:assert/strict";
import { test } from "node:test";

import { arrange, formatBytes, installCommands, shortCount, shortDigest } from "./packages.ts";

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

test("a crate is added after .cargo/config.toml names its workspace's registry, with cargo login for private ones", () => {
  const pkg = { ecosystem: "cargo" as const, address: "g1t.sh/-/cargo/acme/http-client", name: "http-client", workspace: "acme" };
  assert.deepEqual(installCommands(pkg, "0.3.1", "ada"), {
    registry:
      "mkdir -p .cargo && printf '[registries.acme]\\nindex = \"sparse+https://g1t.sh/-/cargo/acme/index/\"\\ncredential-provider = \"cargo:token\"\\n' >> .cargo/config.toml",
    login: "cargo login --registry acme",
    install: "cargo add http-client@0.3.1 --registry acme",
  });
  assert.equal(installCommands(pkg, null, "ada").install, "cargo add http-client --registry acme");
});

test("a container image is pulled by its address and tag", () => {
  const pkg = { ecosystem: "container" as const, address: "g1t.sh/acme/web", name: "web", workspace: "acme" };
  assert.deepEqual(installCommands(pkg, "latest", "ada"), {
    login: "docker login g1t.sh -u ada",
    install: "docker pull g1t.sh/acme/web:latest",
  });
  assert.equal(installCommands(pkg, null, "ada").install, "docker pull g1t.sh/acme/web");
});

test("packages are listed by the visibility and order asked for", () => {
  const list = [
    { name: "web", visibility: "private" as const, updated_at: "2026-10-01T00:00:00Z", downloads: 5 },
    { name: "api", visibility: "public" as const, updated_at: "2026-10-03T00:00:00Z", downloads: 9 },
    { name: "cli", visibility: "public" as const, updated_at: "2026-10-02T00:00:00Z", downloads: 9 },
  ];
  assert.deepEqual(arrange(list, "all", "updated").map((p) => p.name), ["api", "cli", "web"]);
  assert.deepEqual(arrange(list, "all", "downloads").map((p) => p.name), ["api", "cli", "web"]);
  assert.deepEqual(arrange(list, "all", "name").map((p) => p.name), ["api", "cli", "web"]);
  assert.deepEqual(arrange(list, "private", "updated").map((p) => p.name), ["web"]);
  assert.deepEqual(arrange(list, "public", "name").map((p) => p.name), ["api", "cli"]);
});

test("download counts read short", () => {
  assert.equal(shortCount(940), "940");
  assert.equal(shortCount(16_100), "16.1k");
  assert.equal(shortCount(2_000_000), "2M");
});
