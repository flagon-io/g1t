//! Time zones: which names the dependency update file's `timezone` may
//! use (the IANA database's, as `dependabot.yml` takes them), and how far
//! each is from UTC at a moment, which the runtime's `Intl` knows.

/// Every name `schedule.timezone` accepts.
pub const ZONES: &[&str] = &[
    "Africa/Abidjan", "Africa/Accra", "Africa/Addis_Ababa", "Africa/Algiers", "Africa/Asmara",
    "Africa/Asmera", "Africa/Bamako", "Africa/Bangui", "Africa/Banjul", "Africa/Bissau", "Africa/Blantyre",
    "Africa/Brazzaville", "Africa/Bujumbura", "Africa/Cairo", "Africa/Casablanca", "Africa/Ceuta",
    "Africa/Conakry", "Africa/Dakar", "Africa/Dar_es_Salaam", "Africa/Djibouti", "Africa/Douala",
    "Africa/El_Aaiun", "Africa/Freetown", "Africa/Gaborone", "Africa/Harare", "Africa/Johannesburg",
    "Africa/Juba", "Africa/Kampala", "Africa/Khartoum", "Africa/Kigali", "Africa/Kinshasa", "Africa/Lagos",
    "Africa/Libreville", "Africa/Lome", "Africa/Luanda", "Africa/Lubumbashi", "Africa/Lusaka",
    "Africa/Malabo", "Africa/Maputo", "Africa/Maseru", "Africa/Mbabane", "Africa/Mogadishu",
    "Africa/Monrovia", "Africa/Nairobi", "Africa/Ndjamena", "Africa/Niamey", "Africa/Nouakchott",
    "Africa/Ouagadougou", "Africa/Porto-Novo", "Africa/Sao_Tome", "Africa/Timbuktu", "Africa/Tripoli",
    "Africa/Tunis", "Africa/Windhoek", "America/Adak", "America/Anchorage", "America/Anguilla",
    "America/Antigua", "America/Araguaina", "America/Argentina/Buenos_Aires", "America/Argentina/Catamarca",
    "America/Argentina/ComodRivadavia", "America/Argentina/Cordoba", "America/Argentina/Jujuy",
    "America/Argentina/La_Rioja", "America/Argentina/Mendoza", "America/Argentina/Rio_Gallegos",
    "America/Argentina/Salta", "America/Argentina/San_Juan", "America/Argentina/San_Luis",
    "America/Argentina/Tucuman", "America/Argentina/Ushuaia", "America/Aruba", "America/Asuncion",
    "America/Atikokan", "America/Atka", "America/Bahia", "America/Bahia_Banderas", "America/Barbados",
    "America/Belem", "America/Belize", "America/Blanc-Sablon", "America/Boa_Vista", "America/Bogota",
    "America/Boise", "America/Buenos_Aires", "America/Cambridge_Bay", "America/Campo_Grande",
    "America/Cancun", "America/Caracas", "America/Catamarca", "America/Cayenne", "America/Cayman",
    "America/Chicago", "America/Chihuahua", "America/Ciudad_Juarez", "America/Coral_Harbour",
    "America/Cordoba", "America/Costa_Rica", "America/Coyhaique", "America/Creston", "America/Cuiaba",
    "America/Curacao", "America/Danmarkshavn", "America/Dawson", "America/Dawson_Creek", "America/Denver",
    "America/Detroit", "America/Dominica", "America/Edmonton", "America/Eirunepe", "America/El_Salvador",
    "America/Ensenada", "America/Fort_Nelson", "America/Fort_Wayne", "America/Fortaleza", "America/Glace_Bay",
    "America/Godthab", "America/Goose_Bay", "America/Grand_Turk", "America/Grenada", "America/Guadeloupe",
    "America/Guatemala", "America/Guayaquil", "America/Guyana", "America/Halifax", "America/Havana",
    "America/Hermosillo", "America/Indiana/Indianapolis", "America/Indiana/Knox", "America/Indiana/Marengo",
    "America/Indiana/Petersburg", "America/Indiana/Tell_City", "America/Indiana/Vevay",
    "America/Indiana/Vincennes", "America/Indiana/Winamac", "America/Indianapolis", "America/Inuvik",
    "America/Iqaluit", "America/Jamaica", "America/Jujuy", "America/Juneau", "America/Kentucky/Louisville",
    "America/Kentucky/Monticello", "America/Knox_IN", "America/Kralendijk", "America/La_Paz", "America/Lima",
    "America/Los_Angeles", "America/Louisville", "America/Lower_Princes", "America/Maceio", "America/Managua",
    "America/Manaus", "America/Marigot", "America/Martinique", "America/Matamoros", "America/Mazatlan",
    "America/Mendoza", "America/Menominee", "America/Merida", "America/Metlakatla", "America/Mexico_City",
    "America/Miquelon", "America/Moncton", "America/Monterrey", "America/Montevideo", "America/Montreal",
    "America/Montserrat", "America/Nassau", "America/New_York", "America/Nipigon", "America/Nome",
    "America/Noronha", "America/North_Dakota/Beulah", "America/North_Dakota/Center",
    "America/North_Dakota/New_Salem", "America/Nuuk", "America/Ojinaga", "America/Panama",
    "America/Pangnirtung", "America/Paramaribo", "America/Phoenix", "America/Port-au-Prince",
    "America/Port_of_Spain", "America/Porto_Acre", "America/Porto_Velho", "America/Puerto_Rico",
    "America/Punta_Arenas", "America/Rainy_River", "America/Rankin_Inlet", "America/Recife", "America/Regina",
    "America/Resolute", "America/Rio_Branco", "America/Rosario", "America/Santa_Isabel", "America/Santarem",
    "America/Santiago", "America/Santo_Domingo", "America/Sao_Paulo", "America/Scoresbysund",
    "America/Shiprock", "America/Sitka", "America/St_Barthelemy", "America/St_Johns", "America/St_Kitts",
    "America/St_Lucia", "America/St_Thomas", "America/St_Vincent", "America/Swift_Current",
    "America/Tegucigalpa", "America/Thule", "America/Thunder_Bay", "America/Tijuana", "America/Toronto",
    "America/Tortola", "America/Vancouver", "America/Virgin", "America/Whitehorse", "America/Winnipeg",
    "America/Yakutat", "America/Yellowknife", "Antarctica/Casey", "Antarctica/Davis",
    "Antarctica/DumontDUrville", "Antarctica/Macquarie", "Antarctica/Mawson", "Antarctica/McMurdo",
    "Antarctica/Palmer", "Antarctica/Rothera", "Antarctica/South_Pole", "Antarctica/Syowa",
    "Antarctica/Troll", "Antarctica/Vostok", "Arctic/Longyearbyen", "Asia/Aden", "Asia/Almaty", "Asia/Amman",
    "Asia/Anadyr", "Asia/Aqtau", "Asia/Aqtobe", "Asia/Ashgabat", "Asia/Ashkhabad", "Asia/Atyrau",
    "Asia/Baghdad", "Asia/Bahrain", "Asia/Baku", "Asia/Bangkok", "Asia/Barnaul", "Asia/Beirut",
    "Asia/Bishkek", "Asia/Brunei", "Asia/Calcutta", "Asia/Chita", "Asia/Choibalsan", "Asia/Chongqing",
    "Asia/Chungking", "Asia/Colombo", "Asia/Dacca", "Asia/Damascus", "Asia/Dhaka", "Asia/Dili", "Asia/Dubai",
    "Asia/Dushanbe", "Asia/Famagusta", "Asia/Gaza", "Asia/Harbin", "Asia/Hebron", "Asia/Ho_Chi_Minh",
    "Asia/Hong_Kong", "Asia/Hovd", "Asia/Irkutsk", "Asia/Istanbul", "Asia/Jakarta", "Asia/Jayapura",
    "Asia/Jerusalem", "Asia/Kabul", "Asia/Kamchatka", "Asia/Karachi", "Asia/Kashgar", "Asia/Kathmandu",
    "Asia/Katmandu", "Asia/Khandyga", "Asia/Kolkata", "Asia/Krasnoyarsk", "Asia/Kuala_Lumpur", "Asia/Kuching",
    "Asia/Kuwait", "Asia/Macao", "Asia/Macau", "Asia/Magadan", "Asia/Makassar", "Asia/Manila", "Asia/Muscat",
    "Asia/Nicosia", "Asia/Novokuznetsk", "Asia/Novosibirsk", "Asia/Omsk", "Asia/Oral", "Asia/Phnom_Penh",
    "Asia/Pontianak", "Asia/Pyongyang", "Asia/Qatar", "Asia/Qostanay", "Asia/Qyzylorda", "Asia/Rangoon",
    "Asia/Riyadh", "Asia/Saigon", "Asia/Sakhalin", "Asia/Samarkand", "Asia/Seoul", "Asia/Shanghai",
    "Asia/Singapore", "Asia/Srednekolymsk", "Asia/Taipei", "Asia/Tashkent", "Asia/Tbilisi", "Asia/Tehran",
    "Asia/Tel_Aviv", "Asia/Thimbu", "Asia/Thimphu", "Asia/Tokyo", "Asia/Tomsk", "Asia/Ujung_Pandang",
    "Asia/Ulaanbaatar", "Asia/Ulan_Bator", "Asia/Urumqi", "Asia/Ust-Nera", "Asia/Vientiane",
    "Asia/Vladivostok", "Asia/Yakutsk", "Asia/Yangon", "Asia/Yekaterinburg", "Asia/Yerevan",
    "Atlantic/Azores", "Atlantic/Bermuda", "Atlantic/Canary", "Atlantic/Cape_Verde", "Atlantic/Faeroe",
    "Atlantic/Faroe", "Atlantic/Jan_Mayen", "Atlantic/Madeira", "Atlantic/Reykjavik",
    "Atlantic/South_Georgia", "Atlantic/St_Helena", "Atlantic/Stanley", "Australia/ACT", "Australia/Adelaide",
    "Australia/Brisbane", "Australia/Broken_Hill", "Australia/Canberra", "Australia/Currie",
    "Australia/Darwin", "Australia/Eucla", "Australia/Hobart", "Australia/LHI", "Australia/Lindeman",
    "Australia/Lord_Howe", "Australia/Melbourne", "Australia/NSW", "Australia/North", "Australia/Perth",
    "Australia/Queensland", "Australia/South", "Australia/Sydney", "Australia/Tasmania", "Australia/Victoria",
    "Australia/West", "Australia/Yancowinna", "Brazil/Acre", "Brazil/DeNoronha", "Brazil/East", "Brazil/West",
    "CET", "CST6CDT", "Canada/Atlantic", "Canada/Central", "Canada/Eastern", "Canada/Mountain",
    "Canada/Newfoundland", "Canada/Pacific", "Canada/Saskatchewan", "Canada/Yukon", "Chile/Continental",
    "Chile/EasterIsland", "Cuba", "EET", "EST", "EST5EDT", "Egypt", "Eire", "Etc/GMT", "Etc/GMT+0",
    "Etc/GMT+1", "Etc/GMT+10", "Etc/GMT+11", "Etc/GMT+12", "Etc/GMT+2", "Etc/GMT+3", "Etc/GMT+4", "Etc/GMT+5",
    "Etc/GMT+6", "Etc/GMT+7", "Etc/GMT+8", "Etc/GMT+9", "Etc/GMT-0", "Etc/GMT-1", "Etc/GMT-10", "Etc/GMT-11",
    "Etc/GMT-12", "Etc/GMT-13", "Etc/GMT-14", "Etc/GMT-2", "Etc/GMT-3", "Etc/GMT-4", "Etc/GMT-5", "Etc/GMT-6",
    "Etc/GMT-7", "Etc/GMT-8", "Etc/GMT-9", "Etc/GMT0", "Etc/Greenwich", "Etc/UCT", "Etc/UTC", "Etc/Universal",
    "Etc/Zulu", "Europe/Amsterdam", "Europe/Andorra", "Europe/Astrakhan", "Europe/Athens", "Europe/Belfast",
    "Europe/Belgrade", "Europe/Berlin", "Europe/Bratislava", "Europe/Brussels", "Europe/Bucharest",
    "Europe/Budapest", "Europe/Busingen", "Europe/Chisinau", "Europe/Copenhagen", "Europe/Dublin",
    "Europe/Gibraltar", "Europe/Guernsey", "Europe/Helsinki", "Europe/Isle_of_Man", "Europe/Istanbul",
    "Europe/Jersey", "Europe/Kaliningrad", "Europe/Kiev", "Europe/Kirov", "Europe/Kyiv", "Europe/Lisbon",
    "Europe/Ljubljana", "Europe/London", "Europe/Luxembourg", "Europe/Madrid", "Europe/Malta",
    "Europe/Mariehamn", "Europe/Minsk", "Europe/Monaco", "Europe/Moscow", "Europe/Nicosia", "Europe/Oslo",
    "Europe/Paris", "Europe/Podgorica", "Europe/Prague", "Europe/Riga", "Europe/Rome", "Europe/Samara",
    "Europe/San_Marino", "Europe/Sarajevo", "Europe/Saratov", "Europe/Simferopol", "Europe/Skopje",
    "Europe/Sofia", "Europe/Stockholm", "Europe/Tallinn", "Europe/Tirane", "Europe/Tiraspol",
    "Europe/Ulyanovsk", "Europe/Uzhgorod", "Europe/Vaduz", "Europe/Vatican", "Europe/Vienna",
    "Europe/Vilnius", "Europe/Volgograd", "Europe/Warsaw", "Europe/Zagreb", "Europe/Zaporozhye",
    "Europe/Zurich", "GB", "GB-Eire", "GMT", "GMT+0", "GMT-0", "GMT0", "Greenwich", "HST", "Hongkong",
    "Iceland", "Indian/Antananarivo", "Indian/Chagos", "Indian/Christmas", "Indian/Cocos", "Indian/Comoro",
    "Indian/Kerguelen", "Indian/Mahe", "Indian/Maldives", "Indian/Mauritius", "Indian/Mayotte",
    "Indian/Reunion", "Iran", "Israel", "Jamaica", "Japan", "Kwajalein", "Libya", "MET", "MST", "MST7MDT",
    "Mexico/BajaNorte", "Mexico/BajaSur", "Mexico/General", "NZ", "NZ-CHAT", "Navajo", "PRC", "PST8PDT",
    "Pacific/Apia", "Pacific/Auckland", "Pacific/Bougainville", "Pacific/Chatham", "Pacific/Chuuk",
    "Pacific/Easter", "Pacific/Efate", "Pacific/Enderbury", "Pacific/Fakaofo", "Pacific/Fiji",
    "Pacific/Funafuti", "Pacific/Galapagos", "Pacific/Gambier", "Pacific/Guadalcanal", "Pacific/Guam",
    "Pacific/Honolulu", "Pacific/Johnston", "Pacific/Kanton", "Pacific/Kiritimati", "Pacific/Kosrae",
    "Pacific/Kwajalein", "Pacific/Majuro", "Pacific/Marquesas", "Pacific/Midway", "Pacific/Nauru",
    "Pacific/Niue", "Pacific/Norfolk", "Pacific/Noumea", "Pacific/Pago_Pago", "Pacific/Palau",
    "Pacific/Pitcairn", "Pacific/Pohnpei", "Pacific/Ponape", "Pacific/Port_Moresby", "Pacific/Rarotonga",
    "Pacific/Saipan", "Pacific/Samoa", "Pacific/Tahiti", "Pacific/Tarawa", "Pacific/Tongatapu",
    "Pacific/Truk", "Pacific/Wake", "Pacific/Wallis", "Pacific/Yap", "Poland", "Portugal", "ROC", "ROK",
    "Singapore", "Turkey", "UCT", "US/Alaska", "US/Aleutian", "US/Arizona", "US/Central", "US/East-Indiana",
    "US/Eastern", "US/Hawaii", "US/Indiana-Starke", "US/Michigan", "US/Mountain", "US/Pacific", "US/Samoa",
    "UTC", "Universal", "W-SU", "WET", "Zulu",
];

