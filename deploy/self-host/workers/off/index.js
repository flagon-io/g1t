// A service that is turned off on this installation.
//
// Self-hosted phase 1 runs the core forge only. The site and the services
// still hold bindings to the runner (agents), the context hub and the
// deployments' builders; this Worker stands in for each of them, so a
// page that asks "are agents on here?" is told no instead of failing.
//
// - As the runner (RunnerApi in packages/contracts/src/runner.ts): agents
//   are not enabled, no model is reachable, and starting anything fails with
//   a message that says why.
// - For the JSON protocol the Rust services speak (`POST /rpc/<method>`):
//   every method answers with a failed Result.
//
// OFF_NAME names the feature in those messages, such as "Agents".

import { WorkerEntrypoint } from "cloudflare:workers";

function off(env) {
  const name = env.OFF_NAME ?? "This feature";
  return {
    ok: false,
    error: { code: "forbidden", message: `${name} are off on this installation of g1t.` },
  };
}

export default class Off extends WorkerEntrypoint {
  // ── The runner's methods, as the site calls them ──
  async enabled() {
    return false;
  }
  async modelAccess() {
    return { own: null, hosted: false, trial: null };
  }
  async instructions() {
    return off(this.env);
  }
  async run() {
    return off(this.env);
  }
  async plan() {
    return off(this.env);
  }
  async applyPlan() {
    return off(this.env);
  }
  async update() {
    return off(this.env);
  }
  async review() {
    return off(this.env);
  }
  async recheck() {
    return off(this.env);
  }
  async stopRun() {
    return off(this.env);
  }

  // ── The JSON protocol ──
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname.startsWith("/rpc/")) {
      return Response.json(off(this.env));
    }
    return new Response("Off on this installation.", { status: 404 });
  }

  // Events and schedules for a service that is off are dropped.
  async queue(batch) {
    batch.ackAll();
  }
  async scheduled() {}
}
