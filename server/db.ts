// Postgres access layer for Neon.
// Translates a small, PostgREST-like query spec (the subset the app uses) into
// parameterised SQL. Identifiers are validated against the live schema, values
// are always bound as parameters.
import pg from "pg";
import type { JwtClaims } from "./jwt.js";

const { Pool, types } = pg;

// Keep DB values in the same shape Supabase/PostgREST returned them.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8
types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'
types.setTypeParser(1114, (v) => v); // timestamp
types.setTypeParser(1184, (v) => v); // timestamptz

let pool: pg.Pool | null = null;
export const getPool = () => {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString, max: 5, ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: true } });
  }
  return pool;
};

import type { QuerySpec, DbError, DbResult } from "../packages/shared/src/lib/queryBuilder.js";
export type { QuerySpec, DbError, DbResult };

// ---------------------------------------------------------------------------
// Schema cache
// ---------------------------------------------------------------------------
interface FkInfo { fromTable: string; fromCol: string; toTable: string; toCol: string; }
interface SchemaCache {
  columns: Map<string, Set<string>>;
  pks: Map<string, string[]>;
  fks: FkInfo[];
  jsonCols: Map<string, Set<string>>;
  functions: Set<string>;
}
let schemaCache: SchemaCache | null = null;
let schemaLoadedAt = 0;

async function loadSchema(): Promise<SchemaCache> {
  if (schemaCache && Date.now() - schemaLoadedAt < 5 * 60 * 1000) return schemaCache;
  const p = getPool();
  const cols = await p.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const pks = await p.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position`);
  const fks = await p.query(`
    SELECT cl.relname AS from_table, a.attname AS from_col, rcl.relname AS to_table, ra.attname AS to_col
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
    JOIN pg_class rcl ON rcl.oid = c.confrelid
    JOIN pg_namespace rn ON rn.oid = rcl.relnamespace AND rn.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1`);
  const fns = await p.query(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'`);

  const cache: SchemaCache = { columns: new Map(), pks: new Map(), fks: [], jsonCols: new Map(), functions: new Set() };
  for (const r of cols.rows) {
    if (!cache.columns.has(r.table_name)) cache.columns.set(r.table_name, new Set());
    cache.columns.get(r.table_name)!.add(r.column_name);
    if (r.data_type === "jsonb" || r.data_type === "json") {
      if (!cache.jsonCols.has(r.table_name)) cache.jsonCols.set(r.table_name, new Set());
      cache.jsonCols.get(r.table_name)!.add(r.column_name);
    }
  }
  for (const r of pks.rows) {
    if (!cache.pks.has(r.table_name)) cache.pks.set(r.table_name, []);
    cache.pks.get(r.table_name)!.push(r.column_name);
  }
  cache.fks = fks.rows.map((r) => ({ fromTable: r.from_table, fromCol: r.from_col, toTable: r.to_table, toCol: r.to_col }));
  for (const r of fns.rows) cache.functions.add(r.proname);
  schemaCache = cache;
  schemaLoadedAt = Date.now();
  return cache;
}

