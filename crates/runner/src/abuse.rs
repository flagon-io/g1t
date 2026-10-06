//! Catching cryptocurrency mining in a sandbox.
//!
//! Mining needs two things a g1t sandbox tries not to give it: a route to a
//! mining pool, which the network allowlist refuses, and hours of CPU, which
//! this module watches for. Three layers:
//!
//! 1. **Known miners, by name.** `miner_in` matches miner programs (xmrig,
//!    cpuminer, ...), pool URLs (`stratum+tcp://`), their flags
//!    (`--donate-level`) and well-known pools. The agent harness's command
//!    hook refuses a matching shell command (guard.rs), checks, deploy
//!    builds and workflow steps refuse to run one, and the sampler below
//!    stops the sandbox if a running process's command line matches.
//! 2. **The CPU signature.** A background thread samples the sandbox every
//!    `SAMPLE_SECONDS`: CPU use (from `/proc/stat`), file and disk I/O
//!    (`/proc/diskstats` and every process's `/proc/<pid>/io`), network
//!    bytes (`/proc/net/dev`), how many new processes started, and whether
//!    the run did anything a person would call progress (a tool call, an
//!    agent step, a new check command or workflow step). `Detector` flags a
//!    sandbox only when, for a whole `WINDOW_SECONDS` (10 minutes):
//!    - CPU stayed at or above `MIN_CPU` (90%) in every sample but one;
//!    - file and disk I/O averaged under `MAX_IO_PER_SECOND` (64 KB/s);
//!    - the network averaged under `MAX_NET_PER_SECOND` (16 KB/s);
//!    - fewer than `MAX_NEW_PROCESSES` (5) processes started; and
//!    - there was no progress at all.
//!
//!    Compilers and test suites are CPU-bound too, but they read sources,
//!    write objects and start processes (a `cargo build` or `npm test`
//!    starts hundreds), so they fail the I/O or process test. A single
//!    compiler process can sit in code generation for minutes with little
//!    I/O, so when the busiest process is a known toolchain (`TOOLCHAINS`)
//!    and nothing matches a miner by name, it is not flagged.
//! 3. **What happens.** The sandbox tells the runner service (an HTTP
//!    request to `REPORT_URL`, which the runner's Durable Object answers
//!    without it leaving the machine), kills every other process, and
//!    exits with `EXIT_CODE`. The runner marks the run "Stopped: unusual
//!    CPU use; contact support if this was a real job" and emits
//!    `abuse.flagged` for g1t's staff, with these metrics.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;

/// How often the sandbox is sampled.
pub const SAMPLE_SECONDS: u64 = 30;
/// How long the signature must hold before a run is flagged.
pub const WINDOW_SECONDS: u64 = 10 * 60;
/// CPU use, of all the sandbox's CPUs, that counts as pinned.
pub const MIN_CPU: f64 = 0.90;
/// Samples in a window that may dip under `MIN_CPU` (a miner's own pauses).
pub const ALLOWED_DIPS: usize = 1;
/// File and disk I/O, in bytes a second, under which a run counts as doing none.
pub const MAX_IO_PER_SECOND: f64 = 64.0 * 1024.0;
/// Network, in bytes a second, under which a run counts as quiet.
pub const MAX_NET_PER_SECOND: f64 = 16.0 * 1024.0;
/// New processes in a window under which a run counts as not building.
pub const MAX_NEW_PROCESSES: u64 = 5;
/// What the sandbox exits with when it stops itself for mining.
pub const EXIT_CODE: i32 = 86;
/// Where the sandbox tells the runner; answered by the runner's Durable
/// Object, never sent anywhere.
pub const REPORT_URL: &str = "http://sandbox.g1t.internal/abuse";

/// Programs whose name alone says they mine. Matched anywhere in a command
/// line, so downloads of them are caught too.
const MINER_NAMES: &[&str] = &[
    "xmrig",
    "xmr-stak",
    "cpuminer",
    "minerd",
    "ccminer",
    "cgminer",
    "bfgminer",
    "ethminer",
    "nbminer",
    "lolminer",
    "phoenixminer",
    "nanominer",
    "srbminer",
    "teamredminer",
    "bzminer",
    "nheqminer",
    "xmrminer",
];

