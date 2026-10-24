//! `g1t cycle`: a workspace's cycles, the one- or two-week time boxes
//! whose unfinished work carries over. Showing the current cycle or a past
//! one with its report, listing them, moving a work item into the current
//! cycle or the coming one, and the workspace's cycle settings.
//!
//! A cycle is its workspace's: `--workspace`, or the current repository's.
//! The current cycle's page is `{site}/{workspace}/-/work/cycle`, a past
//! one's `{site}/{workspace}/-/work/cycles/{number}`.

use serde_json::Value;

use crate::cli::{CycleAddArgs, CycleArgs, CycleCommand, CycleListArgs, CycleRemoveArgs, CycleSettingsArgs, CycleViewArgs};
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{Cell, Output, s};

use super::work::{Place, place};

pub fn run(ctx: &Ctx, args: CycleArgs) -> Result<()> {
    let workspace = args.workspace.as_deref();
    match args.command.unwrap_or(CycleCommand::View(CycleViewArgs { number: None, web: false })) {
        CycleCommand::View(args) => view(ctx, workspace, args),
        CycleCommand::List(args) => list(ctx, workspace, args),
        CycleCommand::Add(args) => add(ctx, workspace, args),
        CycleCommand::Remove(args) => remove(ctx, workspace, args),
        CycleCommand::Settings(args) => settings(ctx, workspace, args),
    }
}

/// A cycle's page on the site: the current one's, or a numbered one's.
fn cycle_url(place: &Place, number: Option<u64>) -> String {
    match number {
        Some(number) => format!("{}/{}/-/work/cycles/{number}", place.client.host.site, place.workspace),
        None => format!("{}/{}/-/work/cycle", place.client.host.site, place.workspace),
    }
}

/// The weekday of an ISO number, as people say it.
fn weekday(number: u64) -> &'static str {
    match number {
        1 => "Monday",
        2 => "Tuesday",
        3 => "Wednesday",
        4 => "Thursday",
        5 => "Friday",
        6 => "Saturday",
        7 => "Sunday",
        _ => "",
    }
}

/// `monday`, `Mon`, `1`: an ISO weekday.
fn weekday_number(given: &str) -> Result<u32> {
    let name = given.trim().to_ascii_lowercase();
    if let Ok(number) = name.parse::<u32>() {
        if (1..=7).contains(&number) {
            return Ok(number);
        }
    } else if name.len() >= 2
        && let Some(number) = (1..=7u32).find(|n| weekday(u64::from(*n)).to_ascii_lowercase().starts_with(&name))
    {
        return Ok(number);
    }
    Err(Error::usage("--start-day is a day of the week: monday to sunday."))
}

/// "Cycle 14 · Oct 19 – Nov 1 · running", from a cycle as the API gives it.
fn headline(out: &Output, cycle: &Value) -> String {
    let number = cycle["number"].as_u64().unwrap_or_default();
    let state = s(cycle, "state");
    let state = match state {
        "running" => out.green("running"),
        "upcoming" => out.yellow("upcoming"),
        other => out.dim(other),
    };
    format!("{} · {} – {} · {state}", out.bold(&format!("Cycle {number}")), s(cycle, "starts_on"), s(cycle, "ends_on"))
}

/// "9 of 14 done · 3 carried in · 2 added".
fn counts(cycle: &Value) -> String {
    let n = |key: &str| cycle[key].as_u64().unwrap_or_default();
    let mut parts = vec![format!("{} of {} done", n("done"), n("scope"))];
    if n("carried_in") > 0 {
        parts.push(format!("{} carried in", n("carried_in")));
    }
    if n("added") > 0 {
        parts.push(format!("{} added mid-cycle", n("added")));
    }
    if n("carried_out") > 0 {
        parts.push(format!("{} carried out", n("carried_out")));
    }
    parts.join(" · ")
}

