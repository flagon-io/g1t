//! Which license a repository's LICENSE file holds: an `SPDX-License-Identifier`
//! line when it has one, else the phrases each common license is known by.
//! A text none of them match is "Other": the file is still linked.

use g1t_contracts::about::License;

/// The names a license file goes by, at the root, best first.
const PREFERRED: &[&str] = &["license", "license.md", "license.txt", "licence", "licence.md", "licence.txt", "copying", "copying.md", "copying.txt", "unlicense"];

/// Whether a root file is a license file: `LICENSE`, `LICENCE.md`,
/// `COPYING`, `LICENSE-MIT` and the like.
pub fn is_license_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["license", "licence", "copying", "unlicense"].iter().any(|start| lower.starts_with(start))
        && !lower.ends_with(".html")
        && lower.len() <= 40
}

/// The root files to read for a license, best first.
pub fn candidates<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut found: Vec<&str> = names.into_iter().filter(|name| is_license_file(name)).collect();
    found.sort_by_key(|name| {
        let lower = name.to_ascii_lowercase();
        (PREFERRED.iter().position(|preferred| *preferred == lower).unwrap_or(PREFERRED.len()), lower)
    });
    found
}

/// One license: its SPDX id, its name, and phrases its text holds (all of
/// `all`, none of `none`), lowercase with spaces collapsed.
struct Known {
    id: &'static str,
    name: &'static str,
    all: &'static [&'static str],
    none: &'static [&'static str],
}

/// Most specific first: AGPL and LGPL before GPL, MIT-0 before MIT.
const KNOWN: &[Known] = &[
    Known { id: "AGPL-3.0", name: "GNU Affero General Public License v3.0", all: &["gnu affero general public license"], none: &[] },
    Known { id: "LGPL-3.0", name: "GNU Lesser General Public License v3.0", all: &["gnu lesser general public license", "version 3"], none: &[] },
    Known { id: "LGPL-2.1", name: "GNU Lesser General Public License v2.1", all: &["gnu lesser general public license", "version 2.1"], none: &[] },
    Known { id: "GPL-3.0", name: "GNU General Public License v3.0", all: &["gnu general public license", "version 3"], none: &[] },
    Known { id: "GPL-2.0", name: "GNU General Public License v2.0", all: &["gnu general public license", "version 2"], none: &[] },
    Known { id: "Apache-2.0", name: "Apache License 2.0", all: &["apache license", "version 2.0"], none: &[] },
    Known { id: "MPL-2.0", name: "Mozilla Public License 2.0", all: &["mozilla public license", "2.0"], none: &[] },
    Known { id: "EPL-2.0", name: "Eclipse Public License 2.0", all: &["eclipse public license", "2.0"], none: &[] },
    Known { id: "EPL-1.0", name: "Eclipse Public License 1.0", all: &["eclipse public license", "1.0"], none: &[] },
    Known { id: "BSL-1.0", name: "Boost Software License 1.0", all: &["boost software license"], none: &[] },
    Known { id: "BUSL-1.1", name: "Business Source License 1.1", all: &["business source license"], none: &[] },
    Known { id: "Elastic-2.0", name: "Elastic License 2.0", all: &["elastic license 2.0"], none: &[] },
    Known { id: "SSPL-1.0", name: "Server Side Public License v1", all: &["server side public license"], none: &[] },
    Known { id: "Unlicense", name: "The Unlicense", all: &["this is free and unencumbered software released into the public domain"], none: &[] },
    Known { id: "CC0-1.0", name: "Creative Commons Zero v1.0 Universal", all: &["cc0 1.0 universal"], none: &[] },
    Known { id: "CC-BY-4.0", name: "Creative Commons Attribution 4.0 International", all: &["attribution 4.0 international"], none: &["sharealike", "noncommercial"] },
    Known { id: "WTFPL", name: "Do What The F*ck You Want To Public License", all: &["do what the fuck you want to public license"], none: &[] },
    Known {
        id: "MIT-0",
        name: "MIT No Attribution",
        all: &["permission is hereby granted, free of charge, to any person obtaining a copy"],
        none: &["the above copyright notice and this permission notice shall be included"],
    },
    Known {
        id: "MIT",
        name: "MIT License",
        all: &["permission is hereby granted, free of charge, to any person obtaining a copy", "the above copyright notice and this permission notice shall be included"],
        none: &[],
    },
    Known {
        id: "ISC",
        name: "ISC License",
        all: &["permission to use, copy, modify, and/or distribute this software for any purpose", "the above copyright notice and this permission notice appear in all copies"],
        none: &[],
    },
    Known {
        id: "0BSD",
        name: "BSD Zero Clause License",
        all: &["permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted"],
        none: &["the above copyright notice and this permission notice appear in all copies"],
    },
    Known {
        id: "BSD-4-Clause",
        name: "BSD 4-Clause \"Original\" License",
        all: &["redistribution and use in source and binary forms", "all advertising materials mentioning features"],
        none: &[],
    },
    Known {
        id: "BSD-3-Clause",
        name: "BSD 3-Clause \"New\" or \"Revised\" License",
        all: &["redistribution and use in source and binary forms", "neither the name of"],
        none: &[],
    },
    Known {
        id: "BSD-3-Clause",
        name: "BSD 3-Clause \"New\" or \"Revised\" License",
        all: &["redistribution and use in source and binary forms", "may be used to endorse or promote products derived from this software without specific prior written permission"],
        none: &[],
    },
    Known {
        id: "BSD-2-Clause",
        name: "BSD 2-Clause \"Simplified\" License",
        all: &["redistribution and use in source and binary forms"],
        none: &[],
    },
    Known {
        id: "Zlib",
        name: "zlib License",
        all: &["altered source versions must be plainly marked as such"],
        none: &[],
    },
];

