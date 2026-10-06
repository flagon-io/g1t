import assert from "node:assert/strict";
import { test } from "node:test";

import { readableSurroundings } from "./surroundings.ts";

const projects = [
  {
    slug: "web",
    name: "Web",
    dependencies: {
      dependsOn: [
        { slug: "api", as: "API_URL" },
        { slug: "billing", as: null },
      ],
      usedBy: [{ slug: "Admin", as: null }],
    },
  },
];

test("someone who reads every repository is told of every project around it", () => {
  assert.deepEqual(readableSurroundings(projects, null), projects);
});

test("anyone else is told only of the projects they can read", () => {
  const [web] = readableSurroundings(projects, new Set(["web", "api", "admin"]));
  assert.deepEqual(web.dependencies.dependsOn.map((d) => d.slug), ["api"], "billing is not named");
  assert.deepEqual(web.dependencies.usedBy.map((d) => d.slug), ["Admin"]);
  assert.deepEqual(readableSurroundings(projects, new Set())[0].dependencies, { dependsOn: [], usedBy: [] });
});
