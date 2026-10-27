use super::PgSession;
use std::collections::BTreeMap;

use crate::db::model::{
    CheckInfo, ColumnInfo, CompletionTable, DbObject, ForeignKeyInfo, ForeignKeyRef, IncomingReference, IndexInfo,
    StructureColumn, TableSnapshot, TableStructure, TriggerInfo,
};
use crate::error::Result;

const USER_SCHEMAS: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') \
     AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'";

/// Indexes with their size and scan count; filter with a WHERE on n (schema) and t (table).
const INDEXES: &str = "SELECT i.relname::text,
        coalesce(array_agg(a.attname::text ORDER BY k.ord) FILTER (WHERE a.attname IS NOT NULL), '{}'),
        ix.indisunique, ix.indisprimary, t.relname::text,
        pg_relation_size(ix.indexrelid), max(s.idx_scan)
 FROM pg_index ix
 JOIN pg_class t ON t.oid = ix.indrelid
 JOIN pg_namespace n ON n.oid = t.relnamespace
 JOIN pg_class i ON i.oid = ix.indexrelid
 LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
 CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
 LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum";
const INDEXES_GROUP: &str =
    "GROUP BY i.relname, ix.indisunique, ix.indisprimary, t.relname, ix.indexrelid ORDER BY ix.indisprimary DESC, 1";

fn index_row(r: &tokio_postgres::Row) -> IndexInfo {
    IndexInfo {
        name: r.get(0),
        columns: r.get(1),
        unique: r.get(2),
        primary: r.get(3),
        size_bytes: r.get(5),
        scans: r.get(6),
    }
}

/// Foreign keys as (schema, table, constraint, columns, ref schema, ref table, ref columns, on update, on delete).
const FOREIGN_KEYS: &str = "SELECT n.nspname::text, t.relname::text, con.conname::text,
        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o),
        fn.nspname::text, ft.relname::text,
        ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o),
        con.confupdtype::text, con.confdeltype::text
 FROM pg_constraint con
 JOIN pg_class t ON t.oid = con.conrelid
 JOIN pg_namespace n ON n.oid = t.relnamespace
 JOIN pg_class ft ON ft.oid = con.confrelid
 JOIN pg_namespace fn ON fn.oid = ft.relnamespace";

fn foreign_key_row(r: &tokio_postgres::Row) -> ForeignKeyRef {
    let action = |code: &str| {
        match code {
            "r" => "RESTRICT",
            "c" => "CASCADE",
            "n" => "SET NULL",
            "d" => "SET DEFAULT",
            _ => "NO ACTION",
        }
        .to_owned()
    };
    ForeignKeyRef {
        schema: r.get(0),
        table: r.get(1),
        key: ForeignKeyInfo {
            name: r.get(2),
            columns: r.get(3),
            ref_schema: r.get(4),
            ref_table: r.get(5),
            ref_columns: r.get(6),
            on_update: action(r.get(7)),
            on_delete: action(r.get(8)),
        },
    }
}

/// "BEFORE INSERT OR UPDATE" from "CREATE TRIGGER name BEFORE INSERT OR UPDATE ON …".
pub(crate) fn trigger_timing(definition: &str, name: &str) -> String {
    let upper = definition.to_ascii_uppercase();
    let start = upper.find(&name.to_ascii_uppercase()).map_or(0, |i| i + name.len());
    let end = upper[start..].find(" ON ").map_or(upper.len(), |i| start + i);
    definition[start..end].trim().trim_matches('"').trim().to_owned()
}

