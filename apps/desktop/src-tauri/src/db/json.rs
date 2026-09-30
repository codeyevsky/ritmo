//! JSON ⇄ SQLite value mapping, as specified in `docs/ipc.md`.
//!
//! The frontend speaks JSON over IPC, so bound parameters and result columns
//! are translated here and nowhere else — both sides of the contract depend on
//! this being the single definition.

use base64::Engine as _;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::Row;
use serde_json::{Map, Number, Value as JsonValue};

/// `i64::MAX as f64` rounds up to exactly 2^63, so the upper bound is exclusive
/// to keep the subsequent cast lossless.
const I64_MAX_AS_F64: f64 = i64::MAX as f64;
const I64_MIN_AS_F64: f64 = i64::MIN as f64;

pub fn json_to_sql(v: &JsonValue) -> SqlValue {
    match v {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(b) => SqlValue::Integer(i64::from(*b)),
        JsonValue::Number(n) => number_to_sql(n),
        JsonValue::String(s) => SqlValue::Text(s.clone()),
        // Structured values are stored as their JSON text; the schema's
        // `*_json` columns are read back with SQLite's json1 functions.
        JsonValue::Array(_) | JsonValue::Object(_) => SqlValue::Text(v.to_string()),
    }
}

fn number_to_sql(n: &Number) -> SqlValue {
    if let Some(i) = n.as_i64() {
        return SqlValue::Integer(i);
    }
    match n.as_f64() {
        Some(f) if f.fract() == 0.0 && f >= I64_MIN_AS_F64 && f < I64_MAX_AS_F64 => {
            SqlValue::Integer(f as i64)
        }
        Some(f) => SqlValue::Real(f),
        // Only reachable for a u64 above `i64::MAX` on a build where `as_f64`
        // is refused; keeping the digits beats silently truncating them.
        None => SqlValue::Text(n.to_string()),
    }
}

pub fn sql_to_json(v: ValueRef<'_>) -> JsonValue {
    match v {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(i) => JsonValue::Number(Number::from(i)),
        ValueRef::Real(f) => Number::from_f64(f).map_or(JsonValue::Null, JsonValue::Number),
        ValueRef::Text(bytes) => JsonValue::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => {
            JsonValue::String(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
    }
}

/// `names` comes from `Statement::column_names`, captured before the query
/// borrows the statement mutably.
pub fn row_to_map(row: &Row<'_>, names: &[String]) -> Map<String, JsonValue> {
    let mut map = Map::with_capacity(names.len());
    for (index, name) in names.iter().enumerate() {
        let value = row.get_ref(index).map_or(JsonValue::Null, sql_to_json);
        map.insert(name.clone(), value);
    }
    map
}
