# Bare-metal runners: bigger machines, sticky disks and a colocated cache

Status: proposal, not built. Written 2026-10-21 from the code at
`4b28cabf`, for work item #240 (which follows #225 and #190). Nothing here
is documented behaviour; `apps/docs` remains the description of what g1t
does. Prices were checked on the providers' pages on the date above and
change often; check them again before ordering anything.

## The problem

g1t's hosted jobs run on Cloudflare Containers (`services/runner`, one
Durable Object class per machine, `INSTANCE_TYPES` in
`crates/contracts/src/actions.rs`). That buys a lot: no fleet to run, a
sandbox per job, egress and brokered secrets in the Worker's outbound
handler, and billing that holds and settles each sandbox's cost. It also
sets two limits that no amount of tuning moves:

1. **Size.** The largest named instance type is `standard-4`: 4 vCPU,
   12 GiB, 20 GB of disk. Work item #190 waits on Cloudflare for a 16 GiB
   custom type; nothing on the roadmap gets a job 8 or 16 vCPU. A cold
   `cargo build` of this workspace is CPU-bound, and twice the cores is
   most of twice the speed.
2. **Nothing stays.** A container's disk goes when it stops. Every job
   starts from the image and pulls what it needs over the network: the
   Actions cache from R2 through the API (#227 made a write one R2 put and
   a few D1 queries, but the bytes still cross the network), sccache's
   objects from R2, Docker layers from registries. The git edge works
   around the same limit by snapshotting its mirror to R2 and restoring it
   on start (`packs/edge/<repo_id>/mirror.tar`); that is the best a
   container can do.

#225 made the cache warm and the base image complete. What is left is the
part only different hardware fixes: more and faster cores, a local NVMe
disk that is still there for the next job of the same repository, and the
cache in the same building as the job.

## What exists today

The design reuses more than it adds, so it is worth being exact about the
pieces.

**Hosted jobs are pushed.** `plan.rs` `start_queued_except` takes queued
jobs with `labels IS NULL` (hosted ones), oldest first, checks
`has_room` (4 per workspace always, up to 12 while the pool of 60 keeps 8
free, `lib.rs`), `max-parallel` and concurrency groups, flips the row from
`queued` to `in_progress` in one statement, and asks `runner` for a
sandbox of the job's machine (`start_instance` → `instance_for`). `runner`
asks billing to hold the estimated cost (`ComputeGate.admit`), starts the
container, and settles when it stops. A job with no machine waits up to
`WAIT_FOR_MACHINE_MS` (30 minutes), retried each minute by the cron.

**Self-hosted jobs are pulled.** A job whose `runs-on` names
`self-hosted` or a group is stored with its labels (`Wanted::stored`) and
left for runners. A runner polls `POST /runners/{id}/poll` (a 20-second
long poll that doubles as its heartbeat); `runners.rs` `claim` selects
queued jobs of its workspace, filters by labels, group and isolation
(`isolation_allows`: a `host` runner never takes a public repository's
job), applies the same `max-parallel` and concurrency rules, and claims
with the same one-statement flip. The runner then fetches the job and
reports through the API with the job's own token, exactly as a hosted
sandbox does. Self-hosted time goes on usage at $0 (`released`).

**Runner groups** (`set_runner_group`) say which repositories a set of a
workspace's runners serves. They are a workspace's own; nothing in them
is shared across workspaces.

**The sandboxed launcher** (`crates/runner/src/selfhosted/launcher`)
gives a self-hosted runner walls: on Linux with Sysbox, the runner's
image under `sysbox-runc` with no Docker socket, and a fresh container
per job inside it (`nested-container`); without Sysbox, a QEMU `microvm`
with KVM (`vm.rs`, untested on real hardware so far). The job container
and its own dockerd come from the same image as hosted sandboxes.

