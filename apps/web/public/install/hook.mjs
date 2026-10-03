#!/usr/bin/env node
// g1t's Claude Code hook: records what your agent does onto the pull
// request you are working on, so its session sits beside the code.
//
// Claude Code runs this for UserPromptSubmit, PostToolUse and Stop, with
// the event as JSON on stdin. It works out the pull request from the
// working copy's git remote: a g1t fork (g1t.sh/pulls/<id>) or a branch
// of a g1t repository with an open pull request. Anywhere else it does
// nothing. It never fails the agent's turn.
//
// Installed by `curl -fsSL https://g1t.sh/install/claude.sh | sh`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = join(homedir(), ".g1t");
const CONFIG = join(HOME, "config.json");
const CACHE = join(HOME, "pulls.json");
/** The longest any one entry is sent. */
const MAX_TEXT = 4000;

function read(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function git(cwd, ...args) {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

function clip(text) {
  const value = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

/** What a tool call did, in one line where possible. */
function describeCall(name, input = {}) {
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.pattern) return `${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
  if (input.url) return input.url;
  return clip(input);
}

/** The pull request this working copy belongs to, if any. Cached per copy. */
async function pullFor(cwd, config) {
  const remote = git(cwd, "remote", "get-url", "origin");
  const branch = git(cwd, "branch", "--show-current");
  if (!remote.includes("g1t.sh/")) return null;
  const key = `${remote}#${branch}`;
  const cache = read(CACHE, {});
  if (key in cache) return cache[key];
  const headers = { authorization: `Bearer ${config.token}` };
  let found = null;
  const fork = /g1t\.sh\/pulls\/([a-z0-9_]+?)(?:\.git)?$/.exec(remote);
  const repo = /g1t\.sh\/([a-z0-9-]+)\/([a-z0-9._-]+?)(?:\.git)?$/i.exec(remote);
  if (fork) {
    const response = await fetch(`${config.api}/pulls/${fork[1]}`, { headers });
    if (response.ok) {
      const pull = await response.json();
      found = { repo: `${pull.repo.namespace}/${pull.repo.name}`, number: pull.number };
    }
  } else if (repo && branch) {
    const response = await fetch(`${config.api}/repos/${repo[1]}/${repo[2]}/pulls?state=open`, { headers });
    if (response.ok) {
      const pulls = await response.json();
      const pull = (Array.isArray(pulls) ? pulls : []).find((p) => p.branch === branch);
      if (pull) found = { repo: `${repo[1]}/${repo[2]}`, number: pull.number };
    }
  }
  cache[key] = found;
  try {
    writeFileSync(CACHE, JSON.stringify(cache));
  } catch {}
  return found;
}

/** The agent's last words this turn, from its transcript. */
function lastMessage(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const lines = readFileSync(transcriptPath, "utf8").trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;
      const content = entry.message?.content;
      const text = Array.isArray(content)
        ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
        : typeof content === "string"
          ? content
          : "";
      if (text.trim()) return text.trim();
    } catch {}
  }
  return null;
}

async function main() {
  const config = read(CONFIG, null);
  if (!config?.token) return;
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw || "{}");
  const pull = await pullFor(event.cwd ?? process.cwd(), config);
  if (!pull) return;

  const entries = [];
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      if (event.prompt) entries.push({ kind: "prompt", text: clip(event.prompt) });
      break;
    case "PostToolUse":
      entries.push({ kind: "tool_call", tool: event.tool_name, text: clip(describeCall(event.tool_name, event.tool_input)) });
      if (event.tool_response != null) {
        entries.push({ kind: "tool_result", tool: "result", text: clip(event.tool_response) });
      }
      break;
    case "Stop": {
      const message = lastMessage(event.transcript_path);
      if (message) entries.push({ kind: "message", text: clip(message) });
      break;
    }
  }
  if (entries.length === 0) return;
  await fetch(`${config.api}/repos/${pull.repo}/pulls/${pull.number}/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
