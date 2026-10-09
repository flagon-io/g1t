//! Cloudflare's billing cycle, and what g1t's usage costs over it.
//!
//! Cloudflare bills usage per billing cycle, a month from the day the
//! account's subscription renews (for g1t's account, the 28th: Sep 28 to
//! Oct 27), and each meter's included amount ("first 30M are included") is
//! the account's, once per cycle, not per day or per product. So a day's
//! cost depends on every day before it in the cycle: the cost lands on the
//! day the cycle's running total passes the included amount, and on every
//! day after, as on Cloudflare's own Billable usage page.
//!
//! Cloudflare's billable-usage lines carry no cost while a cycle is open
//! (seen 2026-10-08: every line $0 while the dashboard showed $0.29), so
//! the cost of each meter is the list price past the included amount,
//! applied here over the cycle; where Cloudflare does put a cost on a
//! meter's lines in a cycle, that cost is taken instead, as it is.
//!
//! Meters priced per million (requests, CPU ms, rows, operations) are billed
//! in whole millions: 9.16M CPU ms past the included 30M is billed as 10M,
//! $0.20, which is what Cloudflare's page showed on 2026-10-09.

use std::collections::BTreeMap;

use crate::costs::{CostLine, SOURCE_BILLABLE, days_between};

/// Where a line's cost came from.
pub(crate) const BASIS_CLOUDFLARE: &str = "cloudflare";
pub(crate) const BASIS_LIST: &str = "list";
pub(crate) const BASIS_NONE: &str = "none";

/// g1t's account renews on the 28th; `CLOUDFLARE_BILLING_DAY` says so
/// until Cloudflare's subscriptions have been read.
pub(crate) const DEFAULT_ANCHOR: u32 = 1;

/// A billing cycle: its first and last days, YYYY-MM-DD, inclusive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Cycle {
    pub start: String,
    pub end: String,
}

impl Cycle {
    pub fn days(&self) -> u32 {
        days_between(&self.start, &self.end).len() as u32
    }

    /// Days from its start to `day`, both included (at most all of them).
    pub fn days_elapsed(&self, day: &str) -> u32 {
        let until = if day > self.end.as_str() { self.end.as_str() } else { day };
        days_between(&self.start, until).len() as u32
    }

    pub fn previous(&self, anchor: u32) -> Cycle {
        cycle_of(&shift(&self.start, -1), anchor)
    }
}

fn ymd(day: &str) -> Option<(i32, u32, u32)> {
    let mut parts = day.get(..10)?.splitn(3, '-');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn add_months(year: i32, month: u32, delta: i32) -> (i32, u32) {
    let index = year * 12 + month as i32 - 1 + delta;
    (index.div_euclid(12), index.rem_euclid(12) as u32 + 1)
}

/// `day` moved by `by` days.
fn shift(day: &str, by: i64) -> String {
    let ms = g1t_contracts::time::parse_rfc3339(&format!("{}T00:00:00Z", &day[..10.min(day.len())])).unwrap_or(0) as i64;
    g1t_contracts::time::rfc3339((ms + by * crate::costs::DAY_MS as i64).max(0) as u64)[..10].to_owned()
}

/// The cycle `day` is in, for a cycle that starts on day `anchor` of each
/// month (the month's last day where it has fewer).
pub(crate) fn cycle_of(day: &str, anchor: u32) -> Cycle {
    let anchor = anchor.clamp(1, 31);
    let Some((year, month, date)) = ymd(day) else {
        return Cycle { start: day.to_owned(), end: day.to_owned() };
    };
    let (sy, sm) = if date >= anchor.min(days_in_month(year, month)) { (year, month) } else { add_months(year, month, -1) };
    let (ny, nm) = add_months(sy, sm, 1);
    let start = format!("{sy:04}-{sm:02}-{:02}", anchor.min(days_in_month(sy, sm)));
    let next = format!("{ny:04}-{nm:02}-{:02}", anchor.min(days_in_month(ny, nm)));
    Cycle { start, end: shift(&next, -1) }
}

/// The day of the month a cycle starts on, from a subscription's
/// `current_period_start`.
pub(crate) fn anchor_of(period_start: &str) -> Option<u32> {
    ymd(period_start).map(|(_, _, d)| d).filter(|d| (1..=31).contains(d))
}

/// The days to read the bill for: the current cycle, and the one before
/// while it may still be restated (its first `restate_days` days) or when
/// nothing has been read yet. Whole cycles, so the included amounts are
/// applied to all of a cycle's usage.
pub(crate) fn bill_since(today: &str, anchor: u32, restate_days: u32, first: bool) -> String {
    let current = cycle_of(today, anchor);
    if first || current.days_elapsed(today) <= restate_days {
        current.previous(anchor).start
    } else {
        current.start
    }
}

/// A meter's list price, with what each cycle includes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ListPrice {
    /// Cloudflare's product and a meter prefix, as `costs::slug` makes them.
    pub product: &'static str,
    pub meter: &'static str,
    /// Included each cycle (or each day, `daily`), in the meter's units.
    pub included: f64,
    /// Dollars per `per` units.
    pub usd: f64,
    pub per: f64,
    /// Billed in whole blocks of `per` (the per-million meters).
    pub whole: bool,
    /// The included amount is a day's (Workers AI), not a cycle's.
    pub daily: bool,
}