**The Actions cache** (`services/actions/src/cache.rs`): D1 lists the
entries and decides scope (own ref, then the pull request's base, then
the default branch; a fork's pull request saves under `untrusted:<ref>`),
versions, the 10 GiB per-repository quota, and eviction (7 days unused,
28 days old, least recently restored first past the quota). The bytes are
in the R2 bucket `g1t-actions-cache`, written and read through the API.

**Egress and secrets.** A hosted sandbox's requests go straight out,
except a job that may be given brokered secrets, whose HTTP and HTTPS
pass the runner Worker so it can swap `g1tsec_…` stand-ins for the real
values (`broker-egress.ts`). On a self-hosted runner the job asks
`POST /actions/jobs/{job}/broker` instead and g1t makes the request, so
the value never reaches the machine. `crates/runner/src/abuse.rs` stops a
sandbox that mines.

## Prior art

Internal notes may name other products; user-facing text may not.

| Who        | Runs on                                                    | Wall per job                              | Persistent disk                                                                                                          | Cache                                                      | Price a minute (x64)                             |
| ---------- | ---------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------ |
| Blacksmith | Rented bare metal, "gaming" CPUs, 32-vCPU boxes, US and EU | Firecracker microVM, boots in under 3 s   | Sticky disks: ext4 clone of the last commit, Ceph on NVMe, last commit wins, optional default-branch-only, 7 days unused | MinIO (dependencies) and Ceph (Docker layers) in the fleet | $0.002 per vCPU: 8 vCPU $0.016, 16 vCPU $0.032   |
| Namespace  | Its own hardware                                           | microVM, own kernel                       | Cache volumes: local NVMe fork of the last commit, best effort, 14 days                                                  | On the volume                                              | $0.001 to $0.0015 per vCPU (prepaid / overage)   |
| Ubicloud   | Hetzner (AX162, AX102), Leaseweb, AWS metal                | Cloud Hypervisor VM in its own namespaces | None                                                                                                                     | Its own cache service                                      | 8 vCPU $0.005 (EPYC) / $0.008 (7950X3D, EU only) |
| Depot      | EC2 (m7a), warm pool, one instance per job                 | A whole VM                                | None for runners; BuildKit cache on Ceph                                                                                 | S3 and Ceph                                                | 2 vCPU $0.006                                    |
| WarpBuild  | AWS, GCP, Azure VMs                                        | A whole VM                                | Snapshots of the whole VM, $0.04 a restore                                                                               | $0.20 per GB-month                                         | 2 vCPU $0.004, 32 vCPU $0.064                    |
| RunsOn     | EC2 in the customer's account                              | A whole VM                                | None                                                                                                                     | S3                                                         | A yearly licence, the customer pays AWS          |
| GitHub     | Azure VMs                                                  | A whole VM                                | None                                                                                                                     | Its cache service, 10 GB per repository                    | 8-core $0.022, 16-core $0.042                    |

Blacksmith's sticky disks and Docker cache are $0.50 per GB-month;
Namespace's cache volumes are about $0.15 per GB-month. Blacksmith's
Docker caching is a buildkitd on a sticky disk keyed per repository,
committed only when no step failed or was cancelled.

What they agree on: hosts the provider owns or rents as bare metal, a
microVM per job (Firecracker or Cloud Hypervisor), never a shared
container kernel between customers; consumer or workstation CPUs with high
single-core clocks for build-heavy work; persistent per-repository disks
on the host's NVMe, mounted copy-on-write so concurrent jobs don't fight;
and a cache in the same data centre, reached at local-network speed
through the same `actions/cache` protocol so workflows don't change.

## Providers and machines

What a CI host wants: a high single-core clock (compilers and linkers are
mostly serial at the end), 16 or more cores so a host takes a 16-core job
with room for its own work, DDR5, two NVMe drives, unmetered traffic, an
API to order and reinstall, and KVM (bare metal, not a cloud VM). Prices
exclude VAT; EUR is converted at 1.20.

| Provider       | Machine          | CPU                                    | Memory, disk               | Price a month (setup)                       | Billing, sites                                                         |
| -------------- | ---------------- | -------------------------------------- | -------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| Hetzner        | AX102-1          | Ryzen 9 7950X3D, 16 cores / 32 threads | 128 GB DDR5 ECC, 2 × NVMe  | €257.30 (€129), about $310                  | Monthly; Falkenstein, Nuremberg, Helsinki. 1 Gbit/s, unlimited traffic |
| Hetzner        | AX42-1           | Ryzen 7 PRO 8700GE, 8 / 16             | 64 GB DDR5 ECC             | €97.30 (€49)                                | As above; too small for a 16-core job                                  |
| Hetzner        | AX162-1          | EPYC 9454P, 48 / 96                    | 128 GB and up              | €612.30 (€304)                              | As above; lower clocks                                                 |
| Hetzner        | Server Auction   | Older Ryzen and Xeon                   | Varies                     | From about €67, no setup                    | Monthly; refurbished, no stated delivery time                          |
| OVHcloud       | Rise RISE-S      | Ryzen 7 9700X, 8 / 16, 5.5 GHz         | 64 GB DDR5                 | $77 ($77)                                   | Monthly; EU, US (Vint Hill, Hillsboro), Canada; unmetered              |
| OVHcloud       | Advance-2 (2026) | EPYC 4345P, 8 / 16                     | —                          | $160 ($160)                                 | Monthly; many 2026 configurations "soon available"                     |
| Latitude.sh    | f4.metal.medium  | EPYC 4564P, 16 cores, 4.5 GHz          | 128 GB                     | $0.76 an hour ($555); $277 reserved monthly | Hourly or reserved (50% off monthly, 65% yearly); 2 × 10 Gbit/s        |
| Latitude.sh    | f4.metal.small   | EPYC 4484PX, 12 cores, 4.4 GHz         | 96 GB, 2 × 960 GB          | $0.55 an hour                               | As above                                                               |
| Cherry Servers | Ryzen 9950X      | 16 / 32, 5.7 GHz boost                 | 128 GB DDR5, 2 × 1 TB NVMe | $408, $347 on a yearly term; $0.70 an hour  | Hourly or monthly; Chicago, Frankfurt, Amsterdam, more; 15 to 30 min   |
| PhoenixNAP BMC | d3 / s4          | Xeon                                   | —                          | From about $1.27 an hour                    | Hourly; mostly Xeon (lower clocks)                                     |
| AWS            | c7i.metal-24xl   | Sapphire Rapids, 96 vCPU, 3.2 GHz      | 192 GiB, EBS only          | $4.284 an hour (spot about $1.25)           | Per second; every region; egress charged                               |
| AWS            | m7a.metal-48xl   | EPYC 9R14, 192 vCPU                    | 768 GiB                    | $11.128 an hour (spot about $3.51)          | As above                                                               |

Equinix Metal, the obvious API-first choice a year ago, closed on
30 June 2026. GCP's `c3-highcpu-192-metal` is about $8.67 an hour; Azure
has no general-purpose bare metal. Hetzner raised dedicated prices twice
in 2026 (April and June); its matrix page still shows older "from"
prices, so the adjustment notice's numbers are used here.

Reading the table:

- **Hetzner AX102** is the reference machine: the CPU Blacksmith calls a
  "gaming" CPU (and Ubicloud's premium runners use), 16 fast cores, 128 GB,
  unlimited traffic, a Robot API. Its weaknesses are EU only and a
  setup fee with monthly terms, so it is base capacity, not burst.
- **Cherry Servers' 9950X** is the same class of machine, newer, with US
  sites and hourly billing, at about 1.1 to 1.3 times the price. It is the
  second source for the same host class.
- **Latitude.sh** is the US and burst option: hourly with no setup, a
  fast EPYC 4004-series part, and a 50% discount for reserving monthly.
- **OVHcloud Rise** is the cheapest per thread but 8 cores per box: one
  8-core job per host, no 16-core.
- **AWS metal** costs 10 to 20 times as much per core held all month, but
  is billed by the second and is in every region. As emergency burst it is
  cheaper per used minute than it looks (see below); it takes minutes to
  boot and is not where the fast single-core parts are.

## Cost per minute against our rates

g1t prices a machine at what a minute costs it plus 20%, rounded up to a
tenth of a cent (`INSTANCE_TYPES`, CONTRIBUTING "Adding a machine size").
On Containers a minute's cost is a list price with half the vCPUs busy.
On metal the cost is a fixed monthly bill, so a minute's cost is the bill
divided by the minutes actually sold: **utilisation is the price**.

The model, for an AX102:

- $310 a month plus the €129 setup over a year: **$323 a month**, or
  $0.0074 for each minute the whole host exists.
- The host keeps 2 cores (4 threads) and 32 GB for itself: the agent,
  the cache server, storage. That leaves **24 threads and 96 GB to sell**:
  three 8-core jobs (32 GiB each), or a 16-core and an 8-core.
- **25% on top** for what isn't a sold host: one spare host per site, the
  bastion, R2 for backups and cache copies, and time a host is drained.
- Then the margin, 20%.

| Fleet utilisation (threads sold / threads held) | Cost per vCPU-minute, with overhead and margin | `g1t-8core` | `g1t-16core` |
| ----------------------------------------------- | ---------------------------------------------- | ----------- | ------------ |
| 30%                                             | $0.00154                                       | $0.0123     | $0.0246      |
| 40%                                             | $0.00115                                       | $0.0092     | $0.0184      |
| 50%                                             | $0.00092                                       | $0.0074     | $0.0147      |
| 70%                                             | $0.00066                                       | $0.0053     | $0.0105      |

For comparison, per vCPU-minute: g1t's Containers machines charge
$0.0020 (2-core) and $0.00175 (4-core); Blacksmith $0.002; GitHub's
8-core $0.00275; Ubicloud's 7950X3D runners $0.001.

Other hosts on the same model, per thread-minute held, before overhead
and margin: Latitude.sh's f4.metal.medium reserved monthly is $0.00026
(about the AX102's $0.00031, with US sites); OVHcloud's RISE-S is $0.00024
but only fits an 8-core job; AWS `c7i.metal-24xl` on demand is $0.00074
per vCPU-minute and spot $0.00022, but only for the minutes it is up. So
AWS on demand, kept up only while the queue needs it, costs about what a
monthly host does at 40% utilisation, which makes it a sound overflow and
a poor base.

**Proposed rates: `g1t-8core` $0.010 a minute, `g1t-16core` $0.019.**
That is the 40% row rounded up. CI load is bursty (weekday working hours
in a few time zones), so 30 to 40% is what a fleet sized for its peaks
sees early on; the rates cover cost, overhead included, from about 31% and earn more as the
fleet fills. They are cheaper per vCPU than g1t's own Containers machines
and than Blacksmith or GitHub, and dearer than Ubicloud. The rates are
reviewed with the fleet's real utilisation after three months, in the
same direction as the rule: down if it runs fuller.

What the fleet costs before anyone uses it: phase 1's four hosts and a
spare are about $1,600 a month. At the proposed rates, a host breaks even
selling about 40,000 8-core minutes a month (31% of its slots). sudo's Costs & margin gains a metal line (hosts, R2, egress) so
this is watched, not assumed.

Sticky disk storage on the same model: a host's NVMe is about a quarter
of its cost; split between scratch, the site cache and sticky disks, a
sticky GB-month costs about $0.05 at full and $0.09 at half full, so
**$0.11 per GB-month** with the margin, plus R2's $0.015 for its backup.
Blacksmith charges $0.50.

## Machines and labels

Two new rows in `INSTANCE_TYPES`, and a new field on every row saying
where it runs:

| `runs-on`    | Machine   | vCPUs | Memory | Disk (scratch) | Pool         |
| ------------ | --------- | ----- | ------ | -------------- | ------------ |
| `g1t-2core`  | `2-core`  | 2     | 8 GiB  | 16 GB          | `containers` |
| `g1t-4core`  | `4-core`  | 4     | 12 GiB | 20 GB          | `containers` |
| `g1t-8core`  | `8-core`  | 8     | 32 GiB | 150 GB         | `metal`      |
| `g1t-16core` | `16-core` | 16    | 64 GiB | 300 GB         | `metal`      |

- A vCPU on metal is one hardware thread, and a job gets whole cores: an
  8-core job is 4 physical cores with both of their threads, so two
  customers never share a core's caches (see isolation).
- `ubuntu-latest` and the 2- and 4-core labels stay on Containers. Only a
  job that names `g1t-8core` or `g1t-16core` goes to metal, so nobody's
  bill or isolation changes without their asking. Once metal has run for
  a while, moving `g1t-4core` there too is a pricing decision, not a
  design one (it would be cheaper and faster); this proposal does not make
  it.
- `instance_for` keeps picking the dearest label named; a job that names
  `g1t-16core` and `self-hosted` is still a self-hosted job, as today
  (`Wanted::self_hosted` wins).
- `machine` keys `8-core` and `16-core` are new and never reused, so usage
  history stays put. CONTRIBUTING's "Adding a machine size" gains a step
  for a metal row: no Durable Object class, a host class in the metal
  pool's catalogue instead.
- Linux x64 only at first, as hosted runners are today. An arm64 metal
  host (Ampere) is a later row, `g1t-8core-arm`, if anyone asks.

## How jobs are placed

Metal jobs are **pulled**, like self-hosted ones, because the hosts are
outside Cloudflare and should have no open port: a host dials out, and
g1t never dials in. But they are **g1t's machines**: billed as hosted
minutes, shared by every workspace, counted against a pool and a
workspace's share, and never in a workspace's runner list.

### What is stored

- `jobs.pool`: `containers` (the default, today's hosted path), `metal`,
  or null for a self-hosted job (`labels IS NOT NULL`, unchanged). Set at
  queue time from `instance_for`, with `jobs.machine` (`8-core`).
  `start_queued_except` gains `AND pool = 'containers'`, so it never
  starts a metal job.
- `metal_hosts` (actions' D1): id, site, host class, slots (whole cores
  free and total), the sticky disks it holds (repository and key, size,
  last used), state (`ready`, `draining`, `down`), version, last seen, and
  a credential hash. A host is registered by an operator token, not a
  workspace's registration token.

### The dispatcher

A Durable Object per site, `MetalDispatcher`, in the actions service.
Each host's agent keeps one WebSocket open to it (outbound from the host,
hibernating on Cloudflare's side), sends a heartbeat every 10 seconds
with its free slots and the disks it holds, and is pushed assignments the
moment there is one. Polling every 20 seconds, as self-hosted runners do,
would add up to 20 seconds to every job's start; a socket makes start
latency the VM's boot.

When a metal job is queued, or a slot frees, or the minute cron runs, the
dispatcher runs one placement pass over the site's queued metal jobs,
oldest first:

1. **Room.** The same rules as Containers, counted on metal alone: a
   workspace has a share of metal cores it may always use, and a burst
   while the pool keeps headroom (`has_room`, by cores instead of jobs:
   start with 16 cores always and 48 at most per workspace, while 16
   of the pool's cores stay free). `max-parallel` and concurrency groups as today.
2. **Billing.** The workspace's standing must allow it, and billing
   holds the estimated cost (`reserve`), as `ComputeGate.admit` does for a
   sandbox. Refused: the job fails with billing's reason, as today.
3. **Affinity.** Hosts that hold a sticky disk the job will mount (its
   repository and keys, known from the plan: see below), with enough free
   cores, come first; then the host that ran this repository's last
   job (its cache shard and page cache are warm); then the host with the
   fewest free cores that still fits (bin packing, so a 16-core job can
   still find room). A job whose affine host is full waits up to 15
   seconds for it before taking any host: a cold disk costs more than
   15 seconds, a long wait costs more than a cold disk.
4. **Claim.** The one-statement flip from `queued` to `in_progress`, with
   `runner_id` set to the host (prefixed `metal:` so self-hosted code
   paths never mistake it) and `pool = 'metal'`, then the assignment is
   pushed down the host's socket with the job's token. A host that doesn't
   acknowledge within 10 seconds loses the job back to `queued`.

The host starts a VM for the job (isolation, below); inside it the same
`g1t-runner` in `MODE=actions` fetches the job and reports through the
API with the job's token, exactly as in a hosted sandbox. Nothing about
steps, logs, cancel, artifacts or statuses changes.

When the VM exits, the host reports the job finished and its seconds; the
dispatcher frees the cores, `runner_minutes` rounds up, and billing
settles at the machine's rate. A host that goes quiet for 30 seconds is
`down`: its jobs fail as lost (the same message as `SILENT_MS`, sooner)
and are not retried automatically, as today. A job waits for metal at
most `WAIT_FOR_MACHINE_MS`, then fails saying no machine was free. It
never falls back to a smaller Containers machine: a job asked for 16
cores because it needs them.

Planned metal capacity is shown nowhere to users beyond the job's
waiting reason ("Waiting for an 8-core machine").

### Why not runner groups

A self-hosted runner group is a workspace's own and its runners are
billed at $0; making g1t's fleet a group in every workspace would put
g1t's hosts in their lists, give their owners settings over them, and
need a second billing path anyway. The pieces that carry over are code,
not data: `Wanted`, the claim statement, `max-parallel` and concurrency
SQL, `released`'s usage record (at the rate, not $0), and the runner
binary.

## Isolation and security

Metal hosts run strangers' code from many workspaces side by side,
public repositories' pull requests included. The bar is that a job can
reach nothing of the host, of another job, or of another tenant's disk,
and that a host compromised anyway holds nothing that outlives it.

### A microVM per job: Firecracker

Each job runs in its own Firecracker microVM, made for it and destroyed
after:

- **Why a VM, not Sysbox.** Sysbox is a good wall for a self-hosted
  runner, where every job belongs to the machine's owner: it keeps a job
  off the owner's machine. Between customers it is one Linux kernel
  shared by every job on the host, and a kernel bug (there are several a
  year that cross user namespaces) is a jump from one customer to all of
  them. A VM puts KVM and a small device model between them instead.
  Every provider that does this commercially reached the same answer.
- **Why Firecracker.** A minimal device model (virtio-net, virtio-blk,
  vsock, serial: no USB, no PCI passthrough, no GPU), a jailer that runs
  each VMM in its own chroot, cgroup, network and PID namespaces as an
  unprivileged user under seccomp, boot in well under a second, and years
  of multi-tenant use in Lambda and Fargate. Cloud Hypervisor is the
  alternative if we later need what Firecracker lacks (virtio-fs, memory
  hotplug, PCI passthrough for GPUs); the host agent hides which is used.
  The QEMU `microvm` code in the launcher stays for self-hosted Linux
  without Sysbox; it is not the hosted wall.
- **Inside the VM** is the same image as a hosted sandbox
  (`services/runner/base/Dockerfile`), converted to an ext4 root disk per
  release and mounted read-only with a writable overlay on the job's
  scratch disk; the job's own dockerd runs inside the VM, so Docker,
  buildx and service containers work as they do today, with no nested
  virtualisation needed. The VM gets its cores pinned (`cpuset`, whole
  cores, both threads), its memory, a scratch disk (a fresh thin volume),
  its sticky disks, and a tap device.
- **Snapshots.** Firecracker can restore a booted VM from a memory
  snapshot in tens of milliseconds. Start without it (a cold boot of a
  minimal kernel is a second or two; the job's clone takes longer); add it
  only if start latency says so, and never share one snapshot's memory
  between VMs that would see the same randomness (re-seed on restore).

### The host

- **Nothing reaches it.** No public SSH. Operators reach hosts over
  WireGuard from a bastion; the host's firewall drops every inbound
  packet on the public interface except replies. The agent's only
  connections are outbound: the dispatcher's socket, R2, the API.
- **Immutable.** The host OS is one image built in CI (a minimal Debian
  or Flatcar with the agent, Firecracker, the jailer and nftables),
  installed from the provider's rescue system, updated by draining and
  re-imaging, never by hand.
- **Cores are not shared between jobs.** Jobs get whole physical cores,
  so SMT siblings never belong to two jobs; kernel mitigations stay on.
  The host keeps two cores for itself (agent, cache server, storage).
- **Networking.** Each VM gets a tap device in its own network namespace,
  NAT to the public address, and nftables rules that drop traffic to
  other VMs, the host, the provider's private and link-local ranges
  (metadata services, the vSwitch, the management network) and SMTP.
  Two addresses are reachable on the host side: the cache (below) and the
  brokered-request endpoint.
- **Secrets.** Brokered secrets use the self-hosted path that already
  exists: the job sends the request to `POST /actions/jobs/{job}/broker`
  and g1t makes it, so a real value is never on a metal host. No
  long-lived credential is on a host but its own host credential, which
  can only receive assignments and report them; job tokens live as long
  as their job.
- **Abuse.** `abuse.rs` runs in the VM as it does in a sandbox; the host
  also watches each VM's CPU and network from outside (a miner that
  kills the in-VM sampler still shows on the host's counters) and stops
  it. A provider's abuse report (outbound scanning, say) names an IP and
  a time; the host keeps which job held which VM when, for 90 days, so
  it names a job.
- **Public repositories.** A fork's pull request runs on metal only if
  its workflow asks for a metal label, as it would anywhere; it gets no
  sticky disk write and the untrusted cache scope, below. That is the
  same trust as Containers.

## Sticky disks

A sticky disk is a directory a job asks to keep: the next job of the
same repository that asks for the same key finds it as the last
successful job left it. It is what makes a warm `target/`,
`~/.cargo/registry`, `node_modules` or `/var/lib/docker` cheap: no
download, no unpack, just a mount.

### What a workflow says

```yaml
jobs:
  build:
    runs-on: g1t-16core
    steps:
      - uses: actions/checkout@v4
      - uses: g1t/sticky-disk@v1
        with:
          key: cargo-target-${{ runner.os }}
          path: target
      - run: cargo build --release
```

`g1t/sticky-disk` is a step the runner handles itself, as it does g1t's
own `actions/cache`: at the step, the disk is mounted at `path`; at the
job's end, it is unmounted and committed or thrown away. On Containers
it says so in the log and falls back to `actions/cache` with the same key
and path, so a workflow can name it before it moves to metal. A
`g1t/setup-docker-builder` step does the same for BuildKit's state
(`/var/lib/buildkit` under the key `docker`), which is most of Docker
layer caching for free.

### Semantics

- **Per repository, keyed.** A disk is named by repository, scope and
  key. Keys are the workflow's to choose; a repository has at most 10
  keys and 200 GB of sticky disks together (on the 16-core machine, a
  single disk up to 100 GB).
- **Scoped like the cache.** A job mounts the newest committed generation
  of its key in its own ref's scope, else its pull request's base
  branch's, else the default branch's. It writes back only to its own
  ref's scope, and a fork's pull request writes back nowhere: it gets a
  throwaway copy. A default-branch disk can only ever be changed by a job
  that ran on the default branch, so a pull request cannot plant
  anything in the next release build.
- **Copy-on-write, so concurrency is free.** A disk is a thin volume
  (LVM thin pool or ZFS zvol on the host's NVMe). Mounting is a snapshot
  of the newest generation: instant and private to the job. Two matrix
  jobs with the same key each get their own copy and never see each
  other's writes.
- **Committed on success.** When a job ends successfully and may write
  its scope, its snapshot becomes the key's new generation in one
  metadata update, and older generations nobody has mounted are deleted.
  If two jobs commit, the later one wins: the newest generation is a
  complete disk from one job, never a merge. A failed or cancelled job's
  copy is discarded, so a broken build does not poison the next one.
- **Placement-bound.** A disk lives on one host. The dispatcher sends a
  job to the host that holds its keys when it can (affinity, above). A job
  on another host starts with the key's R2 backup if there is one
  (below), else empty, and its commit makes that host the key's home.
- **Backed up, lazily.** Phase 3: after a commit, the host uploads a
  compressed image of the generation to R2 at most every 30 minutes per
  key (as the git edge does its mirror), so a host lost or a job moved
  starts warm, not empty. Before that phase a lost host means cold disks,
  which is slower, never wrong.
- **Eviction.** A key not mounted for 7 days is deleted, on its host and
  in R2. Past a repository's 200 GB, the key mounted longest ago goes
  first. When a host's thin pool passes 80%, it deletes the generations
  mounted longest ago, any repository's, until it is under 70%. Deleting
  a key, or all of a repository's, is a button and a CLI command beside
  `g1t cache delete`; deleting a repository deletes them.
- **Encrypted per repository.** Each repository's volumes are dm-crypt
  with a key from g1t (sealed per repository, handed to the host with the
  assignment, held only in kernel memory). A disk the provider pulls, or
  a block reused after deletion, is unreadable; deleting a repository
  deletes its key, which erases every copy at once.
- **Billing.** Sticky disk storage is GB-month at cost plus 20% (about
  $0.11, see costs), measured daily, like cache storage; reading and
  writing it is free.

## The colocated cache

The `actions/cache` protocol stays exactly as it is; where its bytes
live changes for metal jobs.

- **The index stays in D1.** `cache.rs` keeps deciding everything it
  decides today: scope, version, the key's reservation, the quota and
  eviction. A metal job's cache step asks the API for the entry as now.
- **Bytes go to the site first.** Each host runs a small cache server on
  a host-side address only its VMs can reach, storing entries on its NVMe
  and talking to its site's other hosts. The API's answer to a metal
  job's restore says where the entry is: on the site (the runner fetches
  it at NVMe and LAN speed, several GB/s), or only in R2 (the cache server
  fetches it, keeps it, and streams it on). A save writes to the site and
  returns; the server copies it to R2 in the background, so a Containers
  job, another site, or the site after a loss still finds it.
- **The site keeps what is used.** Its own LRU over the site's cache
  disks, independent of D1's eviction: a site copy can always be dropped
  because R2 has the entry. D1's deletions are pushed to the site so a
  deleted entry is gone there too.
- **sccache and registries.** The same server answers sccache's S3 API
  for its bucket prefix and proxies the Docker Hub, crates.io, npm and
  PyPI downloads a job makes, keyed by content, so the site downloads a
  popular crate or base image once. These are pull-through caches of
  public content; a job's own registry credentials are never cached.

Against today's cache: the per-repository quota, scopes and API do not
change, so nothing in a workflow does. The win is that a 2 GB restore
that takes 15 to 30 seconds from R2 in a container takes 1 to 2 from the
site, and a sticky disk takes none.

## Operations

Containers made g1t's compute someone else's operations problem. Metal
makes some of it ours again; the design keeps that part small.

- **Sites and size.** One site to start: Hetzner Falkenstein, four AX102
  hosts and one spare (96 threads to sell, 12 concurrent 8-core jobs or 6
  16-core ones). A site is hosts in one data centre on one private
  network (Hetzner's vSwitch), so the cache servers reach each other at
  LAN speed. A second site (US) comes in phase 4.
- **Ordering and installing.** Hosts are ordered through the provider's
  API (Hetzner Robot) by an operator, not automatically: a month's
  commitment is a decision. `deploy/metal` holds the host image's build
  (CI publishes it with each runner release, signed like the sandbox VM's
  image) and an install script run from the provider's rescue system,
  which partitions the NVMe (system, scratch thin pool, sticky thin
  pool, cache), installs the image, and registers the host with a
  one-time operator token. Reinstalling is the same script.
- **Updates.** A new host image or agent: each host in turn is drained
  (takes no new jobs, finishes its own), re-imaged, and comes back with
  its sticky disks and cache intact (they are not on the system
  partition). A new job VM image (the sandbox image) needs no drain: the
  next job boots the new root disk. Rolling a site takes under an hour,
  and jobs never see it.
- **Watching.** Each host's heartbeat carries load, free cores, disk
  and thin-pool use, and VM boot times; the dispatcher writes them to
  telemetry. status.g1t.sh gains a probe that runs a tiny `g1t-8core`
  job every 10 minutes and times queue-to-first-step. Alerts: a host
  down, a site's queue wait over 2 minutes, a thin pool past 85%, VM
  boots failing. `runner-errors.mjs` reads metal hosts' errors as it
  reads the runner Worker's.
- **Failures.** A host that dies loses its running jobs (they fail as
  lost, as a container's do today) and its sticky disks (they come back
  from R2 from phase 3, else cold). The provider replaces hardware; we
  reinstall. A site that is down makes metal jobs wait, then fail after
  `WAIT_FOR_MACHINE_MS`, with a status page incident; there is no silent
  fallback to smaller machines.
- **Capacity.** Utilisation and queue wait per site are on sudo. Add a
  host when weekday peak wait exceeds a minute for a week, or average
  utilisation passes 60%; drop one when it stays under 25% for a month.
  Overflow beyond that (phase 4) is hourly hosts (Latitude.sh, Cherry
  Servers), added and removed by the dispatcher within limits an
  operator sets.
- **Abuse and the provider.** Hosts send mail to nobody (SMTP blocked),
  and the per-job record of VM, address and time answers abuse reports
  with a job, a repository and a workspace. Repeated abuse from a
  workspace stops its metal jobs as `abuse.rs` stops sandboxes today.
- **Access.** Two operators hold WireGuard keys to the bastion; every
  shell on a host is logged to the audit log as an operator action. No
  customer data is on a host but sticky disks (encrypted, keys not on
  disk) and cache copies (also in R2).
- **Self-hosted installations of g1t.** The metal pool is g1t.sh's: an
  installation without a `METAL` dispatcher binding has no metal rows in
  its catalogue, and a job asking for `g1t-8core` fails saying the
  machine isn't offered there. (An unknown label runs on the standard
  machine today; a metal label must not quietly become a 2-core one.)
- **Costs.** sudo's Costs & margin gets a metal line: host invoices
  (entered monthly), R2 for backups and cache copies, and minutes sold,
  so utilisation and margin are numbers, not guesses.

## Recommendation

Build a metal pool of our own, on rented Ryzen bare metal, with a
Firecracker microVM per job, pulled through a dispatcher Durable Object,
for two new machines only (`g1t-8core` at $0.010 a minute, `g1t-16core`
at $0.019); start in one EU site on Hetzner AX102s, then add sticky
disks, then the colocated cache, then a US site and hourly overflow.

Not chosen:

- **Waiting for Cloudflare.** A 16 GiB custom type (#190) helps memory,
  not cores or disks; nothing announced gives Containers persistent
  volumes.
- **Sysbox on metal**, reusing the self-hosted launcher as the wall. It
  is the fastest to build and the wrong wall between customers (one
  kernel). It stays what self-hosted runners use.
- **Cloud VMs per job** (EC2, as Depot, WarpBuild and RunsOn do). No
  fleet to run, but per-minute costs near GitHub's, slower single cores,
  network disks, and no colocated anything; it would not be faster than
  Containers by enough to be worth a second path.
- **Reselling a provider's runners.** Their machines would run g1t's
  jobs with g1t's tokens outside g1t's walls, and the cache and sticky
  disks would be theirs.
- **Moving everything to metal.** Containers stay the default: they
  scale to zero, cost nothing idle, and are where `ubuntu-latest`, checks,
  the merge queue, deploys and the git edge run. Metal is opt-in by label
  until it has a record.

### Phases

Each phase is its own work item, following #240, and ships with its
docs (Actions guide, usage and billing, compute architecture) in the
same change.

1. **Metal machines.** The host image and install script
   (`deploy/metal`), the host agent (`g1t-runner metal`: Firecracker and
   jailer, the job VM image from the sandbox image, networking and
   nftables, abuse watching from the host), `metal_hosts`, `jobs.pool`,
   the `MetalDispatcher` Durable Object and its placement pass (room by
   cores, billing reserve and settle, bin packing), `g1t-8core` and
   `g1t-16core` in `INSTANCE_TYPES` and its mirror with a `pool` field,
   operations (watching, the status probe, sudo's metal line), and one
   site of four AX102s and a spare. Done when this repository's Rust jobs
   run on `g1t-16core`, are billed at its rate, and a fork's pull request
   on metal can reach nothing of the host or another job (tested).
2. **Sticky disks.** Thin pools, per-repository dm-crypt keys,
   `g1t/sticky-disk` and `g1t/setup-docker-builder` (with the
   `actions/cache` fallback on Containers), scopes, generations, commit on
   success, eviction, affinity in placement, the list and delete UI and
   CLI, and storage billing. Done when this repository's `target/` is a
   sticky disk and a warm `cargo build` on `g1t-16core` is measured
   against today's.
3. **The colocated cache.** The host cache server, site-first saves
   written through to R2, the API's answer naming where an entry is,
   sccache and registry pull-through caches, and R2 backups of sticky
   disks. Done when a 2 GB restore on metal takes under 3 seconds and a
   sticky disk moved to another host starts warm.
4. **A second site and overflow.** A US site (Latitude.sh f4 reserved, or
   Cherry Servers 9950X, whichever is in stock at the price), placement
   by site (the job's workspace's site, else the nearer free one), and
   hourly overflow hosts the dispatcher adds and removes within operator
   limits. Then, with three months of utilisation, review the rates and
   whether `g1t-4core` moves to metal.
