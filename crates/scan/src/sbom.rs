//! A software bill of materials: a repository's dependency graph as an SPDX
//! 2.3 document in JSON, the format most tools that read SBOMs accept.
//!
//! The repository is the document's one described package; every
//! dependency is a package it `DEPENDS_ON` (or `DEV_DEPENDENCY_OF` it, for
//! development only), named by its package URL. What a lockfile does not
//! record (where to download it, its checksum, a license it does not
//! state) is `NOASSERTION`, as SPDX asks.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::graph::Dependency;

/// What the document describes.
pub struct Subject<'a> {
    /// `acme/rocket`.
    pub full_name: &'a str,
    /// Where the repository is: `https://g1t.sh/acme/rocket`.
    pub url: &'a str,
    /// The commit the lockfiles were read at.
    pub commit: Option<&'a str>,
    /// A unique id for this document, such as a random hex string.
    pub unique: &'a str,
    /// RFC 3339, seconds precision, in UTC: `2026-10-07T12:00:00Z`.
    pub created: &'a str,
}

/// The characters an SPDX id may hold are letters, digits, `.` and `-`.
fn spdx_id(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let c = if c.is_ascii_alphanumeric() || c == '.' { c } else { '-' };
        if !(c == '-' && out.ends_with('-')) {
            out.push(c);
        }
    }
    out.trim_matches('-').to_owned()
}

/// A license expression SPDX accepts, or `NOASSERTION`. Lockfiles hold
/// whatever the package author wrote, so anything that is not a plain
/// expression of ids is not asserted.
fn license_field(license: Option<&str>) -> String {
    let Some(license) = license.map(str::trim).filter(|license| !license.is_empty()) else {
        return "NOASSERTION".to_owned();
    };
    // Ids joined by AND, OR and WITH: every other word an operator.
    let words: Vec<&str> = license.split(|c: char| c.is_whitespace() || c == '(' || c == ')').filter(|w| !w.is_empty()).collect();
    let id = |word: &str| word.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '+' | ':'));
    let valid = words.iter().enumerate().all(|(at, word)| {
        if at % 2 == 1 { matches!(*word, "AND" | "OR" | "WITH") } else { id(word) }
    }) && words.len() % 2 == 1;
    if valid { license.to_owned() } else { "NOASSERTION".to_owned() }
}