impl ListPrice {
    /// What is past the included amount, of `used`.
    pub fn over(&self, used: f64) -> f64 {
        (used - self.included).max(0.0)
    }

    /// What `used` units cost in one cycle (or day).
    pub fn cost(&self, used: f64) -> f64 {
        let over = self.over(used);
        if over <= 0.0 {
            return 0.0;
        }
        let blocks = over / self.per;
        // A float sum of a whole number of units must not round up a block.
        let blocks = if self.whole { (blocks - 1e-9).ceil().max(1.0) } else { blocks };
        blocks * self.usd
    }
}

const fn price(product: &'static str, meter: &'static str, included: f64, usd: f64, per: f64, whole: bool) -> ListPrice {
    ListPrice { product, meter, included, usd, per, whole, daily: false }
}

const M: f64 = 1_000_000.0;

/// Cloudflare's list prices on Workers Paid, as published (checked
/// 2026-10-09 against the Billable usage page: Workers CPU and Containers
/// memory to the cent). A meter not here is costed at $0 and shown as
/// having no list price, until Cloudflare's lines carry its cost or a price
/// is added here. Containers: vCPU-seconds, GiB-seconds and GB-seconds;
/// storage in GB-months.
pub(crate) const LIST_PRICES: &[ListPrice] = &[
    price("workers", "workers_standard_requests", 10.0 * M, 0.30, M, true),
    price("workers", "workers_cpu_ms", 30.0 * M, 0.02, M, true),
    price("workers", "workers_for_platforms_requests", 20.0 * M, 0.30, M, true),
    price("workers", "workers_for_platforms_cpu_ms", 60.0 * M, 0.02, M, true),
    price("workers", "workers_for_platforms_scripts", 1_000.0, 0.02, 1.0, false),
    price("workers", "workers_logs", 20.0 * M, 0.60, M, true),
    price("workers_for_platforms", "workers_for_platforms_requests", 20.0 * M, 0.30, M, true),
    price("workers_for_platforms", "workers_for_platforms_cpu_ms", 60.0 * M, 0.02, M, true),
    price("workers_for_platforms", "workers_for_platforms_scripts", 1_000.0, 0.02, 1.0, false),
    price("d1", "d1_rows_read", 25_000.0 * M, 0.001, M, true),
    price("d1", "d1_rows_written", 50.0 * M, 1.00, M, true),
    price("d1", "d1_storage", 5.0, 0.75, 1.0, false),
    price("workers_kv", "kv_read_operations", 10.0 * M, 0.50, M, true),
    price("workers_kv", "kv_write_operations", M, 5.00, M, true),
    price("workers_kv", "kv_list_operations", M, 5.00, M, true),
    price("workers_kv", "kv_delete_operations", M, 5.00, M, true),
    price("workers_kv", "kv_storage", 1.0, 0.50, 1.0, false),
    price("r2", "r2_storage_class_a_operations", M, 4.50, M, true),
    price("r2", "r2_storage_class_b_operations", 10.0 * M, 0.36, M, true),
    price("durable_objects", "durable_objects_compute_requests", M, 0.15, M, true),
    price("durable_objects", "durable_objects_compute_duration", 400_000.0, 12.50, M, false),
    price("durable_objects", "durable_objects_storage_rows_read", 25_000.0 * M, 0.001, M, true),
    price("durable_objects", "durable_objects_storage_rows_written", 50.0 * M, 1.00, M, true),
    price("durable_objects", "durable_objects_sql_storage", 5.0, 0.20, 1.0, false),
    price("queues", "queues_standard_operations", M, 0.40, M, true),
    // 25 GiB-hours, 375 vCPU-minutes and 200 GB-hours a cycle.
    price("containers", "container_memory", 90_000.0, 0.000_002_5, 1.0, false),
    price("containers", "container_vcpu", 22_500.0, 0.000_020, 1.0, false),
    price("containers", "container_disk", 720_000.0, 0.000_000_07, 1.0, false),
    price("containers", "container_egress_north_america_europe", 1_000.0, 0.025, 1.0, false),
    price("containers", "container_egress_everywhere_else", 500.0, 0.04, 1.0, false),
    price("vectorize", "vectorize_queried", 50.0 * M, 0.01, M, false),
    price("vectorize", "vectorize_stored", 10.0 * M, 0.05, 100.0 * M, false),
    ListPrice { product: "workers_ai", meter: "workers_ai_neurons", included: 10_000.0, usd: 0.011, per: 1_000.0, whole: false, daily: true },
];

