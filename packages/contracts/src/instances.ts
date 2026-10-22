/**
 * The machine catalogue: every label a workflow job can ask for in
 * `runs-on`, and the machine g1t runs it on. Mirrors
 * `g1t_contracts::actions::INSTANCE_TYPES` row for row (a Rust test reads
 * this file), and services/runner/wrangler.jsonc gives each row's class its
 * instance type (a runner test holds them together). g1t answers GitHub's
 * hosted-runner labels (`GITHUB_HOSTED_LABELS`) at the sizes GitHub gives a
 * private repository, public repositories included. Each machine is a
 * named Cloudflare Containers instance type: the standard machine is
 * standard-3 (2 vCPU, 8 GiB, 16 GB of disk), which `ubuntu-latest` and the
 * other Ubuntu labels get, and `ubuntu-slim` is standard-2 (1 vCPU, 6 GiB,
 * 12 GB). See CONTRIBUTING.md, "Adding a machine size".
 */
export type InstanceType = {
  /** The `runs-on` label, or `standard` for the default. */
  label: string;
  /**
   * The machine, as it is billed and reported (`2-core`): runner minutes
   * are counted by machine, so a label renamed or pointed at another
   * machine leaves the history where it was. Never reused.
   */
  machine: string;
  /** The runner's Durable Object class that runs it, one per label. */
  sandboxClass: string;
  /** The named Containers instance type its class runs on. */
  container: string;
  vcpu: number;
  memoryGib: number;
  diskGb: number;
  /**
   * What a minute of it is charged, in millionths of a dollar: a job is
   * charged its minutes, rounded up, at this rate (`runnerMinutes`).
   */
  microsPerMinute: number;
};

/** Every machine a job can ask for by label, the default first. One row a line, as the Rust table's test reads them. */
export const INSTANCE_TYPES: readonly InstanceType[] = [
  { label: "standard", machine: "2-core", sandboxClass: "AttemptSandbox", container: "standard-3", vcpu: 2, memoryGib: 8, diskGb: 16, microsPerMinute: 4000 },
  // GitHub's `ubuntu-slim`; its rate is worked out in crates/contracts/src/actions.rs.
  { label: "ubuntu-slim", machine: "1-core", sandboxClass: "SandboxSlim", container: "standard-2", vcpu: 1, memoryGib: 6, diskGb: 12, microsPerMinute: 3000 },
];

/** Machines no label asks for any more, kept so minutes billed on them still read and price under their key. Neither label nor class is deployed. */
export const RETIRED_MACHINES: readonly InstanceType[] = [
  // `g1t-4core`, until g1t's labels became GitHub's.
  { label: "g1t-4core", machine: "4-core", sandboxClass: "Sandbox4Core", container: "standard-4", vcpu: 4, memoryGib: 12, diskGb: 20, microsPerMinute: 7000 },
];

/** The default: what `ubuntu-latest`, every other Linux label and any label g1t does not know get, public repositories included, as GitHub sizes a private repository's (`instance_for` in crates/contracts/src/actions.rs). */
export const STANDARD_INSTANCE: InstanceType = INSTANCE_TYPES[0]!;

/** One of GitHub's standard hosted-runner labels, at GitHub's size in a private repository, and the g1t machine that answers it. */
export type GithubLabel = {
  githubLabel: string;
  os: "linux" | "windows" | "macos";
  /** GitHub's runner's; g1t's machines are all x64. */
  arch: "x64" | "arm64";
  vcpu: number;
  memoryGb: number;
  diskGb: number;
  /** The g1t machine's label (`INSTANCE_TYPES`); null for Windows and macOS, which only a self-hosted runner can run. */
  machine: string | null;
};

