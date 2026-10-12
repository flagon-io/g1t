import assert from "node:assert/strict";
import { test } from "node:test";

import { HEARTBEAT_MS, type DesktopRunnerView, backendOf, diagnosisOf, jobHref, reportDue, reportKey, reportOf } from "./desktop-runner.ts";

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

test("each kind of job reports its state, whether the person stopped it, and its job, without what only works here", () => {
  const linux = {
    id: "linux",
    label: "Linux jobs",
    tone: "working" as const,
    title: "Running a job",
    cause: null,
    fix: null,
    state: "busy" as const,
    about: "A Linux VM of its own, each job in a fresh container",
    enabled: true,
    job: { kind: "workflow", name: "build", repo: "acme/web", link: "https://g1t.sh/acme/web/actions" },
    runner: "build-box-linux",
    isolation: "nested-container",
    version: "0.3.0",
    available: true,
    can_toggle: true,
    progress: null,
    actions: [],
  };
  const windows = {
    id: "windows",
    label: "Windows jobs",
    tone: "off" as const,
    title: "Stopped",
    cause: "You stopped Windows jobs on this computer. They stay stopped until you start them.",
    fix: null,
    state: "stopped" as const,
    enabled: false,
    can_toggle: true,
    actions: [],
  };
  const sandboxed = view({
    backend: "sandboxed",
    diagnosis: { code: "busy", tone: "working", title: "Running build (acme/web)", cause: null, fix: null, actions: [], capabilities: [linux, windows], in_capabilities: true },
  });
  const report = reportOf(sandboxed)!;
  assert.equal(report.diagnosis.in_capabilities, true);
  assert.deepEqual(report.diagnosis.capabilities![0], {
    id: "linux",
    label: "Linux jobs",
    tone: "working",
    title: "Running a job",
    cause: null,
    fix: null,
    state: "busy",
    about: "A Linux VM of its own, each job in a fresh container",
    enabled: true,
    job: { kind: "workflow", name: "build", repo: "acme/web" },
    runner: "build-box-linux",
    isolation: "nested-container",
    version: "0.3.0",
  });
  assert.equal(report.diagnosis.capabilities![1].enabled, false);
  // Starting Windows jobs again is a report due.
  const last = { key: reportKey(report), at: 0 };
  const started = reportOf(view({ ...sandboxed, diagnosis: { ...sandboxed.diagnosis, capabilities: [linux, { ...windows, enabled: true, state: "starting", title: "Starting", tone: "working" }] } }))!;
  assert.equal(reportDue(last, started, 1000), true);
  // What the server keeps reads back the same, and drops what isn't one of the app's.
  const kept = diagnosisOf(JSON.parse(JSON.stringify(report.diagnosis)))!;
  assert.deepEqual(kept, report.diagnosis);
  const odd = diagnosisOf({ ...report.diagnosis, capabilities: [{ ...report.diagnosis.capabilities![0], state: "dancing", enabled: "yes", job: { name: "x" } }] })!;
  assert.equal(odd.capabilities![0].state, undefined);
  assert.equal(odd.capabilities![0].enabled, undefined);
  assert.equal(odd.capabilities![0].job, undefined);
  // Only a diagnosis with kinds of job says they say it all.
  assert.equal(diagnosisOf({ code: "idle", tone: "ok", title: "Waiting for jobs", in_capabilities: true })!.in_capabilities, undefined);
});

test("a kind of job's work links to its run when the runner says which", () => {
  const capability = { runner: "build-box-linux", job: { kind: "workflow", name: "build", repo: "acme/web" } };
  const runners = [{ name: "build-box-linux", work: { kind: "workflow" as const, id: "job_1", name: "build", repo: "acme/web", runId: "run_9", startedAt: null } }];
  assert.equal(jobHref(capability, runners), "/acme/web/actions/runs/run_9");
  assert.equal(jobHref(capability, []), "/acme/web/actions");
  assert.equal(jobHref({ runner: null, job: { kind: "agent", name: "fix", repo: "acme/web" } }, runners), "/acme/web/agents");
  assert.equal(jobHref({ runner: "x", job: null }, runners), null);
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

test("a report says how the runner's updates stand, without the app's own words and button", () => {
  const update = {
    checked_at: "2026-10-12T12:00:00Z",
    checked: "Checked 12 min ago",
    checking: false,
    ready: "0.3.2",
    note: null,
    check: { id: "check_updates", label: "Check for runner updates" },
  };
  const linux = { id: "linux", label: "Linux jobs", tone: "working" as const, title: "Running a job", cause: null, fix: null, actions: [], version: "0.3.1", update: "0.3.2 ready, installs after this job" };
  const sandboxed = view({ backend: "sandboxed", diagnosis: { code: "busy", tone: "working", title: "Running build (acme/web)", cause: null, fix: null, actions: [], capabilities: [linux], in_capabilities: true, update } });
  const report = reportOf(sandboxed)!;
  assert.deepEqual(report.diagnosis.update, { checked_at: "2026-10-12T12:00:00Z", ready: "0.3.2", note: null });
  assert.equal(report.diagnosis.capabilities![0].update, "0.3.2 ready, installs after this job");
  // A look that found something, or a newer one put in, is reported at once.
  const last = { key: reportKey(report), at: 0 };
  const looked = reportOf(view({ ...sandboxed, diagnosis: { ...sandboxed.diagnosis, update: { ...update, checked_at: "2026-10-12T13:00:00Z" } } }))!;
  assert.equal(reportDue(last, looked, 1000), true);
  const installed = reportOf(view({ ...sandboxed, diagnosis: { ...sandboxed.diagnosis, capabilities: [{ ...linux, version: "0.3.2", update: undefined }] } }))!;
  assert.equal(reportDue(last, installed, 1000), true);
  // As the server reads it back: a time that isn't one is dropped, and an update that says nothing is none.
  const kept = diagnosisOf(JSON.parse(JSON.stringify(report.diagnosis)))!;
  assert.deepEqual(kept.update, report.diagnosis.update);
  assert.equal(kept.capabilities![0].update, "0.3.2 ready, installs after this job");
  assert.deepEqual(diagnosisOf({ ...report.diagnosis, update: { checked_at: "soon", ready: "0.3.2" } })!.update, { checked_at: null, ready: "0.3.2", note: null });
  assert.equal(diagnosisOf({ ...report.diagnosis, update: { checked_at: 5 } })!.update, undefined);
  // An app from before updates were reported says nothing of them.
  assert.equal(reportOf(view())!.diagnosis.update, undefined);
});