pub fn known(zone: &str) -> bool {
    ZONES.contains(&zone)
}

/// How many minutes `zone` is ahead of UTC at `utc_ms`, from the
/// runtime's time zone database. UTC for a zone it does not know.
#[cfg(target_arch = "wasm32")]
pub fn offset_minutes(zone: &str, utc_ms: u64) -> i32 {
    use worker::js_sys::{Array, Date, Intl, Object, Reflect};
    use worker::wasm_bindgen::JsValue;
    if matches!(zone, "UTC" | "Etc/UTC" | "GMT" | "Etc/GMT" | "Zulu" | "Etc/Zulu" | "Universal" | "Etc/Universal") {
        return 0;
    }
    let options = Object::new();
    let set = |key: &str, value: &str| {
        let _ = Reflect::set(&options, &JsValue::from_str(key), &JsValue::from_str(value));
    };
    set("timeZone", zone);
    set("hourCycle", "h23");
    for key in ["year", "month", "day", "hour", "minute", "second"] {
        set(key, "numeric");
    }
    let locales = Array::of1(&JsValue::from_str("en-US"));
    let format = Intl::DateTimeFormat::new(&locales, &options);
    let date = Date::new(&JsValue::from_f64(utc_ms as f64));
    let parts = format.format_to_parts(&date);
    let mut fields = [0i64; 6];
    for part in parts.iter() {
        let kind = Reflect::get(&part, &JsValue::from_str("type")).ok().and_then(|v| v.as_string()).unwrap_or_default();
        let value: i64 = Reflect::get(&part, &JsValue::from_str("value"))
            .ok()
            .and_then(|v| v.as_string())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let at = match kind.as_str() {
            "year" => 0,
            "month" => 1,
            "day" => 2,
            "hour" => 3,
            "minute" => 4,
            "second" => 5,
            _ => continue,
        };
        fields[at] = value;
    }
    let local = crate::schedule::days_from_civil(fields[0], fields[1] as u32, fields[2] as u32) * 86_400_000
        + (fields[3] % 24) * 3_600_000
        + fields[4] * 60_000
        + fields[5] * 1000;
    let utc = (utc_ms / 1000 * 1000) as i64;
    ((local - utc) / 60_000) as i32
}