/// The list price for a line: its product's with the longest matching
/// meter prefix.
pub(crate) fn list_price(product: &str, meter: &str) -> Option<&'static ListPrice> {
    LIST_PRICES.iter().filter(|p| p.product == product && meter.starts_with(p.meter)).max_by_key(|p| p.meter.len())
}

/// What `quantity` of a meter comes to at its list price before any
/// included amount, and not in whole blocks: the price book costs every
/// unit, so this, not what Cloudflare billed past the included amounts, is
/// what it is checked against. None for a meter with no list price.
pub(crate) fn list_cost(product: &str, meter: &str, quantity: f64) -> Option<f64> {
    list_price(product, meter).map(|p| quantity.max(0.0) * p.usd / p.per)
}

/// Puts a cost on every billable-usage line, cycle by cycle (`anchor`):
/// Cloudflare's own where it put one on any of the meter's lines in the
/// cycle, else the list price past the included amount, landing on the
/// days the cycle's running total passes it. Other lines are left alone.
pub(crate) fn price_lines(lines: &mut [CostLine], anchor: u32) {
    let mut groups: BTreeMap<(String, String, String), Vec<usize>> = BTreeMap::new();
    for (index, line) in lines.iter().enumerate() {
        if line.source != SOURCE_BILLABLE {
            continue;
        }
        let period = match list_price(&line.product, &line.meter) {
            Some(p) if p.daily => line.day.clone(),
            _ => cycle_of(&line.day, anchor).start,
        };
        groups.entry((period, line.product.clone(), line.meter.clone())).or_default().push(index);
    }
    for ((_, product, meter), mut indexes) in groups {
        indexes.sort_by(|a, b| lines[*a].day.cmp(&lines[*b].day));
        let billed = indexes.iter().any(|i| lines[*i].billed_usd > 0.0);
        let list = list_price(&product, &meter);
        let mut used = 0.0;
        for index in indexes {
            let line = &mut lines[index];
            let before = used;
            used += line.quantity.max(0.0);
            line.billable_quantity = list.map_or(0.0, |p| p.over(used) - p.over(before));
            (line.cost_usd, line.basis) = match list {
                _ if billed => (line.billed_usd, BASIS_CLOUDFLARE),
                Some(p) => (p.cost(used) - p.cost(before), BASIS_LIST),
                None => (0.0, BASIS_NONE),
            };
        }
    }
}