/// Programs matched only as a whole program name: as words they are too
/// common.
const MINER_PROGRAMS: &[&str] = &["t-rex", "gminer", "wildrig", "rigel"];

/// Arguments and addresses only miners use.
const MINER_ARGS: &[&str] = &[
    "stratum+tcp://",
    "stratum+ssl://",
    "stratum+tls://",
    "stratum2+tcp://",
    "--donate-level",
    "--cpu-max-threads-hint",
    "--randomx-mode",
    "--algo=rx/",
    "--algo rx/",
    "-a rx/0",
    "--algo=cryptonight",
    "-a cryptonight",
    "--coin=monero",
    "--coin monero",
    "supportxmr.com",
    "moneroocean.stream",
    "minexmr.com",
    "nanopool.org",
    "2miners.com",
    "f2pool.com",
    "hashvault.pro",
    "unmineable.com",
    "nicehash.com",
    "herominers.com",
    "c3pool.com",
];

/// Toolchains that can keep a CPU busy for minutes with little I/O while
/// they generate code. Busiest-process names, as `/proc/<pid>/stat` gives
/// them (cut to 15 characters).
const TOOLCHAINS: &[&str] = &[
    "rustc", "cc1", "cc1plus", "clang", "clang++", "ld", "ld.lld", "lld", "mold", "go", "compile", "link",
    "javac", "java", "kotlinc", "scalac", "swift-frontend", "ghc", "node", "tsc", "esbuild", "webpack", "python3",
    "python", "pytest", "cargo", "gcc", "g++", "rust-analyzer", "dotnet",
];

/// The miner a command line names, if it names one.
pub fn miner_in(command: &str) -> Option<&'static str> {
    let text = command.to_lowercase();
    if let Some(name) = MINER_NAMES.iter().find(|name| text.contains(*name)) {
        return Some(name);
    }
    if let Some(arg) = MINER_ARGS.iter().find(|arg| text.contains(*arg)) {
        return Some(arg);
    }
    text.split(|c: char| c.is_whitespace() || matches!(c, ';' | '|' | '&' | '(' | ')' | '`' | '"' | '\''))
        .map(|word| word.rsplit('/').next().unwrap_or(word))
        .find_map(|program| MINER_PROGRAMS.iter().find(|name| **name == program).copied())
}

/// What the run has done that a person would call progress, bumped by the
/// harness on each tool call and step, and by checks and workflows on each
/// command or step they start.
static ACTIVITY: AtomicU64 = AtomicU64::new(0);

/// Notes progress, so a busy CPU is not mistaken for a miner's.
pub fn touch() {
    ACTIVITY.fetch_add(1, Ordering::Relaxed);
}

/// One reading of the sandbox. Counters are totals since boot; the
/// detector works on the differences between readings.
#[derive(Clone, Debug, Default)]
pub struct Sample {
    /// Seconds, on any steady clock.
    pub at: u64,
    pub cpu_busy: u64,
    pub cpu_total: u64,
    /// File and disk bytes read and written.
    pub io_bytes: u64,
    pub net_bytes: u64,
    /// Processes seen for the first time since the last sample.
    pub new_processes: u64,
    pub activity: u64,
    /// The process that used the most CPU since the last sample, by name.
    pub busiest: Option<String>,
    /// A running process whose command line names a miner, if any.
    pub miner: Option<String>,
}

/// Why a sandbox was flagged, as reported and shown to g1t's staff.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Verdict {
    /// `cpu` for the signature, `miner` for a miner seen by name.
    pub reason: &'static str,
    /// Average CPU use over the window, 0 to 1.
    pub cpu: f64,
    pub io_bytes_per_second: f64,
    pub net_bytes_per_second: f64,
    pub new_processes: u64,
    pub window_seconds: u64,
    pub busiest: Option<String>,
    pub matched: Option<String>,
}

