#!/usr/bin/env node
// A stand-in for the g1t CLI in the hook tests: writes each call to
// FAKE_G1T_LOG as a JSON line and answers as FAKE_G1T_* say.
//
// It is as strict as the real CLI, or stricter: a call that is not in
// cli-contract.json (a command, a flag, a value, a missing argument) is
// refused with exit code 2, as the real CLI refuses what its parser does
// not take. crates/g1t's tests parse everything in cli-contract.json with
// the real parser, so what this accepts, the real CLI accepts too.
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT = JSON.parse(readFileSync(new URL("./cli-contract.json", import.meta.url), "utf8"));

/** Why the real CLI would refuse `args`, or null when it takes them. */
export function refusal(args, contract = CONTRACT) {
  const command = contract.commands
    .filter((c) => c.command.every((word, i) => args[i] === word))
    .sort((a, b) => b.command.length - a.command.length)[0];
  if (!command || args.length === 0) return `not a command: ${args.join(" ")}`;
  const name = command.command.join(" ") || "g1t";
  const rest = args.slice(command.command.length);
  const seen = new Map();
  const positionals = [];
  const check = (flag, type, value) => {
    if (Array.isArray(type) && !type.includes(value)) return `${flag} takes ${type.join(", ")}, not ${value}`;
    if (type === "number" && !/^\d+$/.test(value)) return `${flag} takes a number, not ${value}`;
    return null;
  };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--" && command.dash_dash) {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (token.startsWith("-") && token !== "-") {
      // --flag=value: the value is taken as it is, even one that starts with a dash.
      const eq = token.startsWith("--") ? token.indexOf("=") : -1;
      const flag = eq > 0 ? token.slice(0, eq) : token;
      const type = command.flags[flag];
      if (type === undefined) return `${name} takes no ${flag}`;
      if (seen.has(flag) && !(command.repeatable ?? []).includes(flag)) return `${flag} given twice`;
      let value = null;
      if (eq > 0) {
        if (type === "switch") return `${flag} takes no value`;
        value = token.slice(eq + 1);
      } else if (type === "json") {
        if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("-")) value = rest[++i];
      } else if (type !== "switch") {
        value = rest[++i];
        if (value === undefined) return `${flag} needs a value`;
        // As clap does: a value after a space may not look like a flag.
        if (value.startsWith("-") && value !== "-") return `unexpected argument '${value}' found (use ${flag}=VALUE)`;
      }
      if (value !== null && type !== "json") {
        const wrong = check(flag, type, value);
        if (wrong) return wrong;
      }
      seen.set(flag, value);
      continue;
    }
    positionals.push(token);
  }
  const want = command.positionals ?? [];
  if (positionals.length !== want.length) return `${name} takes ${want.length} argument(s), given ${positionals.length}`;
  for (const [i, kind] of want.entries()) {
    const wrong = check("an argument", kind, positionals[i]);
    if (wrong) return wrong;
  }
  for (const flag of command.required ?? []) if (!seen.has(flag)) return `${name} needs ${flag}`;
  if (command.one_of && !command.one_of.some((flag) => seen.has(flag))) return `${name} needs one of ${command.one_of.join(", ")}`;
  return null;
}

function main() {
  const args = process.argv.slice(2);
  appendFileSync(process.env.FAKE_G1T_LOG, `${JSON.stringify({ args, session: process.env.G1T_SESSION ?? null })}\n`);
  const refused = refusal(args);
  if (refused) {
    process.stderr.write(`g1t: ${refused} See --help.\n`);
    process.exit(2);
  }
  if (args[0] === "--version") {
    process.stdout.write(`g1t ${process.env.FAKE_G1T_VERSION ?? CONTRACT.minimum_version}\n`);
    process.exit(0);
  }
  if (args[0] === "api" && args[1] === "get_session" && process.env.FAKE_G1T_UPDATES) {
    process.stdout.write(JSON.stringify({ updates: JSON.parse(process.env.FAKE_G1T_UPDATES) }));
  }
  const exit = Number(process.env.FAKE_G1T_EXIT ?? 0);
  if (exit) process.exit(exit);
  if (args[0] === "session" && args[1] === "start") {
    // A subagent's session has an id of its own, from its harness id.
    const harness = args.find((a) => a.startsWith("--harness-session-id="))?.split("=")[1] ?? args[args.indexOf("--harness-session-id") + 1] ?? "";
    const id = args.some((a) => a === "--parent" || a.startsWith("--parent=")) ? `ses_sub_${harness.split("/agent/")[1]}` : "ses_fake01";
    process.stdout.write(JSON.stringify({ id, state: "active" }));
  }
  // The session as it stands: titled when FAKE_G1T_TITLE says so.
  if (args[0] === "session" && args[1] === "heartbeat" && args.includes("--json")) {
    process.stdout.write(JSON.stringify({ id: process.env.G1T_SESSION, state: "active", title: process.env.FAKE_G1T_TITLE || null }));
  }
  if (args[0] === "work" && args[1] === "context") process.stdout.write(`#${args[2]} The issue's title\nDefinition of done: it works.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
