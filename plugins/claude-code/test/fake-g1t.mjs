#!/usr/bin/env node
// A stand-in for the g1t CLI in the hook tests: writes each call to
// FAKE_G1T_LOG as a JSON line and answers as FAKE_G1T_* say.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_G1T_LOG, `${JSON.stringify({ args, session: process.env.G1T_SESSION ?? null })}\n`);
const exit = Number(process.env.FAKE_G1T_EXIT ?? 0);
if (exit) process.exit(exit);
if (args[0] === "session" && args[1] === "start") process.stdout.write(JSON.stringify({ id: "ses_fake01", state: "active" }));
if (args[0] === "work" && args[1] === "context") process.stdout.write(`#${args[2]} The issue's title\nDefinition of done: it works.\n`);