/// Watches samples for the signature of mining.
#[derive(Default)]
pub struct Detector {
    samples: VecDeque<Sample>,
}

impl Detector {
    /// Takes a sample; returns a verdict the first time the signature holds.
    pub fn observe(&mut self, sample: Sample) -> Option<Verdict> {
        if let Some(matched) = sample.miner.clone() {
            return Some(Verdict {
                reason: "miner",
                cpu: 0.0,
                io_bytes_per_second: 0.0,
                net_bytes_per_second: 0.0,
                new_processes: sample.new_processes,
                window_seconds: 0,
                busiest: sample.busiest.clone(),
                matched: Some(matched),
            });
        }
        self.samples.push_back(sample);
        // Keep just over one window: the oldest sample is its start.
        while self.samples.len() > 2
            && self.samples[1].at + WINDOW_SECONDS <= self.samples.back().map_or(0, |last| last.at)
        {
            self.samples.pop_front();
        }
        let first = self.samples.front()?;
        let last = self.samples.back()?;
        let span = last.at.saturating_sub(first.at);
        if span < WINDOW_SECONDS {
            return None;
        }
        let pairs: Vec<(&Sample, &Sample)> = self.samples.iter().zip(self.samples.iter().skip(1)).collect();
        let uses: Vec<f64> = pairs
            .iter()
            .map(|(a, b)| {
                let total = b.cpu_total.saturating_sub(a.cpu_total);
                if total == 0 { 0.0 } else { b.cpu_busy.saturating_sub(a.cpu_busy) as f64 / total as f64 }
            })
            .collect();
        let dips = uses.iter().filter(|cpu| **cpu < MIN_CPU).count();
        if dips > ALLOWED_DIPS {
            return None;
        }
        let seconds = span as f64;
        let io = last.io_bytes.saturating_sub(first.io_bytes) as f64 / seconds;
        let net = last.net_bytes.saturating_sub(first.net_bytes) as f64 / seconds;
        let new_processes: u64 = self.samples.iter().skip(1).map(|s| s.new_processes).sum();
        if io >= MAX_IO_PER_SECOND || net >= MAX_NET_PER_SECOND || new_processes >= MAX_NEW_PROCESSES {
            return None;
        }
        if last.activity != first.activity {
            return None;
        }
        // A compiler deep in code generation: busy, quiet, and expected.
        if last.busiest.as_deref().is_some_and(|name| TOOLCHAINS.contains(&name)) {
            return None;
        }
        Some(Verdict {
            reason: "cpu",
            cpu: uses.iter().sum::<f64>() / uses.len().max(1) as f64,
            io_bytes_per_second: io,
            net_bytes_per_second: net,
            new_processes,
            window_seconds: span,
            busiest: last.busiest.clone(),
            matched: None,
        })
    }
}

// ---- Reading /proc ------------------------------------------------------------

/// Busy and total CPU ticks from `/proc/stat`'s first line.
pub fn parse_cpu(stat: &str) -> Option<(u64, u64)> {
    let line = stat.lines().find(|line| line.starts_with("cpu "))?;
    let values: Vec<u64> = line.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    if values.len() < 4 {
        return None;
    }
    // user nice system idle iowait irq softirq steal: guest time is in user.
    let counted = &values[..values.len().min(8)];
    let total: u64 = counted.iter().sum();
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    Some((total.saturating_sub(idle), total))
}

/// Bytes received and sent on every interface but loopback, from `/proc/net/dev`.
pub fn parse_net(dev: &str) -> u64 {
    dev.lines()
        .skip(2)
        .filter_map(|line| {
            let (name, rest) = line.split_once(':')?;
            if name.trim() == "lo" {
                return None;
            }
            let fields: Vec<u64> = rest.split_whitespace().filter_map(|v| v.parse().ok()).collect();
            Some(fields.first().copied().unwrap_or(0) + fields.get(8).copied().unwrap_or(0))
        })
        .sum()
}

