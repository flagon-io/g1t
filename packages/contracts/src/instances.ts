import type { OfferedSize } from "./runners";

/**
 * The machine catalogue: every machine a workflow job can run on. Mirrors
 * `g1t_contracts::actions::INSTANCE_TYPES` row for row (a Rust test reads
 * this file), and services/runner/wrangler.jsonc gives each row's class its
 * instance type (a runner test holds them together). g1t answers GitHub's
 * hosted-runner labels (`GITHUB_HOSTED_LABELS`) at the sizes GitHub gives
 * the repository, public and private ones apart. Each machine is a named
 * Cloudflare Containers instance type: the standard machine is standard-3
 * (2 vCPU, 8 GiB, 16 GB of disk), which `ubuntu-latest` and the other
 * Ubuntu labels get in a private repository; the 4-core one is standard-4
 * (4 vCPU, 12 GiB, 20 GB), which they get in a public one; and
 * `ubuntu-slim` is standard-2 (1 vCPU, 6 GiB, 12 GB). See CONTRIBUTING.md,
 * "Adding a machine size".
 */
export type InstanceType = {
  /**
   * Its name in a job's start and its billing record: GitHub's label where
   * the machine is one label's alone (`ubuntu-slim`), `standard` for the
   * default, otherwise a name of g1t's (`g1t-4core`). A job asks for a
   * machine through `GITHUB_HOSTED_LABELS`, never by this name.
   */
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
  /**
   * The machine (`machine` key) a job on it is charged as: its own, or a
   * smaller one's, where g1t gives a larger machine at the smaller one's
   * price (a public repository's Ubuntu labels, as on GitHub).
   */
  billedAs: string;
};

/** Every machine a job can run on, the default first. One row a line, as the Rust table's test reads them. */
// prettier-ignore
export const INSTANCE_TYPES: readonly InstanceType[] = [
  { label: "standard", machine: "2-core", sandboxClass: "AttemptSandbox", container: "standard-3", vcpu: 2, memoryGib: 8, diskGb: 16, microsPerMinute: 4000, billedAs: "2-core" },
  // GitHub's `ubuntu-slim`; its rate is worked out in crates/contracts/src/actions.rs.
  { label: "ubuntu-slim", machine: "1-core", sandboxClass: "SandboxSlim", container: "standard-2", vcpu: 1, memoryGib: 6, diskGb: 12, microsPerMinute: 3000, billedAs: "1-core" },
  // GitHub's Ubuntu labels in a public repository, charged as the standard machine; its rate prices past minutes.
  { label: "g1t-4core", machine: "4-core", sandboxClass: "SandboxLarge", container: "standard-4", vcpu: 4, memoryGib: 12, diskGb: 20, microsPerMinute: 7000, billedAs: "2-core" },
];

/** Machines no job runs on any more, kept so minutes billed on them still read and price under their key. Neither label nor class is deployed. None today. */
export const RETIRED_MACHINES: readonly InstanceType[] = [];

/** The default: what `ubuntu-latest` and the other Ubuntu labels get in a private repository, and any label g1t does not know in any (`instance_for` in crates/contracts/src/actions.rs). */
export const STANDARD_INSTANCE: InstanceType = INSTANCE_TYPES[0]!;

/** GitHub's runner for a label in a repository of one visibility, and the g1t machine that answers it there. */
export type HostedSize = {
  vcpu: number;
  memoryGb: number;
  diskGb: number;
  /** The g1t machine's label (`INSTANCE_TYPES`); null for Windows and macOS, which only a self-hosted runner can run. */
  machine: string | null;
};

/** One of GitHub's standard hosted-runner labels, at GitHub's size in a public repository and in a private one, and the g1t machine that answers it in each. */
export type GithubLabel = {
  githubLabel: string;
  os: "linux" | "windows" | "macos";
  /** GitHub's runner's; g1t's machines are all x64. */
  arch: "x64" | "arm64";
  public: HostedSize;
  private: HostedSize;
};