class QueryError extends Error {
  code: string;
  constructor(message: string, code = "BOKRA400") {
    super(message);
    this.code = code;
  }
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function assertTable(s: SchemaCache, table: string) {
  if (!s.columns.has(table)) throw new QueryError(`Unknown table: ${table}`, "42P01");
}
function assertColumn(s: SchemaCache, table: string, col: string) {
  if (!s.columns.get(table)?.has(col)) throw new QueryError(`Unknown column ${table}.${col}`, "42703");
}

// Split "a, b(c, d), e" on top-level commas
function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function buildSelectList(s: SchemaCache, table: string, alias: string, columns: string): string {
  const parts = splitTop(columns || "*");
  const sql: string[] = [];
  for (const part of parts) {
    const m = part.match(/^([a-z_][a-z0-9_]*)\s*\((.*)\)$/i);
    if (m) {
      const rel = m[1];
      const inner = m[2].trim() || "*";
      assertTable(s, rel);
      const relAlias = `${alias}_${rel}`;
      const innerList = buildSelectList(s, rel, relAlias, inner);
      const manyToOne = s.fks.find((f) => f.fromTable === table && f.toTable === rel);
      const oneToMany = s.fks.find((f) => f.fromTable === rel && f.toTable === table);
      if (manyToOne) {
        sql.push(
          `(SELECT to_jsonb(${relAlias}_r) FROM (SELECT ${innerList} FROM public.${q(rel)} ${relAlias} WHERE ${relAlias}.${q(manyToOne.toCol)} = ${alias}.${q(manyToOne.fromCol)}) ${relAlias}_r) AS ${q(rel)}`,
        );
      } else if (oneToMany) {
        sql.push(
          `(SELECT coalesce(jsonb_agg(to_jsonb(${relAlias}_r)), '[]'::jsonb) FROM (SELECT ${innerList} FROM public.${q(rel)} ${relAlias} WHERE ${relAlias}.${q(oneToMany.fromCol)} = ${alias}.${q(oneToMany.toCol)}) ${relAlias}_r) AS ${q(rel)}`,
        );
      } else {
        throw new QueryError(`No relationship between ${table} and ${rel}`, "PGRST200");
      }
      continue;
    }
    if (part === "*") { sql.push(`${alias}.*`); continue; }
    assertColumn(s, table, part);
    sql.push(`${alias}.${q(part)}`);
  }
  return sql.join(", ");
}

function buildWhere(s: SchemaCache, table: string, alias: string, filters: QuerySpec["filters"], params: unknown[]): string {
  if (!filters || filters.length === 0) return "";
  const conds = filters.map(([col, op, value]) => {
    assertColumn(s, table, col);
    const c = `${alias}.${q(col)}`;
    const isJson = s.jsonCols.get(table)?.has(col);
    const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
    switch (op) {
      case "eq": return `${c} = ${bind(value)}`;
      case "neq": return `${c} <> ${bind(value)}`;
      case "gt": return `${c} > ${bind(value)}`;
      case "gte": return `${c} >= ${bind(value)}`;
      case "lt": return `${c} < ${bind(value)}`;
      case "lte": return `${c} <= ${bind(value)}`;
      case "like": return `${c}::text LIKE ${bind(value)}`;
      case "ilike": return `${c}::text ILIKE ${bind(value)}`;
      case "is":
        if (value === null) return `${c} IS NULL`;
        if (value === true) return `${c} IS TRUE`;
        if (value === false) return `${c} IS FALSE`;
        throw new QueryError("Invalid value for is()");
      case "in": {
        const arr = Array.isArray(value) ? value : [];
        if (arr.length === 0) return "FALSE";
        return `${c}::text = ANY(${bind(arr.map((v) => String(v)))}::text[])`;
      }
      case "contains":
        return isJson ? `${c} @> ${bind(JSON.stringify(value))}::jsonb` : `${c} @> ${bind(value)}`;
      default:
        throw new QueryError(`Unsupported filter: ${op}`);
    }
  });
  return ` WHERE ${conds.join(" AND ")}`;
}

function normaliseValue(s: SchemaCache, table: string, col: string, v: unknown) {
  // JSON columns must be sent as JSON text; arrays for text[] columns stay arrays.
  if (s.jsonCols.get(table)?.has(col)) return v === undefined || v === null ? null : JSON.stringify(v);
  return v;
}

export function buildSql(s: SchemaCache, spec: QuerySpec): { text: string; params: unknown[] } {
  const { table } = spec;
  assertTable(s, table);
  const alias = "t";
  const params: unknown[] = [];

  if (spec.action === "select") {
    let text = `SELECT ${buildSelectList(s, table, alias, spec.columns || "*")} FROM public.${q(table)} ${alias}`;
    text += buildWhere(s, table, alias, spec.filters, params);
    if (spec.order?.length) {
      text += " ORDER BY " + spec.order.map(([col, asc]) => { assertColumn(s, table, col); return `${alias}.${q(col)} ${asc ? "ASC" : "DESC"}`; }).join(", ");
    }
    if (spec.range) {
      const [from, to] = spec.range;
      text += ` LIMIT ${Math.max(0, Math.floor(to - from + 1))} OFFSET ${Math.max(0, Math.floor(from))}`;
    } else if (spec.limit != null) {
      text += ` LIMIT ${Math.max(0, Math.floor(spec.limit))}`;
    }
    return { text, params };
  }

  // RETURNING supports plain columns only (no embeds), which is all the app uses after writes.
  const plainReturning = spec.returning != null
    ? ` RETURNING ${splitTop(spec.returning || "*").map((c) => { if (c === "*") return "*"; assertColumn(s, table, c); return q(c); }).join(", ")}`
    : "";

  if (spec.action === "insert" || spec.action === "upsert") {
    const rows = Array.isArray(spec.values) ? spec.values : [spec.values || {}];
    if (rows.length === 0) throw new QueryError("Nothing to insert");
    const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    cols.forEach((c) => assertColumn(s, table, c));
    const valuesSql = rows.map((r) => "(" + cols.map((c) => {
      if (!(c in r)) return "DEFAULT";
      params.push(normaliseValue(s, table, c, (r as any)[c]));
      return `$${params.length}`;
    }).join(", ") + ")").join(", ");
    let text = `INSERT INTO public.${q(table)} (${cols.map(q).join(", ")}) VALUES ${valuesSql}`;
    if (spec.action === "upsert") {
      const conflict = (spec.onConflict ? spec.onConflict.split(",").map((x) => x.trim()) : s.pks.get(table)) || [];
      conflict.forEach((c) => assertColumn(s, table, c));
      const updates = cols.filter((c) => !conflict.includes(c));
      text += ` ON CONFLICT (${conflict.map(q).join(", ")}) ` + (updates.length ? `DO UPDATE SET ${updates.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ")}` : "DO NOTHING");
    }
    return { text: text + plainReturning, params };
  }

  if (spec.action === "update") {
    const values = (spec.values || {}) as Record<string, unknown>;
    const cols = Object.keys(values).filter((c) => values[c] !== undefined);
    if (cols.length === 0) throw new QueryError("Nothing to update");
    if (!spec.filters?.length) throw new QueryError("UPDATE requires a filter");
    const set = cols.map((c) => { assertColumn(s, table, c); params.push(normaliseValue(s, table, c, values[c])); return `${q(c)} = $${params.length}`; }).join(", ");
    const where = buildWhere(s, table, `public.${q(table)}`, spec.filters, params);
    return { text: `UPDATE public.${q(table)} SET ${set}${where}${plainReturning}`, params };
  }

  if (spec.action === "delete") {
    if (!spec.filters?.length) throw new QueryError("DELETE requires a filter");
    const where = buildWhere(s, table, `public.${q(table)}`, spec.filters, params);
    return { text: `DELETE FROM public.${q(table)}${where}${plainReturning}`, params };
  }
  throw new QueryError(`Unknown action ${spec.action}`);
}

function shapeResult(spec: QuerySpec, rows: any[]): DbResult {
  const isWriteWithoutReturn = spec.action !== "select" && spec.returning == null;
  if (isWriteWithoutReturn) return { data: null, error: null };
  if (spec.single === "one") {
    if (rows.length !== 1) {
      return {
        data: null,
        error: { code: "PGRST116", message: `JSON object requested, multiple (or no) rows returned. The result contains ${rows.length} rows` },
      };
    }
    return { data: rows[0], error: null };
  }
  if (spec.single === "maybe") {
    if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: `The result contains ${rows.length} rows` } };
    return { data: rows[0] ?? null, error: null };
  }
  return { data: rows, error: null };
}

