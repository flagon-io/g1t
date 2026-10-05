//! Running [`Sql`] against D1.

use serde::Deserialize;
use serde::de::DeserializeOwned;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, Result};

use crate::sql::{Param, Sql};

fn value(param: &Param) -> JsValue {
    match param {
        Param::Text(text) => JsValue::from(text.as_str()),
        // Every number bound is a page size, an offset or a count.
        Param::Int(number) => JsValue::from(*number as f64),
        Param::Null => JsValue::NULL,
    }
}

pub fn statement(db: &D1Database, sql: &Sql) -> Result<D1PreparedStatement> {
    let values: Vec<JsValue> = sql.params.iter().map(value).collect();
    db.prepare(&sql.text).bind(&values)
}

/// A statement from SQL text and values.
pub fn prepare(db: &D1Database, text: &str, params: Vec<Param>) -> Result<D1PreparedStatement> {
    statement(db, &Sql { text: text.to_owned(), params })
}

pub async fn all<T: DeserializeOwned>(db: &D1Database, sql: &Sql) -> Result<Vec<T>> {
    statement(db, sql)?.all().await?.results::<T>()
}

pub async fn count(db: &D1Database, sql: &Sql) -> Result<u32> {
    #[derive(Deserialize)]
    struct Count {
        n: u32,
    }
    Ok(statement(db, sql)?.first::<Count>(None).await?.map_or(0, |row| row.n))
}

/// Runs statements in batches of at most 50, each batch all or nothing.
pub async fn run_all(db: &D1Database, statements: Vec<D1PreparedStatement>) -> Result<()> {
    let mut statements = statements;
    while !statements.is_empty() {
        let rest = statements.split_off(statements.len().min(50));
        db.batch(statements).await?;
        statements = rest;
    }
    Ok(())
}