/// Bytes read and written on whole disks, from `/proc/diskstats`.
pub fn parse_disks(stats: &str) -> u64 {
    stats
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let name = *fields.get(2)?;
            let virtual_device = ["loop", "ram", "dm-", "zram", "sr"].iter().any(|prefix| name.starts_with(prefix));
            let partition = if name.starts_with("nvme") || name.starts_with("mmcblk") {
                name.contains('p')
            } else {
                name.ends_with(|c: char| c.is_ascii_digit())
            };
            if virtual_device || partition {
                return None;
            }
            let read: u64 = fields.get(5)?.parse().ok()?;
            let written: u64 = fields.get(9)?.parse().ok()?;
            Some((read + written) * 512)
        })
        .sum()
}

/// A process's name and CPU ticks (user + system), from `/proc/<pid>/stat`.
pub fn parse_proc_stat(stat: &str) -> Option<(String, u64)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let name = stat.get(open + 1..close)?.to_owned();
    let rest: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
    // After the name: state is field 3, utime 14 and stime 15 (1-based).
    let utime: u64 = rest.get(11)?.parse().ok()?;
    let stime: u64 = rest.get(12)?.parse().ok()?;
    Some((name, utime + stime))
}

/// Characters read and written by a process, from `/proc/<pid>/io`.
pub fn parse_proc_io(io: &str) -> u64 {
    io.lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            matches!(key.trim(), "rchar" | "wchar").then(|| value.trim().parse::<u64>().ok()).flatten()
        })
        .sum()
}

/// What the sampler remembers between readings.
#[derive(Default)]
struct Processes {
    /// CPU ticks and characters of I/O by process id, as last read.
    seen: BTreeMap<u32, (u64, u64)>,
    /// I/O of processes that have exited, so totals never go back.
    io_carried: u64,
}

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

impl Processes {
    /// Reads every process: new ones, the busiest, total I/O, and any miner.
    fn read(&mut self, own: u32) -> (u64, Option<String>, u64, Option<String>) {
        let mut now: BTreeMap<u32, (u64, u64)> = BTreeMap::new();
        let mut new = 0;
        let mut busiest: Option<(u64, String)> = None;
        let mut miner = None;
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return (0, None, 0, None);
        };
        for entry in entries.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else {
                continue;
            };
            let Some((name, ticks)) = parse_proc_stat(&read(&format!("/proc/{pid}/stat"))) else {
                continue;
            };
            let io = parse_proc_io(&read(&format!("/proc/{pid}/io")));
            let before = self.seen.get(&pid).copied();
            if before.is_none() {
                new += 1;
            }
            let used = ticks.saturating_sub(before.map_or(ticks, |(t, _)| t));
            if pid != own && busiest.as_ref().is_none_or(|(most, _)| used > *most) {
                busiest = Some((used, name));
            }
            if pid != own && miner.is_none() {
                let cmdline = read(&format!("/proc/{pid}/cmdline")).replace('\0', " ");
                miner = miner_in(&cmdline).map(|matched| format!("{matched} in `{}`", cmdline.trim()));
            }
            now.insert(pid, (ticks, io));
        }
        for (pid, (_, io)) in &self.seen {
            if !now.contains_key(pid) {
                self.io_carried += io;
            }
        }
        let io_total = self.io_carried + now.values().map(|(_, io)| io).sum::<u64>();
        // The first reading sees every process as new: that is not churn.
        let first = self.seen.is_empty();
        self.seen = now;
        (if first { 0 } else { new }, busiest.map(|(_, name)| name), io_total, miner)
    }
}

