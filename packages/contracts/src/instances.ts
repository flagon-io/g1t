/**
 * The machine catalogue: every label a workflow job can ask for in
 * `runs-on`, and the machine g1t runs it on. Mirrors
 * `g1t_contracts::actions::INSTANCE_TYPES` row for row (a Rust test reads
 * this file), and services/runner/wrangler.jsonc gives each row's class its
 * instance type (a runner test holds them together). Each machine is a
 * named Cloudflare Containers instance type: the standard machine is
 * standard-3 (2 vCPU, 8 GiB, 16 GB of disk), `g1t-2core` is kept as a name
 * of it so workflows that ask for it keep working, and `g1t-4core` is
 * standard-4 (4 vCPU, 12 GiB, 20 GB). See CONTRIBUTING.md, "Adding a
 * machine size".
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

/** Every label a job can ask for, the default first. One row a line, as the Rust table's test reads them. */
export const INSTANCE_TYPES: readonly InstanceType[] = [
  { label: "standard", machine: "2-core", sandboxClass: "AttemptSandbox", container: "standard-3", vcpu: 2, memoryGib: 8, diskGb: 16, microsPerMinute: 4000 },
  // The standard machine under the name it had when it was larger.
  { label: "g1t-2core", machine: "2-core", sandboxClass: "Sandbox2Core", container: "standard-3", vcpu: 2, memoryGib: 8, diskGb: 16, microsPerMinute: 4000 },
  { label: "g1t-4core", machine: "4-core", sandboxClass: "Sandbox4Core", container: "standard-4", vcpu: 4, memoryGib: 12, diskGb: 20, microsPerMinute: 7000 },
];

/** The default: what `ubuntu-latest` and every other hosted label get. */
export const STANDARD_INSTANCE: InstanceType = INSTANCE_TYPES[0]!;

/** An instance type by its label; the standard one for anything else. */
export function instanceNamed(label: string | null | undefined): InstanceType {
  const wanted = label?.trim().toLowerCase();
  return INSTANCE_TYPES.find((instance) => instance.label === wanted) ?? STANDARD_INSTANCE;
}

/** The machines, once each, in the catalogue's order: the first row of each. */
export function machines(): InstanceType[] {
  return INSTANCE_TYPES.filter((instance, at) => INSTANCE_TYPES.findIndex((other) => other.machine === instance.machine) === at);
}

/** A machine by its key (`2-core`); null when there is none. */
export function machineNamed(machine: string): InstanceType | null {
  return INSTANCE_TYPES.find((instance) => instance.machine === machine) ?? null;
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
