#!/usr/bin/env node
// Sets up g1t for Claude Code on this machine: signs in through the
// browser (nothing to paste), keeps the token in ~/.g1t, and adds g1t's
// hook to ~/.claude/settings.json so sessions are recorded onto the pull
// requests they belong to. Run by https://g1t.sh/install/claude.sh.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = process.env.G1T_API ?? "https://api.g1t.sh";
const HOME = join(homedir(), ".g1t");
const CONFIG = join(HOME, "config.json");
const SETTINGS = join(homedir(), ".claude", "settings.json");
const HOOK = `node "${join(HOME, "hook.mjs")}"`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function signIn() {
  if (existsSync(CONFIG)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG, "utf8"));
      const me = await fetch(`${API}/user`, { headers: { authorization: `Bearer ${config.token}` } });
      if (me.ok) {
        console.log(`Already signed in as ${(await me.json()).username}.`);
        return;
      }
    } catch {}
  }
  const started = await (
    await fetch(`${API}/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Code on this machine" }),
    })
  ).json();
  console.log(`\nOpen ${started.verification_uri_complete}`);
  console.log(`and check that the code there is ${started.user_code}.\n`);
  const deadline = Date.now() + started.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.max(started.interval, 2) * 1000);
    const claim = await (
      await fetch(`${API}/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: started.device_code }),
      })
    ).json();
    if (claim.status === "approved") {
      mkdirSync(HOME, { recursive: true });
      writeFileSync(CONFIG, JSON.stringify({ api: API, token: claim.token }, null, 2));
      try {
        chmodSync(CONFIG, 0o600);
      } catch {}
      console.log(`Signed in as ${claim.username}.`);
      return;
    }
    if (claim.status === "denied" || claim.status === "expired") {
      throw new Error(`Sign-in was ${claim.status}.`);
    }
  }
  throw new Error("Sign-in timed out.");
}

/** Adds g1t's hook to Claude Code's settings, keeping everything else. */
function addHooks() {
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {}
  settings.hooks ??= {};
  for (const [event, matcher] of [
    ["UserPromptSubmit", undefined],
    ["PostToolUse", "*"],
    ["Stop", undefined],
  ]) {
    const groups = (settings.hooks[event] ??= []);
    const present = groups.some((group) => group.hooks?.some((hook) => hook.command === HOOK));
    if (!present) {
      groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: HOOK, timeout: 10 }] });
    }
  }
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  console.log(`Added g1t's hook to ${SETTINGS}.`);
}

try {
  await signIn();
  addHooks();
  console.log("\nDone. Sessions in a g1t pull request's working copy are now recorded onto it.");
  console.log("To give Claude Code g1t's tools as well, run:");
  console.log("  claude mcp add --transport http g1t https://mcp.g1t.sh\n");
} catch (error) {
  console.error(`g1t: ${error.message}`);
  process.exit(1);
}