/// Starts the sampler in the background. When it flags the sandbox it
/// reports, stops every other process and exits with `EXIT_CODE`.
/// Off where `/proc` cannot be read (not Linux), or with `G1T_ABUSE=off`.
pub fn watch() {
    if std::env::var("G1T_ABUSE").as_deref() == Ok("off") || !std::path::Path::new("/proc/stat").exists() {
        return;
    }
    std::thread::spawn(|| {
        let started = std::time::Instant::now();
        let own = std::process::id();
        let mut detector = Detector::default();
        let mut processes = Processes::default();
        loop {
            let (cpu_busy, cpu_total) = parse_cpu(&read("/proc/stat")).unwrap_or((0, 0));
            let (new_processes, busiest, process_io, miner) = processes.read(own);
            let sample = Sample {
                at: started.elapsed().as_secs(),
                cpu_busy,
                cpu_total,
                io_bytes: parse_disks(&read("/proc/diskstats")) + process_io,
                net_bytes: parse_net(&read("/proc/net/dev")),
                new_processes,
                activity: ACTIVITY.load(Ordering::Relaxed),
                busiest,
                miner,
            };
            if let Some(verdict) = detector.observe(sample) {
                stop(&verdict, own);
            }
            std::thread::sleep(Duration::from_secs(SAMPLE_SECONDS));
        }
    });
}

