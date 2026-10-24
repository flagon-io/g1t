//! Which of g1t's machines this runner takes jobs for: a job whose
//! `runs-on` asks for one (`ubuntu-latest`) is offered to the workspace's
//! own runners first, and one that takes that machine's size runs it in a
//! sandbox of exactly that size, or of more where it says so
//! (`g1t_contracts::runners`, "Sizes").
//!
//! The configuration keeps a size as its machine's key, or as its key with
//! what its jobs get:
//!
//! ```json
//! "sizes": ["1-core", { "size": "2-core", "cpus": 4, "memory": "16g" }]
//! ```
//!
//! and `--sizes 1-core,2-core:4:16g` says the same. A runner told nothing
//! takes the one size `picked_size` chooses (Standard if it fits in half
//! the machine, else Small), and keeps that choice (`sizes_picked`) until
//! someone changes it. The desktop app's sandbox passes its sizes in
//! [`SIZES_ENV`], and the computer it is on in [`COMPUTER_ENV`].

use anyhow::{Result, anyhow, bail};
use g1t_contracts::runners::{self as model, Machine, OfferedSize, Room};
use serde::{Deserialize, Serialize};

use super::config::Config;
use super::sandbox::Isolation;

/// The sizes the runner takes, from the desktop app's sandbox: JSON, a list
/// of [`SizeChoice`]. Over the configuration's.
pub const SIZES_ENV: &str = "G1T_RUNNER_SIZES";
/// The computer a sandboxed runner is on, `<cpus>,<MiB>`: the runner sees
/// only its sandbox's share, and leaves half of the computer to the person.
pub const COMPUTER_ENV: &str = "G1T_RUNNER_COMPUTER";

/// A size as the configuration keeps it: its machine's key, or its key with
/// what a job taken for it gets (at least the size; more is the person's
/// call).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SizeChoice {
    Key(String),
    Given {
        size: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cpus: Option<f64>,
        /// As `--memory` takes it: `16g`, `12288m`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        memory: Option<String>,
    },
}

impl SizeChoice {
    /// What the runner says of it to g1t, refused when it is not one of
    /// g1t's machines or gives less than the size.
    pub fn offered(&self) -> Result<OfferedSize> {
        let offered = match self {
            SizeChoice::Key(size) => OfferedSize::of(size.trim()),
            SizeChoice::Given { size, cpus, memory } => {
                let memory_mib = match memory {
                    Some(text) => Some(super::exec::mib(text).ok_or_else(|| anyhow!("a size's memory is a size such as 16g, not {text}"))?),
                    None => None,
                };
                OfferedSize { size: size.trim().to_owned(), cpus: *cpus, memory_mib }
            }
        };
        offered.check().map_err(|why| anyhow!(why))?;
        let key = model::size_named(&offered.size).map_or(offered.size.clone(), |size| size.machine.to_owned());
        Ok(OfferedSize { size: key, ..offered })
    }
}

/// `1-core,2-core:4:16g`: each size its key, then its jobs' CPUs and
/// memory where they get more (`2-core::16g` for memory alone). Empty for
/// no sizes.
pub fn parse_list(text: &str) -> Result<Vec<SizeChoice>> {
    let mut out: Vec<SizeChoice> = Vec::new();
    for item in text.split(',').map(str::trim).filter(|i| !i.is_empty()) {
        let mut parts = item.split(':').map(str::trim);
        let size = parts.next().unwrap_or_default().to_owned();
        let cpus = match parts.next().filter(|c| !c.is_empty()) {
            Some(text) => Some(text.parse::<f64>().map_err(|_| anyhow!("{item}: a size's CPUs are a number, such as 4"))?),
            None => None,
        };
        let memory = parts.next().filter(|m| !m.is_empty()).map(str::to_owned);
        if parts.next().is_some() {
            bail!("{item}: a size is its key, then its CPUs and memory, such as 2-core:4:16g");
        }
        let choice = if cpus.is_none() && memory.is_none() { SizeChoice::Key(size) } else { SizeChoice::Given { size, cpus, memory } };
        choice.offered()?;
        out.push(choice);
    }
    Ok(out)
}

/// What the runner says it takes: each choice checked, each size once,
/// smallest first.
pub fn offered(choices: &[SizeChoice]) -> Result<Vec<OfferedSize>> {
    let said = choices.iter().map(SizeChoice::offered).collect::<Result<Vec<_>>>()?;
    Ok(model::kept_sizes(&said))
}

