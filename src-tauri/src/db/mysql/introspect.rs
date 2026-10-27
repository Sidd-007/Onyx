use std::collections::{BTreeMap, HashMap};

use mysql_async::prelude::Queryable;
use mysql_async::Conn;

use super::MySession;
use crate::db::model::{
    CheckInfo, ColumnInfo, CompletionTable, DbObject, ForeignKeyInfo, ForeignKeyRef, IncomingReference, IndexInfo,
    StructureColumn, TableSnapshot, TableStructure, TriggerInfo,
};
use crate::error::Result;

const SYSTEM_SCHEMAS: &str = "('information_schema', 'mysql', 'performance_schema', 'sys')";

impl MySession {
    /// MySQL calls them databases; the tree shows them where Postgres shows schemas.
    pub async fn schemas(&self) -> Result<Vec<String>> {
        let mut conn = self.meta.lock().await;
        let sql = format!(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN {SYSTEM_SCHEMAS} ORDER BY 1"
        );
        Ok(conn.query(sql).await?)
    }

    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        let mut conn = self.meta.lock().await;
        let tables: Vec<(String, String, Option<u64>, Option<u64>)> = conn
            .exec(
                "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
                (schema,),
            )
            .await?;
        let routines: Vec<(String, String)> = conn
            .exec(
                "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?",
                (schema,),
            )
            .await?;

