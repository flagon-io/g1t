/**
 * Machines g1t runs workflow jobs on, asked for by a label in `runs-on`.
 * Mirrors `g1t_contracts::actions::INSTANCE_TYPES`. Each is a named
 * Cloudflare Containers instance type (see services/runner/wrangler.jsonc;
 * no custom types): the standard machine is standard-3 (2 vCPU, 8 GiB,
 * 16 GB of disk), `g1t-2core` is kept as a name of it so workflows that ask
 * for it keep working, and `g1t-4core` is standard-4 (4 vCPU, 12 GiB,
 * 20 GB). It costs what that instance costs g1t, plus the margin, like any
 * sandbox time.
 */
export type InstanceType = {
  /** The `runs-on` label, or `standard` for the default. */
  label: string;
  /** The named Containers instance type. */
  container: string;
  vcpu: number;
  memoryGib: number;
  diskGb: number;
  /**
   * What a second of it may cost, as a multiple of the standard machine's
   * price per second, with every vCPU busy: what is reserved before a job
   * starts, and what a job that did not report its CPU is charged at
   * (billing's `record_sandbox`; `price_scale` in the Rust contracts).
   */
  estimateScale: number;
};

/** The default: what `ubuntu-latest` and every other hosted label get. */
export const STANDARD_INSTANCE: InstanceType = {
  label: "standard",
  container: "standard-3",
  vcpu: 2,
  memoryGib: 8,
  diskGb: 16,
  estimateScale: 1,
};

/**
 * Every label a job can ask for, the default first. The scales follow
 * Cloudflare's list prices: memory $0.0000025 a GiB-second, disk
 * $0.00000007 a GB-second, vCPU $0.00002 a second, and the Durable Object
 * behind each at 128 MB, $0.0000125 a GB-second; to one decimal.
 */
export const INSTANCE_TYPES: readonly InstanceType[] = [
  STANDARD_INSTANCE,
  // The standard machine under the name it had when it was larger.
  { ...STANDARD_INSTANCE, label: "g1t-2core" },
  { label: "g1t-4core", container: "standard-4", vcpu: 4, memoryGib: 12, diskGb: 20, estimateScale: 1.8 },
];

/** An instance type by its label; the standard one for anything else. */
export function instanceNamed(label: string | null | undefined): InstanceType {
  const wanted = label?.trim().toLowerCase();
  return INSTANCE_TYPES.find((instance) => instance.label === wanted) ?? STANDARD_INSTANCE;
}