/// What the runner tells g1t it takes on `machine`: [`offered`], each with
/// the memory its jobs get there where the sandbox has less than the size,
/// down to its least ([`model::fitted`]).
pub fn offered_on(choices: &[SizeChoice], machine: Machine) -> Result<Vec<OfferedSize>> {
    Ok(offered(choices)?.iter().map(|offered| model::fitted(offered, machine)).collect())
}

/// The sizes the runner's configuration holds, or the desktop app's
/// sandbox passed it.
pub fn chosen(config: &Config) -> Option<Vec<SizeChoice>> {
    from_env().or_else(|| config.sizes.clone())
}

fn from_env() -> Option<Vec<SizeChoice>> {
    let text = std::env::var(SIZES_ENV).ok().filter(|t| !t.trim().is_empty())?;
    serde_json::from_str(&text).ok()
}

/// The machine this runner's jobs run on, as it sees it: its CPUs and
/// memory (in a container, the container's), and, for the desktop app's
/// sandbox, the computer it is a share of.
pub fn machine(isolation: Isolation) -> Machine {
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get()) as u32;
    let memory_mib = super::launcher::total_memory_mib().unwrap_or(4096);
    // A container's limit, where /proc/meminfo says the whole VM's.
    let memory_mib = std::fs::read_to_string("/sys/fs/cgroup/memory.max")
        .ok()
        .and_then(|text| cgroup_limit_mib(&text))
        .map_or(memory_mib, |limit| limit.min(memory_mib));
    let here = Machine { cpus, memory_mib, share: None };
    match (isolation, computer()) {
        (Isolation::Host, _) | (_, None) => here,
        (_, Some((cpus_there, memory_there))) => {
            Machine { cpus: cpus_there, memory_mib: memory_there, share: Some(Room { cpus: f64::from(cpus), memory_mib }) }
        }
    }
}

/// A cgroup's `memory.max` in MiB; none for `max`, no limit.
fn cgroup_limit_mib(text: &str) -> Option<u64> {
    text.trim().parse::<u64>().ok().map(|bytes| bytes >> 20).filter(|mib| *mib > 0)
}

/// [`COMPUTER_ENV`], when it is one.
fn computer() -> Option<(u32, u64)> {
    let text = std::env::var(COMPUTER_ENV).ok()?;
    let (cpus, memory) = text.split_once(',')?;
    Some((cpus.trim().parse().ok().filter(|c| *c > 0)?, memory.trim().parse().ok().filter(|m| *m > 0)?))
}

/// The one size a runner told nothing takes: Standard, else Small, else
/// none (`picked_size`).
pub fn pick(machine: Machine) -> Vec<SizeChoice> {
    model::picked_size(machine).map(|size| SizeChoice::Key(size.machine.to_owned())).into_iter().collect()
}

/// Gives a runner told nothing the size picked for it, once, and keeps it
/// in its configuration (`sizes_picked`), so it stays the same and the
/// person sees it chosen. Whether the configuration changed.
pub fn settle(config: &mut Config, machine: Machine) -> bool {
    if config.sizes.is_some() || from_env().is_some() {
        return false;
    }
    config.sizes = Some(pick(machine));
    config.sizes_picked = true;
    true
}

/// What `g1t-runner sizes --json` and the sandbox's status say of the
/// sizes: the machine, what is taken, and each size with what it would
/// cost. The desktop app shows it as its settings' sizes.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SizesView {
    /// When a change counts: `poll` (from the runner's next poll) or
    /// `restart` (the desktop app's sandbox: when its runner starts again,
    /// after the job it is running).
    pub applies: String,
    /// The machine's CPUs and memory, and the sandbox's share of it.
    pub machine: RoomView,
    #[serde(default)]
    pub share: Option<RoomView>,
    /// The sizes were chosen for the person (`picked_size`), not by them.
    pub picked: bool,
    /// Why that choice: `Standard fits in half this machine's 8 CPUs and 16 GB.`
    #[serde(default)]
    pub reason: Option<String>,
    pub choices: Vec<SizeView>,
    /// The desktop app's sandbox: the most its share can be, the VM it runs
    /// in where the launcher can tell (WSL's, on Windows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<RoomView>,
    /// What the share costs the computer, when it may hurt
    /// (`share_warning`): shown, never a refusal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_warning: Option<String>,
    /// The share can be changed (`g1t-runner sandbox resources`): launchers
    /// before 0.3.7 leave it out, and the app then shows it only.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub share_settable: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RoomView {
    pub cpus: f64,
    pub memory_mib: u64,
}