        let mut objects: Vec<DbObject> = tables
            .into_iter()
            .map(|(name, kind, rows, size)| {
                let table = kind == "BASE TABLE";
                DbObject {
                    name,
                    kind: if table { "table" } else { "view" },
                    detail: None,
                    estimated_rows: rows.filter(|_| table).map(|r| r as i64),
                    size_bytes: size.map(|s| s as i64),
                }
            })
            .chain(routines.into_iter().map(|(name, kind)| DbObject {
                name,
                kind: if kind == "PROCEDURE" { "procedure" } else { "function" },
                detail: None,
                estimated_rows: None,
                size_bytes: None,
            }))
            .collect();
        objects.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(objects)
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        let mut conn = self.meta.lock().await;
        let rows: Vec<(String, String, String, String, Option<String>)> = conn
            .exec(
                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                 ORDER BY ORDINAL_POSITION",
                (schema, table),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|(name, data_type, nullable, key, default)| ColumnInfo {
                name,
                data_type,
                nullable: nullable == "YES",
                primary_key: key == "PRI",
                default,
            })
            .collect())
    }

    pub async fn completion_tables(&self) -> Result<Vec<CompletionTable>> {
        let mut conn = self.meta.lock().await;
        let sql = format!(
            "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA NOT IN {SYSTEM_SCHEMAS}
             ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"
        );
        let rows: Vec<(String, String, String, String)> = conn.query(sql).await?;
        let mut tables: Vec<CompletionTable> = Vec::new();
        for (schema, name, column, ty) in rows {
            match tables.last_mut() {
                Some(t) if t.schema == schema && t.name == name => {
                    t.columns.push(column);
                    t.types.push(ty);
                }
                _ => tables.push(CompletionTable { schema, name, columns: vec![column], types: vec![ty] }),
            }
        }
        Ok(tables)
    }

    pub async fn structure(&self, schema: &str, table: &str) -> Result<TableStructure> {
        let mut conn = self.meta.lock().await;
        type ColumnRow = (String, String, String, Option<String>, String, String, String);
        let rows: Vec<ColumnRow> = conn
            .exec(
                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                 ORDER BY ORDINAL_POSITION",
                (schema, table),
            )
            .await?;
        let columns = rows
            .into_iter()
            .map(|(name, data_type, nullable, default, key, extra, comment)| StructureColumn {
                name,
                data_type,
                nullable: nullable == "YES",
                default,
                primary_key: key == "PRI",
                extra: Some(extra).filter(|e| !e.is_empty()),
                comment: Some(comment).filter(|c| !c.is_empty()),
            })
            .collect();

        let mut indexes = index_rows(&mut conn, "TABLE_SCHEMA = ? AND TABLE_NAME = ?", (schema, table))
            .await?
            .remove(table)
            .unwrap_or_default();
        // Sizes and usage need extra privileges: best-effort.
        let sizes: Vec<(String, u64)> = conn
            .exec(
                "SELECT index_name, stat_value * @@innodb_page_size FROM mysql.innodb_index_stats
                 WHERE database_name = ? AND table_name = ? AND stat_name = 'size'",
                (schema, table),
            )
            .await
            .unwrap_or_default();
        let usage: Vec<(String, u64)> = conn
            .exec(
                "SELECT INDEX_NAME, COUNT_STAR FROM performance_schema.table_io_waits_summary_by_index_usage
                 WHERE OBJECT_SCHEMA = ? AND OBJECT_NAME = ? AND INDEX_NAME IS NOT NULL",
                (schema, table),
            )
            .await
            .unwrap_or_default();
        let sizes: HashMap<String, u64> = sizes.into_iter().collect();
        let usage: HashMap<String, u64> = usage.into_iter().collect();
        for index in &mut indexes {
            index.size_bytes = sizes.get(&index.name).map(|&s| s as i64);
            index.scans = usage.get(&index.name).map(|&s| s as i64);
        }

        let foreign_keys = foreign_key_rows(&mut conn, "k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?", (schema, table))
            .await?
            .into_iter()
            .map(|f| f.key)
            .collect();

        type InRow = (String, String, String, String, String);
        let in_rows: Vec<InRow> = conn
            .exec(
                "SELECT CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_COLUMN_NAME
                 FROM information_schema.KEY_COLUMN_USAGE
                 WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
                 ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION",
                (schema, table),
            )
            .await?;
        let mut referenced_by: Vec<IncomingReference> = Vec::new();
        for (name, from_schema, from_table, column, ref_column) in in_rows {
            let same = referenced_by
                .last()
                .is_some_and(|r| r.name == name && r.schema == from_schema && r.table == from_table);
            if !same {
                referenced_by.push(IncomingReference {
                    name,
                    schema: from_schema,
                    table: from_table,
                    columns: vec![],
                    ref_columns: vec![],
                });
            }
            let r = referenced_by.last_mut().unwrap();
            r.columns.push(column);
            r.ref_columns.push(ref_column);
        }

        // CHECK constraints arrived in MySQL 8.0.16.
        let check_rows: Vec<(String, String)> = conn
            .exec(
                "SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc
                 JOIN information_schema.CHECK_CONSTRAINTS cc
                   ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                 WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'
                 ORDER BY 1",
                (schema, table),
            )
            .await
            .unwrap_or_default();
        let checks = check_rows
            .into_iter()
            .map(|(name, clause)| CheckInfo { name, kind: "check".into(), definition: format!("CHECK {clause}") })
            .collect();

        let trigger_rows: Vec<(String, String, String, String)> = conn
            .exec(
                "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT FROM information_schema.TRIGGERS
                 WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER",
                (schema, table),
            )
            .await?;
        let ident = |s: &str| format!("`{}`", s.replace('`', "``"));
        let triggers = trigger_rows
            .into_iter()
            .map(|(name, timing, event, statement)| TriggerInfo {
                definition: format!("CREATE TRIGGER {} {timing} {event} ON {} FOR EACH ROW {statement}", ident(&name), ident(table)),
                timing: format!("{timing} {event}"),
                name,
            })
            .collect();

        let show: Option<mysql_async::Row> =
            conn.query_first(format!("SHOW CREATE TABLE {}.{}", ident(schema), ident(table))).await?;
        let ddl = show.and_then(|r| r.get::<String, _>(1)).unwrap_or_default();
        Ok(TableStructure { columns, indexes, foreign_keys, referenced_by, checks, triggers, ddl })
    }

    pub async fn all_foreign_keys(&self) -> Result<Vec<ForeignKeyRef>> {
        let mut conn = self.meta.lock().await;
        foreign_key_rows(&mut conn, &format!("k.TABLE_SCHEMA NOT IN {SYSTEM_SCHEMAS}"), ()).await
    }

    pub async fn snapshot(&self, schema: &str) -> Result<Vec<TableSnapshot>> {
        let mut conn = self.meta.lock().await;
        let kinds: Vec<(String, String)> = conn
            .exec("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", (schema,))
            .await?;
        let mut tables: BTreeMap<String, TableSnapshot> = kinds
            .into_iter()
            .map(|(name, kind)| {
                let kind = if kind == "BASE TABLE" { "table" } else { "view" }.to_owned();
                (name.clone(), TableSnapshot { name, kind, columns: vec![], indexes: vec![], foreign_keys: vec![] })
            })
            .collect();
        type ColumnRow = (String, String, String, String, Option<String>, String, String, String);
        let rows: Vec<ColumnRow> = conn
            .exec(
                "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
                (schema,),
            )
            .await?;
        for (table, name, data_type, nullable, default, key, extra, comment) in rows {
            if let Some(t) = tables.get_mut(&table) {
                t.columns.push(StructureColumn {
                    name,
                    data_type,
                    nullable: nullable == "YES",
                    default,
                    primary_key: key == "PRI",
                    extra: Some(extra).filter(|e| !e.is_empty()),
                    comment: Some(comment).filter(|c| !c.is_empty()),
                });
            }
        }
        for (table, indexes) in index_rows(&mut conn, "TABLE_SCHEMA = ?", (schema,)).await? {
            if let Some(t) = tables.get_mut(&table) {
                t.indexes = indexes;
            }
        }
        for fk in foreign_key_rows(&mut conn, "k.TABLE_SCHEMA = ?", (schema,)).await? {
            if let Some(t) = tables.get_mut(&fk.table) {
                t.foreign_keys.push(fk.key);
            }
        }
        Ok(tables.into_values().collect())
    }
}

