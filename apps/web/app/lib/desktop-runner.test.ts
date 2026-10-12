import assert from "node:assert/strict";
import { test } from "node:test";

import { HEARTBEAT_MS, type DesktopRunnerView, backendOf, diagnosisOf, reportDue, reportKey, reportOf } from "./desktop-runner.ts";

function view(over: Partial<DesktopRunnerView> = {}): DesktopRunnerView {
  return {
    diagnosis: { code: "no_docker", tone: "problem", title: "Not running: Docker isn't running", cause: "Docker isn't running.", fix: "Start Docker Desktop.", actions: [{ id: "open_docker", label: "Open Docker" }] },
    closed: { code: "off", tone: "off", title: "g1t is closed on build-box", cause: null, fix: "Open g1t on build-box.", actions: [] },
    running: false,
    version: "0.2.3",
    backend: "docker",
    workspace: "acme",
    workspaces: [{ slug: "acme", name: "Acme" }],
    enabled: true,
    paused: false,
    link: "https://g1t.sh/acme/-/runners",
    machine: "build-box",
    platform: "windows",
    log: ["2026-10-12T08:00:00Z a line"],
    ...over,
  };
}

test("a report carries the app's words, without its buttons or log", () => {
  const report = reportOf(view());
  assert.deepEqual(report, {
    workspace: "acme",
    machine: "build-box",
    backend: "docker",
    version: "0.2.3",
    diagnosis: { code: "no_docker", tone: "problem", title: "Not running: Docker isn't running", cause: "Docker isn't running.", fix: "Start Docker Desktop." },
    closed: { code: "off", tone: "off", title: "g1t is closed on build-box", cause: null, fix: "Open g1t on build-box." },
  });
  assert.equal(reportOf(view({ workspace: null })), null);
});

test("a report goes when what the page shows changes, and as a heartbeat", () => {
  const report = reportOf(view())!;
  const at = 1_000_000;
  assert.equal(reportDue(null, report, at), true);
  const last = { key: reportKey(report), at };
  assert.equal(reportDue(last, report, at + 1000), false);
  assert.equal(reportDue(last, report, at + HEARTBEAT_MS), true);
  const busy = reportOf(view({ diagnosis: { ...view().diagnosis, code: "busy", tone: "working", title: "Running Build (acme/web)" } }))!;
  assert.equal(reportDue(last, busy, at + 1000), true);
});

test("a sandboxed desktop reports each kind of job, without its buttons", () => {
  const linux = { id: "linux", label: "Linux jobs", tone: "ok" as const, title: "Waiting for jobs", cause: null, fix: null, actions: [] };
  const windows = {
    id: "windows",
    label: "Windows jobs",
    tone: "off" as const,
    title: "Not available",
    cause: "Windows Sandbox is off, or this edition of Windows has none: Home doesn't.",
    fix: "Linux jobs still run.",
    actions: [{ id: "windows_features", label: "Open Windows features" }],
  };
  const sandboxed = view({ backend: "sandboxed", diagnosis: { code: "idle", tone: "ok", title: "Waiting for jobs", cause: null, fix: null, actions: [], capabilities: [linux, windows] } });
  const report = reportOf(sandboxed)!;
  assert.deepEqual(report.diagnosis.capabilities, [
    { id: "linux", label: "Linux jobs", tone: "ok", title: "Waiting for jobs", cause: null, fix: null },
    { id: "windows", label: "Windows jobs", tone: "off", title: "Not available", cause: windows.cause, fix: "Linux jobs still run." },
  ]);
  // One kind of job changing is a report due.
  const last = { key: reportKey(report), at: 0 };
  const running = reportOf(view({ ...sandboxed, diagnosis: { ...sandboxed.diagnosis, capabilities: [linux, { ...windows, tone: "ok", title: "Waiting for jobs", cause: null, fix: null }] } }))!;
  assert.equal(reportDue(last, running, 1000), true);
  // What the server keeps: only kinds of job that read, and none for a desktop without any.
  const kept = diagnosisOf({ ...report.diagnosis, capabilities: [...report.diagnosis.capabilities!, { id: "x", tone: "loud" }, "linux"] })!;
  assert.equal(kept.capabilities?.length, 2);
  assert.equal(diagnosisOf({ code: "idle", tone: "ok", title: "Waiting for jobs" })!.capabilities, undefined);
  assert.equal(reportOf(view())!.diagnosis.capabilities, undefined);
});

test("only a diagnosis and a backend the app makes are kept", () => {
  assert.deepEqual(diagnosisOf({ code: "idle", tone: "ok", title: "Waiting for jobs", cause: "Running sandboxed.", extra: 1 }), {
    code: "idle",
    tone: "ok",
    title: "Waiting for jobs",
    cause: "Running sandboxed.",
    fix: null,
  });
  assert.equal(diagnosisOf({ code: "idle", tone: "loud", title: "x" }), null);
  assert.equal(diagnosisOf("idle"), null);
  assert.equal(backendOf("host"), "host");
  assert.equal(backendOf("vm"), null);
});
