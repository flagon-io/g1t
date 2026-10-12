import assert from "node:assert/strict";
import test from "node:test";

import { observabilityMetadata, resourceAttributes, telemetryTags, withOtel } from "./telemetry.ts";

const app = { project: "prj_1", deployment: "dpl_1", environment: "production", service: "web", commit: "abc123" };

test("an app's OpenTelemetry variables point at the project, unless it set its own", () => {
  const given = withOtel({ secrets: {}, variables: { FROM: "config" } }, app, "g1to_prj_1_secret");
  assert.equal(given.variables.OTEL_EXPORTER_OTLP_ENDPOINT, "https://otel.g1t.sh");
  assert.equal(given.variables.OTEL_SERVICE_NAME, "web");
  assert.equal(given.secrets.OTEL_EXPORTER_OTLP_HEADERS, "authorization=Bearer g1to_prj_1_secret");
  assert.match(given.variables.OTEL_RESOURCE_ATTRIBUTES, /g1t\.deployment\.id=dpl_1/);
  assert.equal(given.variables.FROM, "config");
  // The project's own endpoint wins, whole.
  const own = { secrets: {}, variables: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com" } };
  assert.deepEqual(withOtel(own, app, "g1to_x"), own);
  // No token (an untrusted build): nothing added.
  assert.deepEqual(withOtel({ secrets: {}, variables: {} }, app, null), { secrets: {}, variables: {} });
});

test("tags and resource attributes name the project and deployment", () => {
  assert.deepEqual(telemetryTags("prj_1", "dpl_1"), ["g1t-p:prj_1", "g1t-d:dpl_1"]);
  assert.equal(resourceAttributes(app), "deployment.environment.name=production,g1t.deployment.id=dpl_1,g1t.project.id=prj_1,vcs.ref.head.revision=abc123");
});

test("Cloudflare's traces go to the destination, logs stay with the Tail Worker", () => {
  assert.deepEqual(observabilityMetadata(null), {});
  const metadata = observabilityMetadata("g1t-traces").observability as Record<string, any>;
  assert.equal(metadata.enabled, true);
  assert.deepEqual(metadata.traces.destinations, ["g1t-traces"]);
  assert.equal(metadata.traces.persist, false);
  assert.equal(metadata.logs.enabled, false);
});