/// Indexes per table, matching `filter` on information_schema.STATISTICS.
async fn index_rows(
    conn: &mut Conn,
    filter: &str,
    params: impl Into<mysql_async::Params> + Send,
) -> Result<BTreeMap<String, Vec<IndexInfo>>> {
    let rows: Vec<(String, String, i64, Option<String>)> = conn
        .exec(
            format!(
                "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS
                 WHERE {filter} ORDER BY TABLE_NAME, INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX"
            ),
            params,
        )
        .await?;
    let mut tables: BTreeMap<String, Vec<IndexInfo>> = BTreeMap::new();
    for (table, name, non_unique, column) in rows {
        let indexes = tables.entry(table).or_default();
        if indexes.last().is_none_or(|i| i.name != name) {
            indexes.push(IndexInfo {
                primary: name == "PRIMARY",
                name,
                columns: vec![],
                unique: non_unique == 0,
                size_bytes: None,
                scans: None,
            });
        }
        if let (Some(index), Some(column)) = (indexes.last_mut(), column) {
            index.columns.push(column);
        }
    }
    Ok(tables)
}

/// Foreign keys matching `filter` (on KEY_COLUMN_USAGE as k), one entry per constraint.
async fn foreign_key_rows(
    conn: &mut Conn,
    filter: &str,
    params: impl Into<mysql_async::Params> + Send,
) -> Result<Vec<ForeignKeyRef>> {
    type FkRow = (String, String, String, String, String, String, String, String, String);
    let rows: Vec<FkRow> = conn
        .exec(
            format!(
                "SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA,
                        k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
                 FROM information_schema.KEY_COLUMN_USAGE k
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                   ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                 WHERE {filter}
                 ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
            ),
            params,
        )
        .await?;
    let mut keys: Vec<ForeignKeyRef> = Vec::new();
    for (schema, table, name, column, ref_schema, ref_table, ref_column, on_update, on_delete) in rows {
        let same = keys.last().is_some_and(|k| k.key.name == name && k.schema == schema && k.table == table);
        if !same {
            keys.push(ForeignKeyRef {
                schema,
                table,
                key: ForeignKeyInfo { name, columns: vec![], ref_schema, ref_table, ref_columns: vec![], on_update, on_delete },
            });
        }
        let k = keys.last_mut().unwrap();
        k.key.columns.push(column);
        k.key.ref_columns.push(ref_column);
    }
    Ok(keys)
}