impl From<Room> for RoomView {
    fn from(room: Room) -> RoomView {
        RoomView { cpus: room.cpus, memory_mib: room.memory_mib }
    }
}

/// One of g1t's machines, as a size this runner takes or could.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SizeView {
    /// `2-core`.
    pub size: String,
    /// `Standard`.
    pub name: String,
    /// `2 vCPU · 8 GB`: the size, and the least a job of it gets.
    pub spec: String,
    pub vcpu: f64,
    pub memory_mib: u64,
    /// The least memory its jobs run with where the sandbox has less.
    #[serde(default)]
    pub least_memory_mib: u64,
    pub offered: bool,
    /// What its jobs get where that is more than the size.
    #[serde(default)]
    pub given_cpus: Option<f64>,
    #[serde(default)]
    pub given_memory_mib: Option<u64>,
    /// What a job taken for it gets: `4 vCPU · 16 GB`.
    pub sandbox: String,
    /// What offering it costs the machine, when it may hurt
    /// (`memory_warning`, `size_warning`): shown, and never a refusal.
    #[serde(default)]
    pub warning: Option<String>,
}

/// The sizes, as [`SizesView`] says them, for `taken` (what the runner
/// takes now) on `machine`. Each says what its jobs would get there, a
/// size not taken too, so a warning shows before it is ticked.
pub fn view(machine: Machine, taken: &[OfferedSize], picked: bool, applies: &str) -> SizesView {
    let choices = model::sizes()
        .into_iter()
        .map(|size| {
            let offered = taken.iter().find(|o| o.size == size.machine);
            let fitted = model::fitted(&offered.cloned().unwrap_or_else(|| OfferedSize::of(size.machine)), machine);
            let sandbox = fitted.sandbox().unwrap_or_else(|| size.room());
            SizeView {
                size: size.machine.to_owned(),
                name: size.name.to_owned(),
                spec: size.room().spec(),
                vcpu: size.vcpu,
                memory_mib: size.room().memory_mib,
                least_memory_mib: size.least().memory_mib,
                offered: offered.is_some(),
                given_cpus: offered.and_then(|o| o.cpus),
                given_memory_mib: offered.and_then(|o| o.memory_mib),
                sandbox: sandbox.spec(),
                warning: model::memory_warning(&fitted).or_else(|| model::size_warning(machine, sandbox)),
            }
        })
        .collect();
    SizesView {
        applies: applies.to_owned(),
        machine: machine.room().into(),
        share: machine.share.map(RoomView::from),
        picked,
        reason: picked.then(|| model::pick_reason(machine)),
        choices,
        ..SizesView::default()
    }
}