/** GitHub's standard hosted runners, mirroring `GITHUB_HOSTED_LABELS` in crates/contracts/src/actions.rs row for row. */
export const GITHUB_HOSTED_LABELS: readonly GithubLabel[] = [
  { githubLabel: "ubuntu-slim", os: "linux", arch: "x64", vcpu: 1, memoryGb: 5, diskGb: 14, machine: "ubuntu-slim" },
  { githubLabel: "ubuntu-latest", os: "linux", arch: "x64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" },
  { githubLabel: "ubuntu-24.04", os: "linux", arch: "x64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" },
  { githubLabel: "ubuntu-22.04", os: "linux", arch: "x64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" },
  { githubLabel: "ubuntu-26.04", os: "linux", arch: "x64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" },
  { githubLabel: "ubuntu-24.04-arm", os: "linux", arch: "arm64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" },
  { githubLabel: "ubuntu-22.04-arm", os: "linux", arch: "arm64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" },
  { githubLabel: "ubuntu-26.04-arm", os: "linux", arch: "arm64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" },
  { githubLabel: "windows-latest", os: "windows", arch: "x64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: null },
  { githubLabel: "windows-2025", os: "windows", arch: "x64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: null },
  { githubLabel: "windows-2025-vs2026", os: "windows", arch: "x64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: null },
  { githubLabel: "windows-2022", os: "windows", arch: "x64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: null },
  { githubLabel: "windows-11-arm", os: "windows", arch: "arm64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: null },
  { githubLabel: "windows-11-vs2026-arm", os: "windows", arch: "arm64", vcpu: 2, memoryGb: 8, diskGb: 14, machine: null },
  { githubLabel: "macos-15-intel", os: "macos", arch: "x64", vcpu: 4, memoryGb: 14, diskGb: 14, machine: null },
  { githubLabel: "macos-26-intel", os: "macos", arch: "x64", vcpu: 4, memoryGb: 14, diskGb: 14, machine: null },
  { githubLabel: "macos-latest", os: "macos", arch: "arm64", vcpu: 3, memoryGb: 7, diskGb: 14, machine: null },
  { githubLabel: "macos-14", os: "macos", arch: "arm64", vcpu: 3, memoryGb: 7, diskGb: 14, machine: null },
  { githubLabel: "macos-15", os: "macos", arch: "arm64", vcpu: 3, memoryGb: 7, diskGb: 14, machine: null },
  { githubLabel: "macos-26", os: "macos", arch: "arm64", vcpu: 3, memoryGb: 7, diskGb: 14, machine: null },
  { githubLabel: "xcode-27", os: "macos", arch: "arm64", vcpu: 3, memoryGb: 7, diskGb: 14, machine: null },
];

/** An instance type by its label; the standard one for anything else. */
export function instanceNamed(label: string | null | undefined): InstanceType {
  const wanted = label?.trim().toLowerCase();
  return INSTANCE_TYPES.find((instance) => instance.label === wanted) ?? STANDARD_INSTANCE;
}

/** The machines a job can run on, once each, in the catalogue's order: the first row of each. */
export function machines(): InstanceType[] {
  return INSTANCE_TYPES.filter((instance, at) => INSTANCE_TYPES.findIndex((other) => other.machine === instance.machine) === at);
}

/** A machine by its key (`2-core`), retired ones included; null when there is none. */
export function machineNamed(machine: string): InstanceType | null {
  return [...INSTANCE_TYPES, ...RETIRED_MACHINES].find((instance) => instance.machine === machine) ?? null;
}

/** Its price as a multiple of the standard machine's. */
export function priceScale(instance: InstanceType): number {
  return instance.microsPerMinute / STANDARD_INSTANCE.microsPerMinute;
}

/** `2 vCPU, 8 GiB, 16 GB`. */
export function machineSize(instance: InstanceType): string {
  return `${instance.vcpu} vCPU, ${instance.memoryGib} GiB, ${instance.diskGb} GB`;
}

/** The minutes a job is charged for: its time rounded up to the minute, at least 1 for a job that ran. */
export function runnerMinutes(seconds: number): number {
  return seconds <= 0 ? 0 : Math.ceil(seconds / 60);
}
