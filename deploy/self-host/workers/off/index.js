// A service that is turned off on this installation.
//
// Self-hosted phase 1 runs the core forge only. The site and the services
// still hold bindings to the cloud runner and the deployments' builders;
// this Worker stands in for each of them: every method of the JSON protocol
// the services speak (`POST /rpc/<method>`) answers with a failed Result
// that says why, instead of failing.
//
// OFF_NAME names the feature in those messages, such as "Cloud runners".

import { WorkerEntrypoint } from "cloudflare:workers";

function off(env) {
  const name = env.OFF_NAME ?? "This feature";
  return {
    ok: false,
    error: { code: "forbidden", message: `${name} are off on this installation of g1t.` },
  };
}

export default class Off extends WorkerEntrypoint {
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