const toDbError = (e: any): DbError => ({ message: e?.message || String(e), code: e?.code, details: e?.detail });

/** Run with full privileges (table owner, bypasses RLS). Server-side only. */
export async function runAsAdmin(spec: QuerySpec): Promise<DbResult> {
  try {
    const s = await loadSchema();
    const { text, params } = buildSql(s, spec);
    const r = await getPool().query(text, params);
    return shapeResult(spec, r.rows);
  } catch (e) {
    return { data: null, error: toDbError(e) };
  }
}

/** Run a callback inside a transaction scoped to the user (RLS enforced). */
export async function withUser<T>(claims: JwtClaims, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: claims.sub, email: claims.email, role: "authenticated" }),
    ]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Run a query spec as the given user (RLS enforced). */
export async function runAsUser(claims: JwtClaims, spec: QuerySpec): Promise<DbResult> {
  try {
    const s = await loadSchema();
    const { text, params } = buildSql(s, spec);
    const rows = await withUser(claims, async (c) => (await c.query(text, params)).rows);
    return shapeResult(spec, rows);
  } catch (e) {
    return { data: null, error: toDbError(e) };
  }
}

/** Call a public SQL function as the user. */
export async function rpcAsUser(claims: JwtClaims, fn: string, args: Record<string, unknown>): Promise<DbResult> {
  try {
    const s = await loadSchema();
    if (!s.functions.has(fn)) throw new QueryError(`Unknown function ${fn}`, "42883");
    const names = Object.keys(args || {});
    names.forEach((n) => { if (!/^[a-z_][a-z0-9_]*$/i.test(n)) throw new QueryError("Invalid argument name"); });
    const call = `public.${q(fn)}(${names.map((n, i) => `${q(n)} => $${i + 1}`).join(", ")})`;
    const rows = await withUser(claims, async (c) => (await c.query(`SELECT to_jsonb(${call}) AS result`, names.map((n) => args[n]))).rows);
    return { data: rows[0]?.result ?? null, error: null };
  } catch (e) {
    return { data: null, error: toDbError(e) };
  }
}