/// `g1t-runner sizes` for people: the machine, then each size.
pub fn print(view: &SizesView) {
    let machine = Machine { cpus: view.machine.cpus as u32, memory_mib: view.machine.memory_mib, share: None };
    let mut line = format!("This machine: {}", machine.words());
    if let Some(share) = view.share {
        line.push_str(&format!(", of which jobs have {} vCPU and {}", share.cpus, model::gb(share.memory_mib)));
    }
    println!("{line}.");
    if view.picked {
        println!("Chosen for you: {}", view.reason.as_deref().unwrap_or_default());
    }
    for size in &view.choices {
        let mark = if size.offered { "[x]" } else { "[ ]" };
        let mut line = format!("  {mark} {:8} {:9} {}", size.size, size.name, size.spec);
        if size.offered && size.sandbox != size.spec {
            line.push_str(&format!(", its jobs get {}", size.sandbox));
        }
        println!("{line}");
        if let Some(warning) = &size.warning {
            println!("               {warning}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_size_is_its_key_or_its_key_with_what_its_jobs_get() {
        let choices: Vec<SizeChoice> = serde_json::from_str(r#"["1-core", { "size": "2-core", "cpus": 4, "memory": "16g" }]"#).unwrap();
        assert_eq!(choices, parse_list("1-core, 2-core:4:16g").unwrap());
        assert_eq!(
            offered(&choices).unwrap(),
            vec![OfferedSize::of("1-core"), OfferedSize { size: "2-core".into(), cpus: Some(4.0), memory_mib: Some(16 * 1024) }]
        );
        assert_eq!(
            parse_list("2-core::12g").unwrap(),
            vec![SizeChoice::Given { size: "2-core".into(), cpus: None, memory: Some("12g".into()) }]
        );
        assert_eq!(parse_list("").unwrap(), vec![]);
        assert_eq!(serde_json::to_string(&choices).unwrap(), r#"["1-core",{"size":"2-core","cpus":4.0,"memory":"16g"}]"#);
    }

    #[test]
    fn less_than_a_size_is_refused() {
        assert!(parse_list("2-core:1").unwrap_err().to_string().contains("at least 2 vCPU"));
        assert!(parse_list("2-core::4g").unwrap_err().to_string().contains("at least 6 GB"));
        assert_eq!(parse_list("2-core::7g").unwrap().len(), 1, "less than the size, down to its least");
        assert!(parse_list("16-core").unwrap_err().to_string().contains("not a size"));
        assert!(parse_list("2-core:x").is_err());
    }

    #[test]
    fn a_runner_told_nothing_keeps_the_size_picked_for_it() {
        let dir = std::env::temp_dir();
        let mut config: Config = serde_json::from_value(serde_json::json!({
            "url": "https://g1t.sh", "api": "https://api.g1t.sh", "runner": "rnr_1", "name": "a", "credential": "c",
            "workspace": "acme", "labels": [], "work_dir": dir
        }))
        .unwrap();
        let roomy = Machine { cpus: 8, memory_mib: 16 * 1024, share: None };
        assert!(settle(&mut config, roomy));
        assert_eq!(config.sizes, Some(vec![SizeChoice::Key("2-core".into())]));
        assert!(config.sizes_picked);
        // Kept: a later start on a smaller machine changes nothing.
        assert!(!settle(&mut config, Machine { cpus: 2, memory_mib: 4096, share: None }));
        // A machine too small for Small, even at its least, takes none, and says why.
        let small = Machine { cpus: 2, memory_mib: 4 * 1024, share: None };
        assert_eq!(pick(small), vec![]);
        let said = view(small, &[], true, "poll");
        assert!(said.reason.unwrap().contains("Small needs"));
    }

    #[test]
    fn the_view_warns_for_a_size_more_than_half_the_machine() {
        let machine = Machine { cpus: 8, memory_mib: 16 * 1024, share: None };
        let taken = [OfferedSize::of("2-core"), OfferedSize { size: "4-core".into(), cpus: Some(8.0), memory_mib: Some(16 * 1024) }];
        let said = view(machine, &taken, false, "poll");
        let names: Vec<(&str, bool)> = said.choices.iter().map(|c| (c.name.as_str(), c.offered)).collect();
        assert_eq!(names, [("Small", false), ("Standard", true), ("Large", true)]);
        assert_eq!(said.choices[1].warning, None);
        assert_eq!(said.choices[2].sandbox, "8 vCPU · 16 GB");
        assert!(said.choices[2].warning.as_deref().unwrap().contains("More than half this machine's"));
        assert_eq!(said.reason, None);
    }

    #[test]
    fn a_containers_memory_limit_is_read_from_its_cgroup() {
        assert_eq!(
            cgroup_limit_mib(
                "8589934592
"
            ),
            Some(8192)
        );
        assert_eq!(
            cgroup_limit_mib(
                "max
"
            ),
            None
        );
        assert_eq!(cgroup_limit_mib(""), None);
    }

    #[test]
    fn a_size_the_sandbox_holds_only_at_its_least_runs_with_what_it_has_and_says_so() {
        let sandbox = Machine { cpus: 32, memory_mib: 64 * 1024, share: Some(Room { cpus: 8.0, memory_mib: 8 * 1024 }) };
        let chosen = parse_list("2-core,4-core").unwrap();
        let told = offered_on(&chosen, sandbox).unwrap();
        assert_eq!(told, vec![OfferedSize::of("2-core"), OfferedSize { size: "4-core".into(), cpus: None, memory_mib: Some(8 * 1024) }]);
        let said = view(sandbox, &offered(&chosen).unwrap(), false, "restart");
        assert_eq!(said.choices[1].warning, None, "Standard fits whole");
        assert_eq!(said.choices[2].sandbox, "4 vCPU · 8 GB");
        assert_eq!(said.choices[2].given_memory_mib, None, "the person gave it nothing");
        assert!(said.choices[2].warning.as_deref().unwrap().starts_with("Runs with 8 GB instead of 12 GB"));
        assert_eq!(said.choices[2].least_memory_mib, 8 * 1024);
    }
}