fn view(ctx: &Ctx, workspace: Option<&str>, args: CycleViewArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    let url = cycle_url(&place, args.number.map(u64::from));
    if args.web {
        return super::browse::open(ctx, &url);
    }
    let asked = args.number.map_or_else(|| "current".to_owned(), |number| number.to_string());
    let mut detail = place.client.op("get_cycle").arg("workspace", &place.workspace).arg("cycle", asked).send()?;
    detail["url"] = Value::String(url.clone());
    if ctx.out.structured() {
        return ctx.out.emit(&detail);
    }
    let out = &ctx.out;
    let cycle = &detail["cycle"];
    println!("{}", headline(out, cycle));
    println!("{}", counts(cycle));
    let items = detail["items"].as_array().cloned().unwrap_or_default();
    let members = detail["members"].as_array().cloned().unwrap_or_default();
    let member = |number: u64| members.iter().find(|m| m["number"].as_u64() == Some(number));
    let closed = s(cycle, "state") == "closed";
    type Wanted<'a> = Box<dyn Fn(&Value) -> bool + 'a>;
    let sections: [(&str, Wanted); 3] = [
        (
            "Open",
            Box::new(|item: &Value| {
                s(item, "state") == "open" && !member(item["number"].as_u64().unwrap_or_default()).is_some_and(|m| m["carried_out"] == true)
            }),
        ),
        ("Done", Box::new(|item: &Value| s(item, "state") == "closed" && item["cycle"] == cycle["number"])),
        (
            "Carried out",
            Box::new(|item: &Value| member(item["number"].as_u64().unwrap_or_default()).is_some_and(|m| m["carried_out"] == true)),
        ),
    ];
    for (title, wanted) in &sections {
        let shown: Vec<&Value> = items.iter().filter(|item| wanted(item)).collect();
        if shown.is_empty() && (closed || *title == "Carried out") {
            continue;
        }
        println!();
        println!("{}", out.bold(title));
        if shown.is_empty() {
            println!("  {}", out.dim("None."));
        }
        for item in shown {
            let number = item["number"].as_u64().unwrap_or_default();
            let mut notes = Vec::new();
            if let Some(m) = member(number) {
                if m["carried_in"] == true {
                    notes.push("carried in");
                }
                if m["added"] == true {
                    notes.push("added mid-cycle");
                }
            }
            let assignees: Vec<&str> =
                item["assignees"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            let who = if assignees.is_empty() { String::new() } else { format!(" {}", out.dim(&assignees.join(", "))) };
            let notes = if notes.is_empty() { String::new() } else { format!("  {}", out.dim(&notes.join(" · "))) };
            println!("  {} {}{who}{notes}", out.green(&format!("#{number}")), s(item, "title"));
        }
    }
    let planned = detail["planned"].as_array().cloned().unwrap_or_default();
    if let Some(next) = detail["next"].as_object() {
        println!();
        let number = next.get("number").and_then(Value::as_u64).unwrap_or_default();
        let starts = next.get("starts_on").and_then(Value::as_str).unwrap_or_default();
        println!("{} {}", out.bold(&format!("Planned into Cycle {number}")), out.dim(&format!("from {starts}")));
        if planned.is_empty() {
            println!("  {}", out.dim("Nothing yet: g1t cycle add N --next."));
        }
        for item in &planned {
            println!("  {} {}", out.green(&format!("#{}", item["number"].as_u64().unwrap_or_default())), s(item, "title"));
        }
    }
    println!();
    println!("{}", out.dim(&url));
    Ok(())
}

fn list(ctx: &Ctx, workspace: Option<&str>, args: CycleListArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    let found = place.client.op("list_cycles").arg("workspace", &place.workspace).query("limit", args.limit.min(100)).send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    let out = &ctx.out;
    if found["settings"]["enabled"] != true && found["past"].as_array().is_none_or(Vec::is_empty) {
        eprintln!("Cycles are off in {}. Turn them on with g1t cycle settings --on.", place.workspace);
        return Ok(());
    }
    let mut cycles: Vec<Value> = Vec::new();
    if let Some(current) = found["current"].as_object() {
        cycles.push(Value::Object(current.clone()));
    }
    cycles.extend(found["past"].as_array().cloned().unwrap_or_default());
    let rows: Vec<Vec<Cell>> = cycles
        .iter()
        .map(|c| {
            let n = |key: &str| c[key].as_u64().unwrap_or_default();
            let state = s(c, "state").to_owned();
            let styled = match state.as_str() {
                "running" => out.green(&state),
                "upcoming" => out.yellow(&state),
                _ => out.dim(&state),
            };
            vec![
                Cell::styled(n("number").to_string(), out.bold(&n("number").to_string())),
                Cell::styled(state, styled),
                Cell::new(format!("{} – {}", s(c, "starts_on"), s(c, "ends_on"))),
                Cell::new(format!("{}/{}", n("done"), n("scope"))),
                Cell::new(n("carried_in").to_string()),
                Cell::new(n("added").to_string()),
                Cell::new(n("carried_out").to_string()),
            ]
        })
        .collect();
    out.table(&["cycle", "state", "days", "done", "carried in", "added", "carried out"], &rows)?;
    if let Some(next) = found["next"].as_object() {
        let number = next.get("number").and_then(Value::as_u64).unwrap_or_default();
        let starts = next.get("starts_on").and_then(Value::as_str).unwrap_or_default();
        eprintln!("{}", out.dim(&format!("Cycle {number} starts on {starts}.")));
    }
    Ok(())
}

/// Moves work item `number` into `cycle` (current, next or none).
fn move_to(ctx: &Ctx, workspace: Option<&str>, number: u32, cycle: &str, said: &str) -> Result<()> {
    let place = place(ctx, workspace)?;
    let moved = place.client.op("cycle_work_item").arg("workspace", &place.workspace).arg("number", number).field("cycle", cycle).send()?;
    let at = moved["cycle"].as_u64().map(|n| format!("Cycle {n}")).unwrap_or_else(|| "no cycle".to_owned());
    super::done(ctx, &moved, &format!("{said} #{number}: {at}, {}", s(&moved, "horizon")), &place.url(u64::from(number)))
}

fn add(ctx: &Ctx, workspace: Option<&str>, args: CycleAddArgs) -> Result<()> {
    if args.next {
        move_to(ctx, workspace, args.number, "next", "Planned")
    } else {
        move_to(ctx, workspace, args.number, "current", "Moved")
    }
}

fn remove(ctx: &Ctx, workspace: Option<&str>, args: CycleRemoveArgs) -> Result<()> {
    move_to(ctx, workspace, args.number, "none", "Took out")
}

fn settings(ctx: &Ctx, workspace: Option<&str>, args: CycleSettingsArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    if args.length.is_some_and(|length| length != 7 && length != 14) {
        return Err(Error::usage("--length is 7 or 14 days."));
    }
    let start = args.start_day.as_deref().map(weekday_number).transpose()?;
    let changing = args.on || args.off || args.length.is_some() || start.is_some() || args.cooldown.is_some();
    let found = if changing {
        let mut call = place.client.op("configure_cycles").arg("workspace", &place.workspace);
        if args.on || args.off {
            call = call.field("enabled", args.on);
        }
        call.field_opt("length_days", args.length).field_opt("starts_weekday", start).field_opt("cooldown_days", args.cooldown).send()?
    } else {
        place.client.op("list_cycles").arg("workspace", &place.workspace).query("limit", 0).send()?
    };
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    let out = &ctx.out;
    let settings = &found["settings"];
    let on = settings["enabled"] == true;
    let length = settings["length_days"].as_u64().unwrap_or(14);
    let cooldown = settings["cooldown_days"].as_u64().unwrap_or_default();
    if changing {
        eprintln!("{} Saved {}'s cycles", out.green("✓"), place.workspace);
    }
    println!(
        "Cycles {} · {} days · start on {} · {}",
        if on { out.green("on") } else { out.dim("off") },
        length,
        weekday(settings["starts_weekday"].as_u64().unwrap_or(1)),
        if cooldown == 0 { "no cooldown".to_owned() } else { format!("{cooldown} days of cooldown") }
    );
    if let Some(current) = found["current"].as_object() {
        println!("{}", headline(out, &Value::Object(current.clone())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_of_the_week_read_as_people_write_them() {
        assert_eq!(weekday_number("monday").unwrap(), 1);
        assert_eq!(weekday_number("Fri").unwrap(), 5);
        assert_eq!(weekday_number("7").unwrap(), 7);
        assert!(weekday_number("m").is_err());
        assert!(weekday_number("8").is_err());
        assert!(weekday_number("someday").is_err());
        assert_eq!(weekday(3), "Wednesday");
    }

    #[test]
    fn a_cycle_reads_in_a_line() {
        let cycle = serde_json::json!({ "done": 9, "scope": 14, "carried_in": 3, "added": 2, "carried_out": 0 });
        assert_eq!(counts(&cycle), "9 of 14 done · 3 carried in · 2 added mid-cycle");
    }
}