impl PgSession {
    pub async fn schemas(&self) -> Result<Vec<String>> {
        let sql = format!("SELECT n.nspname FROM pg_namespace n WHERE {USER_SCHEMAS} ORDER BY 1");
        let rows = self.meta.query(&sql, &[]).await?;
        Ok(rows.iter().map(|r| r.get(0)).collect())
    }

    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        let rows = self
            .meta
            .query(
                "SELECT c.relname, c.relkind::text, NULL::text,
                        CASE WHEN c.relkind IN ('r', 'm', 'p') AND c.reltuples >= 0 THEN c.reltuples::bigint END,
                        CASE WHEN c.relkind IN ('r', 'm') THEN pg_total_relation_size(c.oid) END
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND NOT c.relispartition
                 UNION ALL
                 SELECT p.proname, CASE p.prokind WHEN 'p' THEN 'proc' ELSE 'fn' END,
                        pg_get_function_identity_arguments(p.oid), NULL, NULL
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
                 UNION ALL
                 SELECT t.typname, 'enum',
                        (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid),
                        NULL, NULL
                 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = $1 AND t.typtype = 'e'
                 ORDER BY 1",
                &[&schema],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| DbObject {
                name: r.get(0),
                kind: match r.get::<_, &str>(1) {
                    "r" => "table",
                    "p" => "partitioned-table",
                    "v" => "view",
                    "m" => "materialized-view",
                    "f" => "foreign-table",
                    "S" => "sequence",
                    "proc" => "procedure",
                    "enum" => "enum",
                    _ => "function",
                },
                detail: r.get(2),
                estimated_rows: r.get(3),
                size_bytes: r.get(4),
            })
            .collect())
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        let rows = self
            .meta
            .query(
                "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                        EXISTS (SELECT 1 FROM pg_index i
                                WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)),
                        pg_get_expr(d.adbin, d.adrelid)
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum",
                &[&schema, &table],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| ColumnInfo {
                name: r.get(0),
                data_type: r.get(1),
                nullable: r.get(2),
                primary_key: r.get(3),
                default: r.get(4),
            })
            .collect())
    }

    pub async fn completion_tables(&self) -> Result<Vec<CompletionTable>> {
        let sql = format!(
            "SELECT n.nspname, c.relname,
                    coalesce(array_agg(a.attname ORDER BY a.attnum) FILTER (WHERE a.attnum > 0), '{{}}'),
                    coalesce(array_agg(format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum) FILTER (WHERE a.attnum > 0), '{{}}')
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
             WHERE {USER_SCHEMAS} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
             GROUP BY n.nspname, c.relname
             ORDER BY 1, 2"
        );
        let rows = self.meta.query(&sql, &[]).await?;
        Ok(rows
            .iter()
            .map(|r| CompletionTable { schema: r.get(0), name: r.get(1), columns: r.get(2), types: r.get(3) })
            .collect())
    }

    pub async fn structure(&self, schema: &str, table: &str) -> Result<TableStructure> {
        let rows = self
            .meta
            .query(
                "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                        pg_get_expr(d.adbin, d.adrelid),
                        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)),
                        CASE WHEN a.attidentity = 'a' THEN 'identity always'
                             WHEN a.attidentity = 'd' THEN 'identity by default'
                             WHEN a.attgenerated = 's' THEN 'generated' END,
                        col_description(c.oid, a.attnum)
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum",
                &[&schema, &table],
            )
            .await?;
        let columns: Vec<StructureColumn> = rows
            .iter()
            .map(|r| StructureColumn {
                name: r.get(0),
                data_type: r.get(1),
                nullable: r.get(2),
                default: r.get(3),
                primary_key: r.get(4),
                extra: r.get(5),
                comment: r.get(6),
            })
            .collect();

        let indexes = self
            .meta
            .query(
                &format!("{INDEXES} WHERE n.nspname = $1 AND t.relname = $2 {INDEXES_GROUP}"),
                &[&schema, &table],
            )
            .await?
            .iter()
            .map(index_row)
            .collect();

        let foreign_keys = self
            .meta
            .query(&format!("{FOREIGN_KEYS} WHERE con.contype = 'f' AND n.nspname = $1 AND t.relname = $2 ORDER BY 3"), &[&schema, &table])
            .await?
            .iter()
            .map(|r| foreign_key_row(r).key)
            .collect();

        let referenced_by = self
            .meta
            .query(
                "SELECT con.conname::text, n.nspname::text, t.relname::text,
                        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
                              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o),
                        ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
                              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o)
                 FROM pg_constraint con
                 JOIN pg_class t ON t.oid = con.conrelid
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                 JOIN pg_class ft ON ft.oid = con.confrelid
                 JOIN pg_namespace fn ON fn.oid = ft.relnamespace
                 WHERE con.contype = 'f' AND fn.nspname = $1 AND ft.relname = $2
                 ORDER BY 2, 3, 1",
                &[&schema, &table],
            )
            .await?
            .iter()
            .map(|r| IncomingReference {
                name: r.get(0),
                schema: r.get(1),
                table: r.get(2),
                columns: r.get(3),
                ref_columns: r.get(4),
            })
            .collect();

        let checks = self
            .meta
            .query(
                "SELECT con.conname::text,
                        CASE con.contype WHEN 'c' THEN 'check' WHEN 'u' THEN 'unique' ELSE 'exclude' END,
                        pg_get_constraintdef(con.oid, true)
                 FROM pg_constraint con
                 JOIN pg_class t ON t.oid = con.conrelid
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                 WHERE con.contype IN ('c', 'u', 'x') AND n.nspname = $1 AND t.relname = $2
                 ORDER BY 1",
                &[&schema, &table],
            )
            .await?
            .iter()
            .map(|r| CheckInfo { name: r.get(0), kind: r.get(1), definition: r.get(2) })
            .collect();

        let triggers = self
            .meta
            .query(
                "SELECT tg.tgname::text, pg_get_triggerdef(tg.oid, true)
                 FROM pg_trigger tg
                 JOIN pg_class t ON t.oid = tg.tgrelid
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                 WHERE NOT tg.tgisinternal AND n.nspname = $1 AND t.relname = $2
                 ORDER BY 1",
                &[&schema, &table],
            )
            .await?
            .iter()
            .map(|r| {
                let name: String = r.get(0);
                let definition: String = r.get(1);
                TriggerInfo { timing: trigger_timing(&definition, &name), name, definition }
            })
            .collect();

        let ddl = self.ddl(schema, table, &columns).await?;
        Ok(TableStructure { columns, indexes, foreign_keys, referenced_by, checks, triggers, ddl })
    }

    /// Every foreign key in the user's schemas.
    pub async fn all_foreign_keys(&self) -> Result<Vec<ForeignKeyRef>> {
        let sql = format!("{FOREIGN_KEYS} WHERE con.contype = 'f' AND {USER_SCHEMAS} ORDER BY 1, 2, 3");
        Ok(self.meta.query(&sql, &[]).await?.iter().map(foreign_key_row).collect())
    }

    /// Columns, indexes and foreign keys of every table and view in a schema, in three queries.
    pub async fn snapshot(&self, schema: &str) -> Result<Vec<TableSnapshot>> {
        let mut tables: BTreeMap<String, TableSnapshot> = BTreeMap::new();
        let rows = self
            .meta
            .query(
                "SELECT c.relname::text, CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END,
                        a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                        pg_get_expr(d.adbin, d.adrelid),
                        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)),
                        CASE WHEN a.attidentity = 'a' THEN 'identity always'
                             WHEN a.attidentity = 'd' THEN 'identity by default'
                             WHEN a.attgenerated = 's' THEN 'generated' END,
                        col_description(c.oid, a.attnum)
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
                 ORDER BY c.relname, a.attnum",
                &[&schema],
            )
            .await?;
        for r in &rows {
            let name: String = r.get(0);
            let kind: String = r.get(1);
            tables
                .entry(name.clone())
                .or_insert_with(|| TableSnapshot { name, kind, columns: vec![], indexes: vec![], foreign_keys: vec![] })
                .columns
                .push(StructureColumn {
                    name: r.get(2),
                    data_type: r.get(3),
                    nullable: r.get(4),
                    default: r.get(5),
                    primary_key: r.get(6),
                    extra: r.get(7),
                    comment: r.get(8),
                });
        }
        let indexes = self.meta.query(&format!("{INDEXES} WHERE n.nspname = $1 {INDEXES_GROUP}"), &[&schema]).await?;
        for r in &indexes {
            let table: String = r.get(4);
            if let Some(t) = tables.get_mut(&table) {
                t.indexes.push(index_row(r));
            }
        }
        let fks = self
            .meta
            .query(&format!("{FOREIGN_KEYS} WHERE con.contype = 'f' AND n.nspname = $1 ORDER BY 2, 3"), &[&schema])
            .await?;
        for r in &fks {
            let fk = foreign_key_row(r);
            if let Some(t) = tables.get_mut(&fk.table) {
                t.foreign_keys.push(fk.key);
            }
        }
        Ok(tables.into_values().collect())
    }

    /// Postgres has no SHOW CREATE TABLE: rebuild it from the catalog.
    async fn ddl(&self, schema: &str, table: &str, columns: &[StructureColumn]) -> Result<String> {
        let ident = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let name = format!("{}.{}", ident(schema), ident(table));
        let kind: String = self
            .meta
            .query_one(
                "SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relname = $2",
                &[&schema, &table],
            )
            .await?
            .get(0);
        if kind == "v" || kind == "m" {
            let definition: String = self
                .meta
                .query_one(
                    "SELECT pg_get_viewdef((quote_ident($1) || '.' || quote_ident($2))::regclass, true)",
                    &[&schema, &table],
                )
                .await?
                .get(0);
            let what = if kind == "m" { "MATERIALIZED VIEW" } else { "VIEW" };
            return Ok(format!("CREATE {what} {name} AS\n{}", definition.trim_end()));
        }

        let mut lines: Vec<String> = columns
            .iter()
            .map(|c| {
                let mut line = format!("  {} {}", ident(&c.name), c.data_type);
                if let Some(extra) = c.extra.as_deref().filter(|e| e.starts_with("identity")) {
                    line += &format!(" GENERATED {} AS IDENTITY", if extra.ends_with("always") { "ALWAYS" } else { "BY DEFAULT" });
                } else if let Some(default) = &c.default {
                    line += &format!(" DEFAULT {default}");
                }
                if !c.nullable {
                    line += " NOT NULL";
                }
                line
            })
            .collect();
        let constraints = self
            .meta
            .query(
                "SELECT conname::text, pg_get_constraintdef(oid, true) FROM pg_constraint
                 WHERE conrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass
                 ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, conname",
                &[&schema, &table],
            )
            .await?;
        for r in &constraints {
            lines.push(format!("  CONSTRAINT {} {}", ident(r.get::<_, &str>(0)), r.get::<_, &str>(1)));
        }
        let mut ddl = format!("CREATE TABLE {name} (\n{}\n);", lines.join(",\n"));
        let indexes = self
            .meta
            .query(
                "SELECT pg_get_indexdef(ix.indexrelid) FROM pg_index ix
                 WHERE ix.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass
                   AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
                 ORDER BY 1",
                &[&schema, &table],
            )
            .await?;
        for r in &indexes {
            ddl += &format!("\n{};", r.get::<_, &str>(0));
        }
        Ok(ddl)
    }
}