/// The SPDX 2.3 JSON document for `dependencies`.
pub fn spdx(subject: &Subject, dependencies: &[Dependency]) -> Value {
    let root = format!("SPDXRef-Repository-{}", spdx_id(subject.full_name));
    let mut packages = vec![json!({
        "SPDXID": root,
        "name": subject.full_name,
        "versionInfo": subject.commit.unwrap_or("NOASSERTION"),
        "downloadLocation": format!("git+{}.git", subject.url),
        "filesAnalyzed": false,
        "licenseConcluded": "NOASSERTION",
        "licenseDeclared": "NOASSERTION",
        "copyrightText": "NOASSERTION",
        "primaryPackagePurpose": "SOURCE",
        "externalRefs": [],
    })];
    let mut relationships = vec![json!({
        "spdxElementId": "SPDXRef-DOCUMENT",
        "relationshipType": "DESCRIBES",
        "relatedSpdxElement": root,
    })];
    // One package per name and version, whichever lockfiles hold it.
    let mut seen = BTreeSet::new();
    let mut sorted: Vec<&Dependency> = dependencies.iter().collect();
    sorted.sort_by(|a, b| (a.purl(), a.development, &a.manifest).cmp(&(b.purl(), b.development, &b.manifest)));
    for dep in sorted {
        let purl = dep.purl();
        if !seen.insert(purl.clone()) {
            continue;
        }
        let id = format!("SPDXRef-Package-{}", spdx_id(&format!("{}-{}-{}", crate::graph::purl_type(dep.package.ecosystem), dep.package.name, dep.package.version)));
        packages.push(json!({
            "SPDXID": id,
            "name": dep.package.name,
            "versionInfo": dep.package.version,
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": false,
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": license_field(dep.license.as_deref()),
            "copyrightText": "NOASSERTION",
            "primaryPackagePurpose": "LIBRARY",
            "comment": format!("Resolved by {} ({} dependency).", dep.manifest, dep.relationship.as_str()),
            "externalRefs": [{
                "referenceCategory": "PACKAGE-MANAGER",
                "referenceType": "purl",
                "referenceLocator": purl,
            }],
        }));
        relationships.push(if dep.development {
            json!({ "spdxElementId": id, "relationshipType": "DEV_DEPENDENCY_OF", "relatedSpdxElement": root })
        } else {
            json!({ "spdxElementId": root, "relationshipType": "DEPENDS_ON", "relatedSpdxElement": id })
        });
    }
    json!({
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": format!("{} dependency graph", subject.full_name),
        "documentNamespace": format!("{}/sbom/{}", subject.url, subject.unique),
        "creationInfo": {
            "created": subject.created,
            "creators": ["Tool: g1t", "Organization: g1t"],
            "comment": "Read from the repository's lockfiles on its default branch.",
        },
        "documentDescribes": [root],
        "packages": packages,
        "relationships": relationships,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Relationship;
    use crate::lockfiles::{Ecosystem, Package};

    fn dep(ecosystem: Ecosystem, name: &str, version: &str, development: bool, license: Option<&str>) -> Dependency {
        Dependency {
            package: Package { ecosystem, name: name.into(), version: version.into() },
            manifest: "package-lock.json".into(),
            relationship: Relationship::Direct,
            development,
            license: license.map(str::to_owned),
        }
    }

    fn document() -> Value {
        let subject = Subject {
            full_name: "acme/rocket",
            url: "https://g1t.sh/acme/rocket",
            commit: Some("4807077b296e6edbf410d55e72749d3e1170c291"),
            unique: "0f2c9d1e",
            created: "2026-10-07T12:00:00Z",
        };
        spdx(&subject, &[
            dep(Ecosystem::Npm, "@babel/core", "7.0.0", true, Some("MIT")),
            dep(Ecosystem::Npm, "lodash", "4.17.21", false, Some("MIT")),
            dep(Ecosystem::Npm, "lodash", "4.17.21", false, Some("MIT")),
            dep(Ecosystem::Cargo, "serde", "1.0.0", false, Some("see LICENSE file")),
        ])
    }

    #[test]
    fn the_document_has_what_spdx_requires() {
        let doc = document();
        assert_eq!(doc["spdxVersion"], "SPDX-2.3");
        assert_eq!(doc["dataLicense"], "CC0-1.0");
        assert_eq!(doc["SPDXID"], "SPDXRef-DOCUMENT");
        assert_eq!(doc["documentNamespace"], "https://g1t.sh/acme/rocket/sbom/0f2c9d1e");
        assert_eq!(doc["creationInfo"]["created"], "2026-10-07T12:00:00Z");
        // The repository and three packages: the duplicate lodash is one.
        let packages = doc["packages"].as_array().unwrap();
        assert_eq!(packages.len(), 4);
        let ids: Vec<&str> = packages.iter().map(|package| package["SPDXID"].as_str().unwrap()).collect();
        assert_eq!(BTreeSet::from_iter(ids.iter()).len(), ids.len(), "ids are unique");
        for id in &ids {
            assert!(id.starts_with("SPDXRef-") && id[8..].chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'), "{id}");
        }
        for package in packages {
            for field in ["name", "downloadLocation", "filesAnalyzed", "licenseConcluded", "licenseDeclared", "copyrightText"] {
                assert!(package.get(field).is_some(), "{field} in {package}");
            }
        }
        assert_eq!(packages[0]["SPDXID"], "SPDXRef-Repository-acme-rocket");
        // To check it with an SPDX validator: G1T_WRITE_SBOM=path cargo test -p g1t-scan sbom
        if let Ok(path) = std::env::var("G1T_WRITE_SBOM") {
            std::fs::write(path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
        }
        assert_eq!(doc["documentDescribes"][0], "SPDXRef-Repository-acme-rocket");
    }

    #[test]
    fn packages_are_named_by_purl_and_related_to_the_repository() {
        let doc = document();
        let packages = doc["packages"].as_array().unwrap();
        let babel = packages.iter().find(|package| package["name"] == "@babel/core").unwrap();
        assert_eq!(babel["SPDXID"], "SPDXRef-Package-npm-babel-core-7.0.0");
        assert_eq!(babel["externalRefs"][0]["referenceLocator"], "pkg:npm/%40babel/core@7.0.0");
        assert_eq!(babel["licenseDeclared"], "MIT");
        // Free text is not a license expression.
        let serde = packages.iter().find(|package| package["name"] == "serde").unwrap();
        assert_eq!(serde["licenseDeclared"], "NOASSERTION");
        let relationships = doc["relationships"].as_array().unwrap();
        assert!(relationships.iter().any(|r| r["relationshipType"] == "DEV_DEPENDENCY_OF"
            && r["spdxElementId"] == "SPDXRef-Package-npm-babel-core-7.0.0"));
        assert!(relationships.iter().any(|r| r["relationshipType"] == "DEPENDS_ON"
            && r["relatedSpdxElement"] == "SPDXRef-Package-npm-lodash-4.17.21"));
        assert_eq!(relationships.len(), 4);
    }
}