/** GitHub's standard hosted runners, mirroring `GITHUB_HOSTED_LABELS` in crates/contracts/src/actions.rs row for row: one a line, as its test reads them. */
// prettier-ignore
export const GITHUB_HOSTED_LABELS: readonly GithubLabel[] = [
  { githubLabel: "ubuntu-slim", os: "linux", arch: "x64", public: { vcpu: 1, memoryGb: 5, diskGb: 14, machine: "ubuntu-slim" }, private: { vcpu: 1, memoryGb: 5, diskGb: 14, machine: "ubuntu-slim" } },
  { githubLabel: "ubuntu-latest", os: "linux", arch: "x64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: "g1t-4core" }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" } },
  { githubLabel: "ubuntu-24.04", os: "linux", arch: "x64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: "g1t-4core" }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" } },
  { githubLabel: "ubuntu-22.04", os: "linux", arch: "x64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: "g1t-4core" }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" } },
  { githubLabel: "ubuntu-26.04", os: "linux", arch: "x64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: "g1t-4core" }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" } },
  { githubLabel: "ubuntu-24.04-arm", os: "linux", arch: "arm64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: "g1t-4core" }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" } },
  { githubLabel: "ubuntu-22.04-arm", os: "linux", arch: "arm64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: "g1t-4core" }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" } },
  { githubLabel: "ubuntu-26.04-arm", os: "linux", arch: "arm64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: "g1t-4core" }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: "standard" } },
  { githubLabel: "windows-latest", os: "windows", arch: "x64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: null }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: null } },
  { githubLabel: "windows-2025", os: "windows", arch: "x64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: null }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: null } },
  { githubLabel: "windows-2025-vs2026", os: "windows", arch: "x64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: null }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: null } },
  { githubLabel: "windows-2022", os: "windows", arch: "x64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: null }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: null } },
  { githubLabel: "windows-11-arm", os: "windows", arch: "arm64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: null }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: null } },
  { githubLabel: "windows-11-vs2026-arm", os: "windows", arch: "arm64", public: { vcpu: 4, memoryGb: 16, diskGb: 14, machine: null }, private: { vcpu: 2, memoryGb: 8, diskGb: 14, machine: null } },
  { githubLabel: "macos-15-intel", os: "macos", arch: "x64", public: { vcpu: 4, memoryGb: 14, diskGb: 14, machine: null }, private: { vcpu: 4, memoryGb: 14, diskGb: 14, machine: null } },
  { githubLabel: "macos-26-intel", os: "macos", arch: "x64", public: { vcpu: 4, memoryGb: 14, diskGb: 14, machine: null }, private: { vcpu: 4, memoryGb: 14, diskGb: 14, machine: null } },
  { githubLabel: "macos-latest", os: "macos", arch: "arm64", public: { vcpu: 3, memoryGb: 7, diskGb: 14, machine: null }, private: { vcpu: 3, memoryGb: 7, diskGb: 14, machine: null } },
  { githubLabel: "macos-14", os: "macos", arch: "arm64", public: { vcpu: 3, memoryGb: 7, diskGb: 14, machine: null }, private: { vcpu: 3, memoryGb: 7, diskGb: 14, machine: null } },
  { githubLabel: "macos-15", os: "macos", arch: "arm64", public: { vcpu: 3, memoryGb: 7, diskGb: 14, machine: null }, private: { vcpu: 3, memoryGb: 7, diskGb: 14, machine: null } },
  { githubLabel: "macos-26", os: "macos", arch: "arm64", public: { vcpu: 3, memoryGb: 7, diskGb: 14, machine: null }, private: { vcpu: 3, memoryGb: 7, diskGb: 14, machine: null } },
  { githubLabel: "xcode-27", os: "macos", arch: "arm64", public: { vcpu: 3, memoryGb: 7, diskGb: 14, machine: null }, private: { vcpu: 3, memoryGb: 7, diskGb: 14, machine: null } },
];

/** An instance type by its label; the standard one for anything else. */
export function instanceNamed(label: string | null | undefined): InstanceType {
  const wanted = label?.trim().toLowerCase();
  return INSTANCE_TYPES.find((instance) => instance.label === wanted) ?? STANDARD_INSTANCE;
}

/** The machines jobs are charged as today, once each, in the catalogue's order: the first row of each, of those billed as themselves. */
export function machines(): InstanceType[] {
  return INSTANCE_TYPES.filter(
    (instance, at) => instance.billedAs === instance.machine && INSTANCE_TYPES.findIndex((other) => other.machine === instance.machine) === at,
  );
}

/** The machine a job on `instance` is charged as (`billedAs`): itself, or that machine's first row. */
export function chargedAs(instance: InstanceType): InstanceType {
  if (instance.billedAs === instance.machine) return instance;
  return INSTANCE_TYPES.find((other) => other.machine === instance.billedAs) ?? STANDARD_INSTANCE;
}

/** A machine by its key (`2-core`), retired ones included; null when there is none. */
export function machineNamed(machine: string): InstanceType | null {
  return [...INSTANCE_TYPES, ...RETIRED_MACHINES].find((instance) => instance.machine === machine) ?? null;
}

/** What to call it for people: `standard machine`, the GitHub label that is its name (`ubuntu-slim`), or else its machine (`4-core machine`). */
export function machineTitle(instance: InstanceType): string {
  if (instance.label === STANDARD_INSTANCE.label) return "standard machine";
  return GITHUB_HOSTED_LABELS.some((github) => github.githubLabel === instance.label) ? instance.label : `${instance.machine} machine`;
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

// --- Sizes: g1t's machines as the sizes a self-hosted runner takes jobs for ---

/** One of g1t's machines as a size a runner takes: `Standard`, 2 vCPU, 8 GiB. */
export type RunnerSize = { machine: string; name: string; vcpu: number; memoryMib: number; leastMemoryMib: number };

/** What people call each machine as a size (`SIZE_NAMES` in the Rust contracts). */
const SIZE_NAMES: Record<string, string> = { "1-core": "Small", "2-core": "Standard", "4-core": "Large" };

/**
 * The least memory, in GiB, a size's jobs run with where a runner's sandbox has less than the size
 * (`SIZE_LEAST_MEMORY` in the Rust contracts): about two-thirds of it. CPUs are never fewer.
 */
const SIZE_LEAST_MEMORY: Record<string, number> = { "1-core": 4, "2-core": 6, "4-core": 8 };

/** Every size, smallest first: each of g1t's machines once (`sizes()` in the Rust contracts). */
export function runnerSizes(): RunnerSize[] {
  const out: RunnerSize[] = [];
  for (const instance of INSTANCE_TYPES) {
    if (out.some((size) => size.machine === instance.machine)) continue;
    const memoryMib = instance.memoryGib * 1024;
    const leastMemoryMib = Math.min((SIZE_LEAST_MEMORY[instance.machine] ?? instance.memoryGib) * 1024, memoryMib);
    out.push({ machine: instance.machine, name: SIZE_NAMES[instance.machine] ?? instance.machine, vcpu: instance.vcpu, memoryMib, leastMemoryMib });
  }
  return out.sort((a, b) => a.vcpu - b.vcpu || a.memoryMib - b.memoryMib);
}

/** A size by its machine's key; null when it is not one. */
export function runnerSize(machine: string): RunnerSize | null {
  return runnerSizes().find((size) => size.machine === machine.trim().toLowerCase()) ?? null;
}

/** Memory for people: `8 GB`, `1.5 GB`, `512 MB`. */
export function memorySaid(mib: number): string {
  if (mib < 1024) return `${mib} MB`;
  return `${Math.round((mib / 1024) * 100) / 100} GB`;
}

/** `2 vCPU · 8 GB`. */
export function roomSaid(cpus: number, memoryMib: number): string {
  return `${Math.round(cpus * 100) / 100} vCPU · ${memorySaid(memoryMib)}`;
}

/**
 * A size for people: `Standard`, or `Standard → 4 vCPU · 16 GB` when its jobs get other than the size (more,
 * or less memory down to its least).
 */
export function offeredSizeSaid(offered: OfferedSize): string {
  const size = runnerSize(offered.size);
  if (!size) return offered.size;
  const cpus = Math.max(offered.cpus ?? size.vcpu, size.vcpu);
  const memory = Math.max(offered.memory_mib ?? size.memoryMib, size.leastMemoryMib);
  return cpus === size.vcpu && memory === size.memoryMib ? size.name : `${size.name} → ${roomSaid(cpus, memory)}`;
}

/** What a runner takes, for people: `Small, Standard → 4 vCPU · 16 GB`; `no sizes` when it takes none. */
export function sizesSaid(sizes: OfferedSize[]): string {
  return sizes.length === 0 ? "no sizes" : sizes.map(offeredSizeSaid).join(", ");
}