/// Outside the Worker, for tests: UTC, fixed offsets, and a few zones with
/// their daylight saving rules, enough to test schedules across a change.
#[cfg(not(target_arch = "wasm32"))]
pub fn offset_minutes(zone: &str, utc_ms: u64) -> i32 {
    use crate::schedule::{civil_from_days, days_from_civil};
    // The nth `weekday` (0 Sunday) of a month, or the last when n is 5, as a day number.
    let nth = |year: i64, month: u32, weekday: i64, n: i64| -> i64 {
        if n == 5 {
            let next = if month == 12 { days_from_civil(year + 1, 1, 1) } else { days_from_civil(year, month + 1, 1) };
            let last = next - 1;
            last - (last + 4 - weekday).rem_euclid(7)
        } else {
            let first = days_from_civil(year, month, 1);
            first + (weekday - (first + 4)).rem_euclid(7) + 7 * (n - 1)
        }
    };
    let ms = utc_ms as i64;
    let (year, _, _) = civil_from_days(ms.div_euclid(86_400_000));
    match zone {
        "America/New_York" | "US/Eastern" => {
            // Second Sunday of March, 07:00 UTC, to the first Sunday of November, 06:00 UTC.
            let start = nth(year, 3, 0, 2) * 86_400_000 + 7 * 3_600_000;
            let end = nth(year, 11, 0, 1) * 86_400_000 + 6 * 3_600_000;
            if ms >= start && ms < end { -240 } else { -300 }
        }
        "Europe/London" => {
            // Last Sunday of March to the last Sunday of October, 01:00 UTC.
            let start = nth(year, 3, 0, 5) * 86_400_000 + 3_600_000;
            let end = nth(year, 10, 0, 5) * 86_400_000 + 3_600_000;
            if ms >= start && ms < end { 60 } else { 0 }
        }
        "Asia/Tokyo" | "Japan" => 540,
        "Asia/Kolkata" | "Asia/Calcutta" => 330,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_has_the_usual_zones() {
        for zone in ["UTC", "America/New_York", "Europe/Berlin", "Asia/Kolkata", "Etc/GMT+5", "US/Pacific"] {
            assert!(known(zone), "{zone}");
        }
        assert!(!known("Mars/Olympus"));
        assert!(!known("utc"));
    }

    #[test]
    fn test_offsets_follow_daylight_saving() {
        let at = |text: &str| g1t_contracts::time::parse_rfc3339(text).unwrap();
        assert_eq!(offset_minutes("America/New_York", at("2026-01-15T12:00:00Z")), -300);
        assert_eq!(offset_minutes("America/New_York", at("2026-07-15T12:00:00Z")), -240);
        assert_eq!(offset_minutes("America/New_York", at("2026-03-08T06:59:00Z")), -300);
        assert_eq!(offset_minutes("America/New_York", at("2026-03-08T07:00:00Z")), -240);
        assert_eq!(offset_minutes("Europe/London", at("2026-10-25T00:59:00Z")), 60);
        assert_eq!(offset_minutes("Europe/London", at("2026-10-25T01:00:00Z")), 0);
    }
}
