import pg from "pg";
import type { Config } from "./config.ts";

export type Db = {
  pool: pg.Pool;
  schema: string;
  timeoutMs: number;
  maxRows: number;
};

export function createDb(config: Config): Db {
  const pool = new pg.Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_DATABASE,
    ssl: config.DB_SSL ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    application_name: "kaderisasi-mcp",
  });
  return {
    pool,
    schema: config.DB_SCHEMA,
    timeoutMs: config.QUERY_TIMEOUT_MS,
    maxRows: config.QUERY_MAX_ROWS,
  };
}

// Every statement runs in a READ ONLY transaction that is always rolled back.
export async function readOnly<T>(
  db: Db,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(
      `SET LOCAL statement_timeout = ${Math.floor(db.timeoutMs)}`,
    );
    await client.query(`SET LOCAL search_path = "${db.schema}"`);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

export type TableSummary = {
  table: string;
  approx_rows: number | null;
  comment: string | null;
  readable_columns: number;
  total_columns: number;
};

export async function listTables(db: Db): Promise<TableSummary[]> {
  return readOnly(db, async (client) => {
    const result = await client.query({
      text: `
        SELECT c.relname AS table,
               NULLIF(c.reltuples, -1)::bigint AS approx_rows,
               obj_description(c.oid, 'pg_class') AS comment,
               count(a.attnum) FILTER (
                 WHERE has_column_privilege(c.oid, a.attnum, 'SELECT')
               )::int AS readable_columns,
               count(a.attnum)::int AS total_columns
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm')
        GROUP BY c.oid, c.relname, c.reltuples
        HAVING count(a.attnum) FILTER (
          WHERE has_column_privilege(c.oid, a.attnum, 'SELECT')
        ) > 0
        ORDER BY c.relname`,
      values: [db.schema],
    });
    return result.rows.map((row) => ({
      ...row,
      approx_rows: row.approx_rows === null ? null : Number(row.approx_rows),
    }));
  });
}

export type TableDescription = {
  table: string;
  comment: string | null;
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
    comment: string | null;
  }[];
  hidden_columns: number;
  foreign_keys: { columns: string[]; references: string }[];
  indexes: string[];
};

export async function describeTable(
  db: Db,
  table: string,
): Promise<TableDescription | null> {
  return readOnly(db, async (client) => {
    const rel = await client.query({
      text: `
        SELECT c.oid, obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm')`,
      values: [db.schema, table],
    });
    if (rel.rowCount === 0) return null;
    const oid = rel.rows[0].oid;
    const cols = await client.query({
      text: `
        SELECT a.attname AS name,
               format_type(a.atttypid, a.atttypmod) AS type,
               NOT a.attnotnull AS nullable,
               pg_get_expr(d.adbin, d.adrelid) AS default,
               col_description(a.attrelid, a.attnum) AS comment,
               has_column_privilege(a.attrelid, a.attnum, 'SELECT') AS readable
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      values: [oid],
    });
    const readable = cols.rows.filter((c) => c.readable);
    if (readable.length === 0) return null;
    const fks = await client.query({
      text: `
        SELECT array_agg(a.attname ORDER BY k.ord) AS columns,
               confrelid::regclass::text || '(' ||
                 string_agg(fa.attname, ', ' ORDER BY k.ord) || ')' AS references
        FROM pg_constraint con
        CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(col, fcol, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.col
        JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fcol
        WHERE con.conrelid = $1 AND con.contype = 'f'
        GROUP BY con.oid, con.confrelid`,
      values: [oid],
    });
    const idx = await client.query({
      text: `SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index WHERE indrelid = $1`,
      values: [oid],
    });
    return {
      table,
      comment: rel.rows[0].comment,
      columns: readable.map(({ readable: _r, ...c }) => c),
      hidden_columns: cols.rows.length - readable.length,
      foreign_keys: fks.rows,
      indexes: idx.rows.map((r) => r.def),
    };
  });
}

export type QueryResult = {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
};

// Accepts one SELECT / WITH / VALUES / TABLE statement. It is wrapped in a
// subquery and sent with the extended protocol, so a second statement fails.
export function wrapQuery(sql: string, limit: number): string {
  const body = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with|values|table)\b/i.test(stripLeadingComments(body))) {
    throw new QueryError(
      "Only SELECT queries are allowed (SELECT, WITH, VALUES or TABLE).",
    );
  }
  return `SELECT * FROM (\n${body}\n) AS mcp_query LIMIT ${limit + 1}`;
}

function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const next = s
      .replace(/^\s+/, "")
      .replace(/^--[^\n]*(\n|$)/, "")
      .replace(/^\/\*[\s\S]*?\*\//, "");
    if (next === s) return s;
    s = next;
  }
}

export class QueryError extends Error {}

export async function runQuery(
  db: Db,
  sql: string,
  maxRows?: number,
): Promise<QueryResult> {
  const limit = Math.max(1, Math.min(maxRows ?? 200, db.maxRows));
  const text = wrapQuery(sql, limit);
  return readOnly(db, async (client) => {
    const result = await client.query({
      text,
      rowMode: "array",
      // Forces the extended protocol, which rejects multiple statements.
      queryMode: "extended",
    } as pg.QueryArrayConfig);
    const truncated = result.rows.length > limit;
    const rows = (truncated ? result.rows.slice(0, limit) : result.rows).map(
      (row) => row.map(toJsonValue),
    );
    return {
      columns: result.fields.map((f) => f.name),
      rows,
      row_count: rows.length,
      truncated,
    };
  });
}

function toJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  if (typeof value === "bigint") return value.toString();
  return value;
}
