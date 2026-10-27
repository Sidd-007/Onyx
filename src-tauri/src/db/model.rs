//! Shapes the UI sees, shared by every engine.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub server_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub name: String,
    /// table | partitioned-table | view | materialized-view | foreign-table | sequence | function | procedure
    pub kind: &'static str,
    /// Function arguments, e.g. "uid bigint".
    pub detail: Option<String>,
    pub estimated_rows: Option<i64>,
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default: Option<String>,
}

/// Every table and view with its column names, for editor autocomplete.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionTable {
    pub schema: String,
    pub name: String,
    pub columns: Vec<String>,
    /// Column types, parallel to `columns`.
    pub types: Vec<String>,
}

/// Everything the Structure view shows about one table or view.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub columns: Vec<StructureColumn>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    /// Foreign keys in other tables that point at this one.
    pub referenced_by: Vec<IncomingReference>,
    /// CHECK, UNIQUE and EXCLUDE constraints (primary and foreign keys are listed above).
    pub checks: Vec<CheckInfo>,
    pub triggers: Vec<TriggerInfo>,
    /// CREATE statement (MySQL's own; rebuilt from the catalog on Postgres).
    pub ddl: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub primary_key: bool,
    /// auto_increment, identity, generated, on update …
    pub extra: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    /// On-disk size, where the engine reports it.
    pub size_bytes: Option<i64>,
    /// Index scans since statistics were reset (Postgres), for spotting unused indexes.
    pub scans: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInfo {
    pub name: String,
    /// check | unique | exclude
    pub kind: String,
    pub definition: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    /// e.g. "BEFORE UPDATE"
    pub timing: String,
    pub definition: String,
}

/// A foreign key anywhere in the database, for JOIN suggestions.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyRef {
    pub schema: String,
    pub table: String,
    #[serde(flatten)]
    pub key: ForeignKeyInfo,
}

/// One table of a schema, for the ER diagram and schema diff.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSnapshot {
    pub name: String,
    /// table | view
    pub kind: String,
    pub columns: Vec<StructureColumn>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingReference {
    pub name: String,
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
    /// Columns of this table they point at.
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}