/// A cycle's cost, from what it cost over the days elapsed: Cloudflare's
/// projection on its Billable usage page ($0.29 over 12 days of a 30-day
/// cycle is $0.73).
pub(crate) fn project(cost_micros: i64, days_elapsed: u32, days: u32) -> i64 {
    if days_elapsed == 0 {
        return cost_micros;
    }
    (cost_micros as f64 * days as f64 / days_elapsed as f64).round() as i64
}

/// A monthly subscription over the days from `since` to `until`: each day
/// its cycle's share (the month's price over the cycle's days), so a whole
/// cycle comes to the month's price and any range to its days' part of it.
pub(crate) fn accrued(monthly_micros: i64, since: &str, until: &str, anchor: u32) -> i64 {
    let mut lengths: BTreeMap<String, u32> = BTreeMap::new();
    let total: f64 = days_between(since, until)
        .iter()
        .map(|day| {
            let cycle = cycle_of(day, anchor);
            let days = *lengths.entry(cycle.start.clone()).or_insert_with(|| cycle.days());
            monthly_micros as f64 / days.max(1) as f64
        })
        .sum();
    total.round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(day: &str, product: &str, meter: &str, quantity: f64, billed: f64) -> CostLine {
        CostLine {
            day: day.into(),
            source: SOURCE_BILLABLE,
            product: product.into(),
            meter: meter.into(),
            unit: "Count".into(),
            quantity,
            billed_usd: billed,
            raw_name: meter.into(),
            ..CostLine::default()
        }
    }

    #[test]
    fn a_cycle_runs_from_the_anchor_day_to_the_day_before_the_next() {
        assert_eq!(cycle_of("2026-10-09", 28), Cycle { start: "2026-09-28".into(), end: "2026-10-27".into() });
        assert_eq!(cycle_of("2026-09-28", 28).start, "2026-09-28");
        assert_eq!(cycle_of("2026-09-27", 28), Cycle { start: "2026-08-28".into(), end: "2026-09-27".into() });
        assert_eq!(cycle_of("2026-10-28", 28), Cycle { start: "2026-10-28".into(), end: "2026-11-27".into() });
        assert_eq!(cycle_of("2026-10-09", 28).days(), 30);
        assert_eq!(cycle_of("2026-10-09", 28).days_elapsed("2026-10-09"), 12);
        // Across a year, and an anchor past a short month's end.
        assert_eq!(cycle_of("2027-01-05", 28).start, "2026-12-28");
        assert_eq!(cycle_of("2027-02-28", 31), Cycle { start: "2027-02-28".into(), end: "2027-03-30".into() });
        assert_eq!(cycle_of("2026-10-09", 1), Cycle { start: "2026-10-01".into(), end: "2026-10-31".into() });
        assert_eq!(anchor_of("2026-09-28T00:00:00Z"), Some(28));
        assert_eq!(anchor_of("nonsense"), None);
    }

    #[test]
    fn the_bill_is_read_for_whole_cycles() {
        // Ten days in: the current cycle only.
        assert_eq!(bill_since("2026-10-09", 28, 4, false), "2026-09-28");
        // Its first days, or the first read: the cycle before too, which
        // Cloudflare may still restate.
        assert_eq!(bill_since("2026-09-30", 28, 4, false), "2026-08-28");
        assert_eq!(bill_since("2026-10-09", 28, 4, true), "2026-08-28");
    }

    /// The owner's dashboard on 2026-10-09 (cycle Sep 28 to Oct 27): Workers
    /// CPU 39.16M ms (9.16M billable) $0.20, Containers memory 126.87k
    /// GiB-seconds (36.87k billable) $0.09, all of it on 10-07; total $0.29,
    /// projected $0.73. Cloudflare's lines carried no cost.
    #[test]
    fn the_cycle_matches_cloudflares_billable_usage_page() {
        let mut lines = vec![
            line("2026-10-05", "workers", "workers_cpu_ms", 14_000_000.0, 0.0),
            line("2026-10-06", "workers", "workers_cpu_ms", 14_000_000.0, 0.0),
            line("2026-10-07", "workers", "workers_cpu_ms", 11_160_000.0, 0.0),
            line("2026-10-05", "containers", "container_memory_per_gib_second", 20_000.0, 0.0),
            line("2026-10-06", "containers", "container_memory_per_gib_second", 52_000.0, 0.0),
            line("2026-10-07", "containers", "container_memory_per_gib_second", 54_870.0, 0.0),
            line("2026-10-07", "containers", "container_vcpu", 12_000.0, 0.0),
            line("2026-10-07", "containers", "container_disk_per_gb_second", 253_740.0, 0.0),
            line("2026-10-07", "d1", "d1_rows_read", 61_820_000.0, 0.0),
            line("2026-10-07", "workers", "workers_standard_requests", 845_650.0, 0.0),
            line("2026-10-07", "email", "email_service_emails_sent", 7.0, 0.0),
        ];
        price_lines(&mut lines, 28);
        let total: f64 = lines.iter().map(|l| l.cost_usd).sum();
        assert!((total - 0.29).abs() < 0.01, "{total}");
        let on = |day: &str| lines.iter().filter(|l| l.day == day).map(|l| l.cost_usd).sum::<f64>();
        assert_eq!((on("2026-10-05"), on("2026-10-06")), (0.0, 0.0));
        let cpu: f64 = lines.iter().filter(|l| l.meter == "workers_cpu_ms").map(|l| l.cost_usd).sum();
        assert!((cpu - 0.20).abs() < 1e-9, "billed in whole millions: {cpu}");
        let memory: Vec<&CostLine> = lines.iter().filter(|l| l.meter.starts_with("container_memory")).collect();
        let billable: f64 = memory.iter().map(|l| l.billable_quantity).sum();
        assert!((billable - 36_870.0).abs() < 1e-6);
        assert!((memory.iter().map(|l| l.cost_usd).sum::<f64>() - 0.092_175).abs() < 1e-9);
        assert!(lines.iter().filter(|l| l.product != "email").all(|l| l.basis == BASIS_LIST));
        assert_eq!(lines.iter().find(|l| l.product == "email").unwrap().basis, BASIS_NONE);
        let micros = (total * 1_000_000.0).round() as i64;
        assert_eq!(project(micros, 12, 30), 730_438);
    }

    #[test]
    fn included_amounts_are_the_cycles_not_the_days_or_the_month() {
        // 20M CPU ms a day for three days across a cycle's end: the second
        // day passes 30M in the old cycle; the third starts a new one.
        let mut lines = vec![
            line("2026-10-26", "workers", "workers_cpu_ms", 20_000_000.0, 0.0),
            line("2026-10-27", "workers", "workers_cpu_ms", 20_000_000.0, 0.0),
            line("2026-10-28", "workers", "workers_cpu_ms", 20_000_000.0, 0.0),
        ];
        price_lines(&mut lines, 28);
        let costs: Vec<f64> = lines.iter().map(|l| (l.cost_usd * 100.0).round() / 100.0).collect();
        assert_eq!(costs, vec![0.0, 0.20, 0.0]);
        // Unsorted lines are priced in day order all the same.
        let mut reversed = vec![lines[1].clone(), lines[0].clone()];
        price_lines(&mut reversed, 28);
        assert_eq!(reversed[0].cost_usd, lines[1].cost_usd);
    }

    #[test]
    fn cloudflares_own_cost_wins_for_its_meter_and_cycle() {
        let mut lines = vec![
            line("2026-10-06", "workers", "workers_cpu_ms", 35_000_000.0, 0.0),
            line("2026-10-07", "workers", "workers_cpu_ms", 5_000_000.0, 0.19),
            line("2026-10-07", "containers", "container_memory_per_gib_second", 100_000.0, 0.0),
        ];
        price_lines(&mut lines, 28);
        assert_eq!((lines[0].cost_usd, lines[0].basis), (0.0, BASIS_CLOUDFLARE));
        assert_eq!((lines[1].cost_usd, lines[1].basis), (0.19, BASIS_CLOUDFLARE));
        assert_eq!(lines[2].basis, BASIS_LIST);
        // Not billable usage: left as it is.
        let mut other = vec![CostLine { source: crate::costs::SOURCE_GATEWAY, cost_usd: 1.5, ..line("2026-10-07", "ai_gateway_requests", "m", 3.0, 0.0) }];
        price_lines(&mut other, 28);
        assert_eq!((other[0].cost_usd, other[0].basis), (1.5, ""));
    }

    #[test]
    fn workers_ai_includes_a_day_not_a_cycle() {
        let mut lines = vec![
            line("2026-10-06", "workers_ai", "workers_ai_neurons", 9_000.0, 0.0),
            line("2026-10-07", "workers_ai", "workers_ai_neurons", 12_000.0, 0.0),
        ];
        price_lines(&mut lines, 28);
        assert_eq!(lines[0].cost_usd, 0.0);
        assert!((lines[1].cost_usd - 0.022).abs() < 1e-12);
    }

    #[test]
    fn the_longest_prefix_names_the_price() {
        assert_eq!(list_price("workers", "workers_for_platforms_cpu_ms").unwrap().included, 60.0 * M);
        assert_eq!(list_price("workers", "workers_cpu_ms").unwrap().included, 30.0 * M);
        assert!(list_price("email", "email_service_emails_sent").is_none());
        // The keeper prices sandboxes at the same published rates.
        assert_eq!(list_price("containers", "container_memory_per_gib_second").unwrap().usd, 0.000_002_5);
    }

    #[test]
    fn a_list_cost_is_every_unit_at_the_list_price() {
        // 126.87k GiB-seconds is $0.32 at list, though only the 36.87k past
        // the included 90k were billed ($0.09).
        let memory = list_cost("containers", "container_memory_per_gib_second", 126_870.0).unwrap();
        assert!((memory - 0.317_175).abs() < 1e-9);
        // Per-million meters are not rounded up to a whole million.
        assert!((list_cost("workers", "workers_cpu_ms", 11_160_000.0).unwrap() - 0.2232).abs() < 1e-9);
        assert!(list_cost("email", "email_service_emails_sent", 7.0).is_none());
    }

    #[test]
    fn subscriptions_accrue_by_the_cycles_days() {
        // A whole cycle is the month's price, whatever its length.
        assert_eq!(accrued(30_000_000, "2026-09-28", "2026-10-27", 28), 30_000_000);
        assert_eq!(accrued(30_000_000, "2026-10-28", "2026-11-27", 28), 30_000_000);
        // Twelve days of a 30-day cycle; October to the 9th.
        assert_eq!(accrued(30_000_000, "2026-09-28", "2026-10-09", 28), 12_000_000);
        assert_eq!(accrued(30_000_000, "2026-10-01", "2026-10-09", 28), 9_000_000);
        // The statement's 30 days and the calendar month agree day for day.
        let statement = accrued(30_000_000, "2026-09-10", "2026-10-09", 28);
        let september = accrued(30_000_000, "2026-09-10", "2026-09-30", 28);
        assert_eq!(statement, september + accrued(30_000_000, "2026-10-01", "2026-10-09", 28));
        assert_eq!(accrued(30_000_000, "2026-10-09", "2026-10-01", 28), 0);
    }
}
