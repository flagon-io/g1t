import assert from "node:assert/strict";
import { test } from "node:test";
import { homebrewFormula } from "./cli-homebrew.mjs";

const manifest = () => ({ version: "1.2.3", files: Object.fromEntries(
  ["macos-arm64", "macos-x64", "linux-arm64", "linux-x64"].map((platform, i) =>
    [platform, { name: `g1t-${platform}`, sha256: String(i).repeat(64) }]),
) });

test("Homebrew pins all four platforms to versioned, checksummed downloads", () => {
  const m = manifest();
  const formula = homebrewFormula(m);
  for (const file of Object.values(m.files)) {
    assert.ok(formula.includes(`/1.2.3/${file.name}\", using: :nounzip`));
    assert.ok(formula.includes(`sha256 "${file.sha256}"`));
  }
  assert.ok(!formula.includes("/latest/"));
  assert.match(formula, /bin.install .* => "g1t"/);
  assert.match(formula, /g1t issue --help/);
});

test("reject incomplete manifests and unsafe Ruby interpolations", () => {
  for (const change of [
    (m) => { delete m.files["linux-x64"]; },
    (m) => { m.version = '1.2.3"'; },
    (m) => { m.files["macos-arm64"].name = "../g1t"; },
    (m) => { m.files["linux-arm64"].sha256 = '"'; },
  ]) {
    const m = manifest(); change(m);
    assert.throws(() => homebrewFormula(m));
  }
});
