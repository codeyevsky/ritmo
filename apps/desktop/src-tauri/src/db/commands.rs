//! Tauri commands for the database, per `docs/ipc.md`.
//!
//! This is a trusted-caller API: the only client is Ritmo's own frontend,
//! bundled into the same binary and loaded from `tauri://localhost`. Handing it
//! raw SQL is deliberate — it keeps every query in the TypeScript library layer
//! where the domain model lives, instead of duplicating a query DSL in Rust.
//! Nothing here may be exposed to remote content or to a plugin.
//!
//! `#[tauri::command(async)]` on synchronous bodies moves the SQLite work onto
//! the async runtime's thread pool, so a slow query never stalls the WebView.

use serde::Deserialize;
use serde_json::{Map, Value};
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStatement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

#[tauri::command(async)]
pub fn db_query(
    state: State<'_, AppState>,
    sql: String,
    params: Vec<Value>,
) -> AppResult<Vec<Map<String, Value>>> {
    state.db.query_json(&sql, &params)
}

#[tauri::command(async)]
pub fn db_execute(
    state: State<'_, AppState>,
    sql: String,
    params: Vec<Value>,
) -> AppResult<usize> {
    state.db.execute_json(&sql, &params)
}

#[tauri::command(async)]
pub fn db_transaction(
    state: State<'_, AppState>,
    statements: Vec<DbStatement>,
) -> AppResult<()> {
    let owned: Vec<(String, Vec<Value>)> =
        statements.into_iter().map(|s| (s.sql, s.params)).collect();
    state.db.transaction_json(&owned)
}

#[tauri::command(async)]
pub fn db_maintenance(state: State<'_, AppState>) -> AppResult<()> {
    state.db.maintenance()
}

#[tauri::command(async)]
pub fn kv_get(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    state.db.kv_get(&key)
}

#[tauri::command(async)]
pub fn kv_set(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    state.db.kv_set(&key, &value)
}

#[tauri::command(async)]
pub fn kv_remove(state: State<'_, AppState>, key: String) -> AppResult<()> {
    state.db.kv_remove(&key)
}

#[tauri::command(async)]
pub fn kv_keys(state: State<'_, AppState>, prefix: Option<String>) -> AppResult<Vec<String>> {
    state.db.kv_keys(prefix.as_deref())
}
