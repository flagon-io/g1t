// What a job looks like from inside, by shape, for comparing a run on
// GitHub with the same run on g1t (scripts/conformance-diff.mjs). Values
// that differ between hosts by nature (ids, times, hosts, paths) are kept
// as their shape: which variables are set, which keys the event and the
// contexts have and of what JSON type, and how paths sit relative to one
// another. Run by .g1t/workflows/conformance.yml and its copy in
// .github/workflows/; see CONTRIBUTING.md.
//
//   node conformance/report.mjs <out.json>
// with CTX_<NAME> set to toJSON of each context to compare by shape
// (github, runner, job, strategy, matrix, steps, needs), and CHECK_<name>
// to each value the steps and expressions should give alike everywhere.

import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

/** A JSON value's shape: every key path with its type, arrays by their first item. */
export function shape(value, prefix = "", into = {}) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (prefix) into[prefix] = type;
  if (type === "object") {
    for (const [key, inner] of Object.entries(value)) shape(inner, prefix ? `${prefix}.${key}` : key, into);
  } else if (type === "array" && value.length > 0) {
    shape(value[0], `${prefix}[]`, into);
  }
  return into;
}

/** What kind of text a variable holds, without its value. */
export function kind(text) {
  if (text === "") return "empty";
  if (/^(true|false)$/.test(text)) return "boolean";
  if (/^\d+$/.test(text)) return "integer";
  if (/^[0-9a-f]{40}$/.test(text)) return "sha";
  if (/^https?:\/\//.test(text)) return "url";
  if (/^(\/|[A-Za-z]:\\)/.test(text)) return "path";
  if (/^refs\//.test(text)) return "ref";
  return "text";
}

/** The variables GitHub's runner sets, by kind; others are left out. */
export function variables(env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^(GITHUB_|RUNNER_|ACTIONS_)/.test(name) && !name.startsWith("CTX_") || ["CI", "ImageOS", "ImageVersion", "HOME"].includes(name)) {
      out[name] = kind(value ?? "");
    }
  }
  return out;
}

/** How the job's folders sit relative to one another. */
export function layout(env) {
  const at = (name) => env[name] ?? "";
  return {
    workspace_under_runner_workspace: at("GITHUB_WORKSPACE") !== "" && !relative(at("RUNNER_WORKSPACE"), at("GITHUB_WORKSPACE")).startsWith(".."),
    workspace_is_repo_twice: (() => {
      const parts = at("GITHUB_WORKSPACE").split(/[\\/]/).filter(Boolean);
      return parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2];
    })(),
    temp_under_runner: at("RUNNER_TEMP") !== "" && at("RUNNER_TEMP").includes("runner"),
    event_file_exists: (() => {
      try {
        readFileSync(at("GITHUB_EVENT_PATH"));
        return true;
      } catch {
        return false;
      }
    })(),
  };
}

/** The variables starting with `prefix`, by the rest of their names, lowercased. */
function prefixed(env, prefix) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, value]) => [name.slice(prefix.length).toLowerCase(), value ?? ""]),
  );
}

export function report(env) {
  const contexts = Object.fromEntries(
    Object.entries(prefixed(env, "CTX_")).map(([name, text]) => {
      try {
        return [name, JSON.parse(text)];
      } catch {
        return [name, text];
      }
    }),
  );
  const event = (() => {
    try {
      return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    } catch {
      return null;
    }
  })();
  return {
    variables: variables(env),
    layout: layout(env),
    contexts: Object.fromEntries(Object.entries(contexts).map(([name, value]) => [name, shape(value)])),
    event: event ? shape(event) : null,
    // What earlier steps saw, compared by value: these should be the same everywhere.
    checks: prefixed(env, "CHECK_"),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const out = process.argv[2] ?? "conformance.json";
  writeFileSync(out, `${JSON.stringify(report(process.env), null, 2)}\n`);
  console.log(`Wrote ${out}`);
}
