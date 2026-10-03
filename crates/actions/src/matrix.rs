//! `strategy.matrix`: every combination of its values, less `exclude`,
//! plus `include`, the way GitHub expands it.

use serde_json::{Map, Value};

/// The most jobs one matrix may make, as on GitHub.
pub const MAX_JOBS: usize = 256;

/// One combination: the matrix's keys, in the file's order, and values.
pub type Combination = Map<String, Value>;

/// Expands a matrix. `Ok(vec![])` means it made no jobs, which GitHub
/// treats as an error the caller reports.
pub fn expand(matrix: &Value) -> Result<Vec<Combination>, String> {
    let Value::Object(matrix) = matrix else {
        return Err("`strategy.matrix` is a mapping of names to lists of values.".to_owned());
    };
    let mut combinations: Vec<Combination> = vec![Map::new()];
    let mut dimensions = 0;
    for (key, values) in matrix {
        if key == "include" || key == "exclude" {
            continue;
        }
        let Value::Array(values) = values else {
            return Err(format!("`matrix.{key}` is a list of values."));
        };
        dimensions += 1;
        let mut next = Vec::with_capacity(combinations.len() * values.len());
        for combination in &combinations {
            for value in values {
                let mut extended = combination.clone();
                extended.insert(key.clone(), value.clone());
                next.push(extended);
            }
        }
        combinations = next;
        if combinations.len() > MAX_JOBS {
            return Err(format!("The matrix makes more than {MAX_JOBS} jobs."));
        }
    }
    if dimensions == 0 {
        combinations.clear();
    }

    if let Some(exclude) = matrix.get("exclude") {
        let Value::Array(excludes) = exclude else {
            return Err("`matrix.exclude` is a list of combinations.".to_owned());
        };
        for exclude in excludes {
            let Value::Object(exclude) = exclude else {
                return Err("Each `matrix.exclude` entry is a mapping.".to_owned());
            };
            combinations.retain(|combination| !partial_match(combination, exclude));
        }
    }

    if let Some(include) = matrix.get("include") {
        let Value::Array(includes) = include else {
            return Err("`matrix.include` is a list of combinations.".to_owned());
        };
        // The keys of the original matrix, whose values an include may not change.
        let originals: Vec<&String> = matrix.keys().filter(|key| *key != "include" && *key != "exclude").collect();
        let base_count = combinations.len();
        for include in includes {
            let Value::Object(include) = include else {
                return Err("Each `matrix.include` entry is a mapping.".to_owned());
            };
            let mut added = false;
            for combination in combinations.iter_mut().take(base_count) {
                let overwrites_original = include
                    .iter()
                    .any(|(key, value)| originals.contains(&key) && combination.get(key).is_some_and(|existing| existing != value));
                if !overwrites_original {
                    for (key, value) in include {
                        combination.insert(key.clone(), value.clone());
                    }
                    added = true;
                }
            }
            if !added {
                combinations.push(include.clone());
            }
        }
    }
    if combinations.len() > MAX_JOBS {
        return Err(format!("The matrix makes more than {MAX_JOBS} jobs."));
    }
    Ok(combinations)
}

fn partial_match(combination: &Combination, pattern: &Map<String, Value>) -> bool {
    pattern.iter().all(|(key, value)| match (combination.get(key), value) {
        (Some(Value::Object(inner)), Value::Object(pattern)) => partial_match(inner, pattern),
        (Some(actual), expected) => actual == expected,
        (None, _) => false,
    })
}

/// A job's name with its combination, as GitHub shows it:
/// `test (ubuntu-latest, 18)`. Objects in the combination are left out.
pub fn job_name(name: &str, combination: &Combination) -> String {
    let values: Vec<String> = combination
        .values()
        .filter_map(|value| match value {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        })
        .collect();
    if values.is_empty() { name.to_owned() } else { format!("{name} ({})", values.join(", ")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn names(combinations: &[Combination]) -> Vec<String> {
        combinations.iter().map(|c| job_name("test", c)).collect()
    }

    #[test]
    fn products_in_file_order() {
        let jobs = expand(&json!({ "os": ["ubuntu-latest", "windows-latest"], "node": [18, 20] })).unwrap();
        assert_eq!(
            names(&jobs),
            ["test (ubuntu-latest, 18)", "test (ubuntu-latest, 20)", "test (windows-latest, 18)", "test (windows-latest, 20)"]
        );
    }

    #[test]
    fn excludes_partial_matches() {
        let jobs = expand(&json!({
            "os": ["macos", "windows"], "version": [12, 14, 16], "environment": ["staging", "production"],
            "exclude": [{ "os": "macos", "version": 12, "environment": "production" }, { "os": "windows", "version": 16 }]
        }))
        .unwrap();
        assert_eq!(jobs.len(), 12 - 1 - 2);
    }

    #[test]
    fn includes_extend_or_add_as_github_documents() {
        // GitHub's own example.
        let jobs = expand(&json!({
            "fruit": ["apple", "pear"], "animal": ["cat", "dog"],
            "include": [
                { "color": "green" },
                { "color": "pink", "animal": "cat" },
                { "fruit": "apple", "shape": "circle" },
                { "fruit": "banana" },
                { "fruit": "banana", "animal": "cat" }
            ]
        }))
        .unwrap();
        let expected = vec![
            json!({ "fruit": "apple", "animal": "cat", "color": "pink", "shape": "circle" }),
            json!({ "fruit": "apple", "animal": "dog", "color": "green", "shape": "circle" }),
            json!({ "fruit": "pear", "animal": "cat", "color": "pink" }),
            json!({ "fruit": "pear", "animal": "dog", "color": "green" }),
            json!({ "fruit": "banana" }),
            json!({ "fruit": "banana", "animal": "cat" }),
        ];
        let got: Vec<Value> = jobs.into_iter().map(Value::Object).collect();
        assert_eq!(got, expected);
    }

    #[test]
    fn include_only_and_limits() {
        let jobs = expand(&json!({ "include": [{ "site": "a" }, { "site": "b" }] })).unwrap();
        assert_eq!(names(&jobs), ["test (a)", "test (b)"]);
        let big: Vec<u32> = (0..20).collect();
        assert!(expand(&json!({ "a": big, "b": big })).unwrap_err().contains("256"));
        assert!(expand(&json!({ "os": "linux" })).is_err());
        assert!(expand(&json!({})).unwrap().is_empty());
    }
}