/// Reports the verdict, kills everything else and exits.
fn stop(verdict: &Verdict, own: u32) -> ! {
    eprintln!("g1t-runner: stopped for unusual CPU use: {}", serde_json::to_string(verdict).unwrap_or_default());
    let _ = ureq::post(REPORT_URL)
        .timeout(Duration::from_secs(10))
        .send_json(serde_json::json!({ "verdict": verdict }));
    if let Ok(entries) = std::fs::read_dir("/proc") {
        let pids: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()))
            .filter(|pid| *pid != own && *pid != 1)
            .map(|pid| pid.to_string())
            .collect();
        if !pids.is_empty() {
            // As root where the sandbox still can; as itself otherwise.
            let as_root = std::process::Command::new("sudo")
                .args(["-n", "kill", "-9"])
                .args(&pids)
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            if !as_root {
                let _ = std::process::Command::new("kill").arg("-9").args(&pids).status();
            }
        }
    }
    std::process::exit(EXIT_CODE)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sandbox whose CPU runs at `cpu` (0 to 1), with this much I/O,
    /// network and process churn each sample, sampled for `minutes`.
    fn run(minutes: u64, cpu: f64, io_per_sample: u64, net_per_sample: u64, new_per_sample: u64, busiest: &str, active: bool) -> Option<Verdict> {
        let mut detector = Detector::default();
        let mut sample = Sample::default();
        let mut verdict = None;
        for i in 0..=(minutes * 60 / SAMPLE_SECONDS) {
            sample.at = i * SAMPLE_SECONDS;
            sample.cpu_total += 1000;
            sample.cpu_busy += (cpu * 1000.0) as u64;
            sample.io_bytes += io_per_sample;
            sample.net_bytes += net_per_sample;
            sample.new_processes = if i == 0 { 0 } else { new_per_sample };
            if active {
                sample.activity += 1;
            }
            sample.busiest = Some(busiest.to_owned());
            if verdict.is_none() {
                verdict = detector.observe(sample.clone());
            }
        }
        verdict
    }

    #[test]
    fn a_pinned_quiet_process_is_flagged_after_ten_minutes() {
        assert!(run(9, 0.99, 1_000, 500, 0, "kworker", false).is_none());
        let verdict = run(11, 0.99, 1_000, 500, 0, "kworker", false).expect("flagged");
        assert_eq!(verdict.reason, "cpu");
        assert!(verdict.cpu > 0.95);
        assert!(verdict.window_seconds >= WINDOW_SECONDS);
    }

    #[test]
    fn a_compile_that_reads_and_writes_is_not_flagged() {
        // 30 MB of I/O a sample: a build writing objects.
        assert!(run(30, 1.0, 30 * 1024 * 1024, 0, 0, "unknown", false).is_none());
    }

    #[test]
    fn a_test_suite_that_starts_processes_is_not_flagged() {
        assert!(run(30, 1.0, 1_000, 0, 3, "unknown", false).is_none());
    }

    #[test]
    fn a_compiler_in_code_generation_is_not_flagged() {
        assert!(run(30, 1.0, 0, 0, 0, "rustc", false).is_none());
        assert!(run(30, 1.0, 0, 0, 0, "cc1plus", false).is_none());
    }

    #[test]
    fn an_agent_that_keeps_working_is_not_flagged() {
        assert!(run(30, 1.0, 0, 0, 0, "unknown", true).is_none());
    }

    #[test]
    fn half_a_cpu_is_not_pinned() {
        assert!(run(30, 0.6, 0, 0, 0, "unknown", false).is_none());
    }

    #[test]
    fn a_chatty_process_is_not_quiet() {
        // 1 MB a sample on the network: a download or a server, not a
        // miner whose pool the allowlist refused.
        assert!(run(30, 1.0, 0, 1024 * 1024, 0, "unknown", false).is_none());
    }

    #[test]
    fn one_dip_does_not_save_a_miner() {
        let mut detector = Detector::default();
        let mut sample = Sample::default();
        let mut flagged = false;
        for i in 0..=22 {
            sample.at = i * SAMPLE_SECONDS;
            sample.cpu_total += 1000;
            sample.cpu_busy += if i == 5 { 300 } else { 990 };
            flagged |= detector.observe(sample.clone()).is_some();
        }
        assert!(flagged);
    }

    #[test]
    fn a_miner_seen_by_name_is_flagged_at_once() {
        let mut detector = Detector::default();
        let verdict = detector
            .observe(Sample { miner: Some("xmrig".to_owned()), ..Sample::default() })
            .expect("flagged");
        assert_eq!(verdict.reason, "miner");
    }

    #[test]
    fn miners_are_known_by_name_argument_and_pool() {
        assert_eq!(miner_in("./xmrig -o pool:3333"), Some("xmrig"));
        assert_eq!(miner_in("wget https://github.com/xmrig/xmrig/releases/x.tar.gz"), Some("xmrig"));
        assert_eq!(miner_in("./a.out -o stratum+tcp://pool:4444 -u wallet"), Some("stratum+tcp://"));
        assert_eq!(miner_in("./run --donate-level 1"), Some("--donate-level"));
        assert_eq!(miner_in("./m -o gulf.moneroocean.stream:10128"), Some("moneroocean.stream"));
        assert_eq!(miner_in("nohup /tmp/t-rex -a kawpow"), Some("t-rex"));
        assert_eq!(miner_in("CPUMINER --algo=sha256d"), Some("cpuminer"));
    }

    #[test]
    fn ordinary_commands_are_not_miners() {
        for command in [
            "cargo build --release",
            "npm test",
            "git log --oneline",
            "cat docs/t-rex.md",
            "grep -r stratum src/",
            "python3 -m pytest -k mining_model",
            "go test ./...",
            "rg gminer_config",
        ] {
            assert_eq!(miner_in(command), None, "{command}");
        }
    }

    #[test]
    fn proc_files_read_as_the_kernel_writes_them() {
        let stat = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 100 0 50 800 50 0 0 0 0 0\n";
        assert_eq!(parse_cpu(stat), Some((150, 1000)));
        let dev = "Inter-|   Receive\n face |bytes\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 2 0 0 0 0 0 0 500 3 0 0 0 0 0 0\n";
        assert_eq!(parse_net(dev), 1500);
        let disks = "   8       0 sda 10 0 100 0 5 0 50 0 0 0 0\n   8       1 sda1 10 0 100 0 5 0 50 0 0 0 0\n   7       0 loop0 1 0 8 0 0 0 0 0 0 0 0\n 259 0 nvme0n1 1 0 2 0 1 0 2 0 0 0 0\n 259 1 nvme0n1p1 1 0 2 0 1 0 2 0 0 0 0\n";
        assert_eq!(parse_disks(disks), (150 + 4) * 512);
        let proc_stat = "42 (my (odd) name) R 1 42 42 0 -1 4194304 100 0 0 0 700 300 0 0 20 0 1 0 1000";
        assert_eq!(parse_proc_stat(proc_stat), Some(("my (odd) name".to_owned(), 1000)));
        assert_eq!(parse_proc_io("rchar: 100\nwchar: 50\nsyscr: 3\nread_bytes: 4096\n"), 150);
    }
}
