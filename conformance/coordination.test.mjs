import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startLocal } from "./coordination-local.mjs";
const exec = promisify(execFile);
const binary = resolve(`target/debug/g1t${process.platform === "win32" ? ".exe" : ""}`);
const built = ["apps/api/build/index.js", "services/work/build/index.js", binary].every(existsSync);
// A release check must not pass by skipping: G1T_REQUIRE_LOCAL_WORKERS=1 turns a missing build into a failure.
if (!built && process.env.G1T_REQUIRE_LOCAL_WORKERS === "1")
  throw new Error("Build API/Work Workers (node scripts/deploy.mjs build --only work,api) and the g1t CLI (cargo build -p g1t) first");

test(
  "real Workers: CLI and MCP share durable updates, receipts and ownership rules",
  { skip: !built && "Build API/Work Workers and the g1t CLI first", timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "g1t-local-coordination-"));
    let local;
    try {
      local = await startLocal({ port: 0, persist: dir });
      const rest = async (path, body, token = "local-rehearsal") => {
        const response = await fetch(`${local.url}/repos/tester/rehearsal/${path}`, {
          method: body ? "POST" : "GET",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        return result;
      };
      const mcp = async (args, token = "local-rehearsal") => {
        const response = await fetch(`${local.url}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session", arguments: { repo: "tester/rehearsal", ...args } } }),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        return JSON.parse(text).result;
      };
      const unwrap = (result) => {
        assert.equal(result.isError, false, JSON.stringify(result));
        return JSON.parse(result.content[0].text);
      };
      const a = await rest("sessions", { harness: "codex", harness_session_id: "codex-test" });
      const b = unwrap(await mcp({ action: "start", harness: "claude_code", harness_session_id: "claude-test" }));
      await rest(`sessions/${a.id}/entries`, {
        entries: [{ kind: "note", text: "Use fetchUser; implementation belongs to Codex", key: "plan" }],
        touched: [{ kind: "file", value: "src/contract.ts" }],
      });
      unwrap(
        await mcp({
          action: "record",
          id: b.id,
          entries: [{ kind: "note", text: "Claude owns caller tests", key: "plan" }],
          touched: [{ kind: "file", value: "src/contract.ts" }],
        }),
      );
      let detail = await rest(`sessions/${a.id}`);
      const overlap = detail.updates.find((u) => u.kind === "overlap.detected");
      assert.ok(overlap);
      const bOverlap = unwrap(await mcp({ action: "get", id: b.id })).updates.find((u) => u.kind === "overlap.detected");
      assert.ok(bOverlap);
      assert.notEqual(bOverlap.id, overlap.id);
      assert.ok(
        (await rest(`sessions/${a.id}`)).updates.some((u) => u.id === overlap.id),
        "reading never acknowledges",
      );
      const foreign = await mcp({ action: "record", id: a.id, acknowledge: [overlap.id] }, "local-other");
      assert.equal(foreign.isError, true, "another actor cannot acknowledge this session");
      // The same person's other session cannot clear it either, and is told so.
      const sibling = unwrap(await mcp({ action: "record", id: b.id, acknowledge: [overlap.id] }));
      assert.equal(sibling.acknowledged, 0, "an ID from another session is not counted");
      assert.ok(
        (await rest(`sessions/${a.id}`)).updates.some((u) => u.id === overlap.id),
        "a sibling session cannot clear this inbox",
      );
      const args = [
        "-R",
        "tester/rehearsal",
        "session",
        "acknowledge",
        overlap.id,
        "--session",
        a.id,
        "--note",
        "Separate scopes; agree the interface before editing",
        "--json",
      ];
      for (let n = 0; n < 2; n++)
        await exec(binary, args, { env: { ...process.env, G1T_TOKEN: "local-rehearsal", G1T_API_URL: local.url, G1T_SESSION: b.id }, windowsHide: true });
      detail = await rest(`sessions/${a.id}`);
      assert.ok(!detail.updates.some((u) => u.id === overlap.id));
      assert.equal(detail.entries.filter((e) => e.text.includes("Separate scopes;")).length, 1, "a retry records one decision");
      assert.ok(
        unwrap(await mcp({ action: "get", id: b.id })).updates.some((u) => u.id === bOverlap.id),
        "one harness cannot clear the other inbox",
      );
      await local.mf.dispose();
      local = await startLocal({ port: 0, persist: dir });
      assert.ok(!(await rest(`sessions/${a.id}`)).updates.some((u) => u.id === overlap.id), "receipt survives restart");
      assert.ok(
        unwrap(await mcp({ action: "get", id: b.id })).updates.some((u) => u.id === bOverlap.id),
        "pending update survives restart",
      );
      const resumed = await rest("sessions", { harness: "codex", harness_session_id: "codex-test" });
      assert.equal(resumed.id, a.id, "a restarted harness recovers its session");
      assert.equal(
        unwrap(await mcp({ action: "record", id: b.id, entries: [{ kind: "note", text: "Handoff considered", key: "ack" }], acknowledge: [bOverlap.id] }))
          .acknowledged,
        1,
      );
      assert.ok(!unwrap(await mcp({ action: "get", id: b.id })).updates.some((u) => u.id === bOverlap.id));
    } finally {
      if (local) await local.mf.dispose();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