/// Lowercase, quotes made plain, and whitespace collapsed to single spaces.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        let c = match c {
            '\u{2018}' | '\u{2019}' => '\'',
            '\u{201c}' | '\u{201d}' => '"',
            c => c,
        };
        if c.is_whitespace() || c == '*' || c == '#' {
            // Comment markers of a header copied from source count as space.
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.extend(c.to_lowercase());
    }
    out
}

/// An `SPDX-License-Identifier:` line's expression.
fn spdx_line(text: &str) -> Option<String> {
    text.lines().take(20).find_map(|line| {
        let (_, rest) = line.split_once("SPDX-License-Identifier:")?;
        let id = rest.trim().trim_end_matches("*/").trim();
        (!id.is_empty() && id.len() <= 100).then(|| id.to_owned())
    })
}

/// The license in a license file's text; "Other" when it is not one g1t
/// recognizes.
pub fn detect(path: &str, text: &str) -> License {
    // Enough of the text to find each license's phrases: they come early.
    let head: String = text.chars().take(24_000).collect();
    if let Some(id) = spdx_line(&head) {
        let name = KNOWN.iter().find(|known| known.id.eq_ignore_ascii_case(&id)).map_or_else(|| id.clone(), |known| known.name.to_owned());
        return License { spdx_id: Some(id), name, path: path.to_owned() };
    }
    let normal = normalize(&head);
    match KNOWN.iter().find(|known| known.all.iter().all(|phrase| normal.contains(phrase)) && !known.none.iter().any(|phrase| normal.contains(phrase))) {
        Some(known) => License { spdx_id: Some(known.id.to_owned()), name: known.name.to_owned(), path: path.to_owned() },
        None => License { spdx_id: None, name: "Other".to_owned(), path: path.to_owned() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIT: &str = "MIT License\n\nCopyright (c) 2026 Flagon, Inc.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND.";

    fn id(text: &str) -> Option<String> {
        detect("LICENSE", text).spdx_id
    }

    #[test]
    fn common_licenses_are_recognized() {
        assert_eq!(id(MIT).as_deref(), Some("MIT"));
        assert_eq!(detect("LICENSE", MIT).name, "MIT License");
        assert_eq!(id("                                 Apache License\n                           Version 2.0, January 2004\n").as_deref(), Some("Apache-2.0"));
        assert_eq!(id("GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007").as_deref(), Some("GPL-3.0"));
        assert_eq!(id("GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991").as_deref(), Some("GPL-2.0"));
        assert_eq!(id("GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007").as_deref(), Some("AGPL-3.0"));
        assert_eq!(id("GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1, February 1999").as_deref(), Some("LGPL-2.1"));
        assert_eq!(id("Mozilla Public License Version 2.0\n==================================").as_deref(), Some("MPL-2.0"));
        assert_eq!(id("This is free and unencumbered software released into the public domain.").as_deref(), Some("Unlicense"));
        assert_eq!(
            id("Redistribution and use in source and binary forms, with or without\nmodification, are permitted provided that ...\n3. Neither the name of the copyright holder nor ...").as_deref(),
            Some("BSD-3-Clause")
        );
        assert_eq!(id("Redistribution and use in source and binary forms, with or without modification").as_deref(), Some("BSD-2-Clause"));
        assert_eq!(
            id("Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.").as_deref(),
            Some("ISC")
        );
    }

    #[test]
    fn mit_without_its_notice_clause_is_mit_0() {
        let text = MIT.replace("The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.", "");
        assert_eq!(id(&text).as_deref(), Some("MIT-0"));
    }

    #[test]
    fn an_spdx_line_says_it_outright() {
        assert_eq!(id("// SPDX-License-Identifier: Apache-2.0 OR MIT\n").as_deref(), Some("Apache-2.0 OR MIT"));
        assert_eq!(detect("LICENSE", "SPDX-License-Identifier: MIT").name, "MIT License");
    }

    #[test]
    fn anything_else_is_other() {
        let other = detect("COPYING", "All rights reserved. Do not copy.");
        assert_eq!(other.spdx_id, None);
        assert_eq!(other.name, "Other");
        assert_eq!(other.path, "COPYING");
    }

    #[test]
    fn license_files_are_found_best_first() {
        let names = ["README.md", "LICENSE-MIT", "COPYING", "LICENSE.md", "license.html", "src"];
        assert_eq!(candidates(names), vec!["LICENSE.md", "COPYING", "LICENSE-MIT"]);
        assert!(candidates(["Cargo.toml"]).is_empty());
    }
}
