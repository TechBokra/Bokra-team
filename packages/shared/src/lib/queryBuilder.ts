// A small, Supabase-compatible query builder.
// It only records what the caller asked for (a QuerySpec) and hands it to an
// executor: over HTTP in the browser, or straight to Postgres on the server.

export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is" | "in" | "contains";

export interface QuerySpec {
  table: string;
  action: "select" | "insert" | "update" | "upsert" | "delete";
  columns?: string;
  filters?: [string, FilterOp, unknown][];
  order?: [string, boolean][];
  range?: [number, number] | null;
  limit?: number | null;
  single?: "one" | "maybe" | null;
  values?: Record<string, unknown> | Record<string, unknown>[];
  returning?: string | null;
  onConflict?: string | null;
}

export interface DbError {
  message: string;
  code?: string;
  details?: string;
}

export interface DbResult<T = any> {
  data: T | null;
  error: DbError | null;
}

export type Executor = (spec: QuerySpec) => Promise<DbResult>;

export class QueryBuilder<T = any> implements PromiseLike<DbResult<T>> {
  private spec: QuerySpec;

  constructor(private exec: Executor, table: string) {
    this.spec = { table, action: "select", columns: "*", filters: [], order: [] };
  }

  select(columns = "*", _opts?: unknown) {
    if (this.spec.action === "select") this.spec.columns = columns;
    else this.spec.returning = columns;
    return this;
  }
  insert(values: any, _opts?: unknown) {
    this.spec.action = "insert";
    this.spec.values = values;
    return this;
  }
  upsert(values: any, opts?: { onConflict?: string }) {
    this.spec.action = "upsert";
    this.spec.values = values;
    this.spec.onConflict = opts?.onConflict ?? null;
    return this;
  }
  update(values: any) {
    this.spec.action = "update";
    this.spec.values = values;
    return this;
  }
  delete() {
    this.spec.action = "delete";
    return this;
  }

  private f(col: string, op: FilterOp, value: unknown) {
    this.spec.filters!.push([col, op, value]);
    return this;
  }
  eq(col: string, v: unknown) { return this.f(col, "eq", v); }
  neq(col: string, v: unknown) { return this.f(col, "neq", v); }
  gt(col: string, v: unknown) { return this.f(col, "gt", v); }
  gte(col: string, v: unknown) { return this.f(col, "gte", v); }
  lt(col: string, v: unknown) { return this.f(col, "lt", v); }
  lte(col: string, v: unknown) { return this.f(col, "lte", v); }
  like(col: string, v: string) { return this.f(col, "like", v); }
  ilike(col: string, v: string) { return this.f(col, "ilike", v); }
  is(col: string, v: null | boolean) { return this.f(col, "is", v); }
  in(col: string, v: unknown[]) { return this.f(col, "in", v); }
  contains(col: string, v: unknown) { return this.f(col, "contains", v); }
  match(obj: Record<string, unknown>) {
    Object.entries(obj).forEach(([k, v]) => this.f(k, "eq", v));
    return this;
  }
  or(_filters: string): this {
    throw new Error("or() filters are not supported by the Bokra data layer");
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.spec.order!.push([col, opts?.ascending !== false]);
    return this;
  }
  range(from: number, to: number) {
    this.spec.range = [from, to];
    return this;
  }
  limit(n: number) {
    this.spec.limit = n;
    return this;
  }
  single() {
    this.spec.single = "one";
    return this;
  }
  maybeSingle() {
    this.spec.single = "maybe";
    return this;
  }

  then<R1 = DbResult<T>, R2 = never>(
    onfulfilled?: ((value: DbResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec(this.spec).then(onfulfilled as any, onrejected as any);
  }
}
