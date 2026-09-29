// A small in-memory stand-in for the supabase-js query builder, covering exactly the calls the
// payment routes make. It is NOT a general Supabase emulator — what it models faithfully is the
// part these tests depend on: `transactions.tx_hash` is UNIQUE (as in production), an insert
// that collides fails with Postgres' 23505, and `upsert(..., { onConflict })` overwrites.
//
// Every builder is thenable, so `await supabase.from(t).update(...).eq(...)` resolves the same
// way the real client does: { data, error }.

type Row = Record<string, any>;
type Filter = (row: Row) => boolean;

export interface FakeDb {
  tables: Record<string, Row[]>;
  unique: Record<string, string[]>;
  log: { table: string; op: string; payload?: any }[];
  /** When set, the next insert into this table fails with a generic database error. */
  failNextInsert?: string;
}

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  return {
    tables: { transactions: [], platform_settings: [{ id: 1, exchange_rate: 1340 }], ...structuredClone(seed) },
    unique: { transactions: ['tx_hash'] },
    log: [],
  };
}

let nextId = 1;

class Query implements PromiseLike<{ data: any; error: any }> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: any = null;
  private onConflict: string | null = null;
  private returning = false;
  private cardinality: 'many' | 'single' | 'maybeSingle' = 'many';
  private limitN: number | null = null;

  constructor(private db: FakeDb, private table: string) {
    db.tables[table] ??= [];
  }

  select(_cols?: string) { if (this.op === 'select') this.op = 'select'; else this.returning = true; return this; }
  insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
  upsert(p: any, o?: { onConflict?: string }) { this.op = 'upsert'; this.payload = p; this.onConflict = o?.onConflict ?? null; return this; }
  update(p: any) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }

  eq(col: string, v: any) { this.filters.push((r) => r[col] === v); return this; }
  neq(col: string, v: any) { this.filters.push((r) => r[col] !== v); return this; }
  in(col: string, vs: any[]) { this.filters.push((r) => vs.includes(r[col])); return this; }
  like(col: string, pat: string) { const re = likeToRegex(pat, false); this.filters.push((r) => re.test(String(r[col] ?? ''))); return this; }
  ilike(col: string, pat: string) { const re = likeToRegex(pat, true); this.filters.push((r) => re.test(String(r[col] ?? ''))); return this; }
  is(col: string, v: null | boolean) { this.filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return this; }
  not(col: string, op: string, v: any) {
    if (op === 'like') { const re = likeToRegex(v, false); this.filters.push((r) => !re.test(String(r[col] ?? ''))); }
    else if (op === 'is') this.filters.push((r) => (v === null ? r[col] != null : r[col] !== v));
    else throw new Error(`fakeSupabase: .not(${op}) not modelled`);
    return this;
  }
  gte(col: string, v: any) { this.filters.push((r) => r[col] >= v); return this; }
  lt(col: string, v: any) { this.filters.push((r) => r[col] < v); return this; }
  order() { return this; }
  limit(n: number) { this.limitN = n; return this; }
  single() { this.cardinality = 'single'; return this; }
  maybeSingle() { this.cardinality = 'maybeSingle'; return this; }

  then<A, B>(ok?: ((v: { data: any; error: any }) => A | PromiseLike<A>) | null, bad?: ((e: any) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, bad);
  }

  private rows() { return this.db.tables[this.table]; }
  private matching() { return this.rows().filter((r) => this.filters.every((f) => f(r))); }

  private collides(row: Row, except?: Row) {
    return (this.db.unique[this.table] || []).find((col) =>
      row[col] != null && this.rows().some((r) => r !== except && r[col] === row[col]));
  }

  private shape(data: Row[]) {
    const limited = this.limitN == null ? data : data.slice(0, this.limitN);
    if (this.cardinality === 'many') return { data: limited.map((r) => ({ ...r })), error: null };
    if (limited.length === 0) {
      return this.cardinality === 'single'
        ? { data: null, error: { code: 'PGRST116', message: 'no rows' } }
        : { data: null, error: null };
    }
    if (limited.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
    return { data: { ...limited[0] }, error: null };
  }

  private run(): { data: any; error: any } {
    this.db.log.push({ table: this.table, op: this.op, payload: this.payload });
    switch (this.op) {
      case 'select':
        return this.shape(this.matching());
      case 'insert': {
        if (this.db.failNextInsert === this.table) {
          this.db.failNextInsert = undefined;
          return { data: null, error: { code: 'XX000', message: 'simulated database failure' } };
        }
        const incoming = [].concat(this.payload).map((r: Row) => ({ id: `row-${nextId++}`, created_at: new Date().toISOString(), ...r }));
        for (const r of incoming) {
          const col = this.collides(r);
          if (col) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${this.table}_${col}_key"` } };
        }
        this.rows().push(...incoming);
        return this.returning ? this.shape(incoming) : { data: null, error: null };
      }
      case 'upsert': {
        const incoming = [].concat(this.payload) as Row[];
        const out: Row[] = [];
        for (const r of incoming) {
          const key = this.onConflict;
          const existing = key ? this.rows().find((x) => x[key] === r[key]) : undefined;
          if (existing) { Object.assign(existing, r); out.push(existing); }
          else { const row = { id: `row-${nextId++}`, created_at: new Date().toISOString(), ...r }; this.rows().push(row); out.push(row); }
        }
        return this.returning ? this.shape(out) : { data: null, error: null };
      }
      case 'update': {
        const hits = this.matching();
        for (const r of hits) {
          const col = this.collides({ ...r, ...this.payload }, r);
          if (col) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${this.table}_${col}_key"` } };
        }
        hits.forEach((r) => Object.assign(r, this.payload));
        return this.returning ? this.shape(hits) : { data: null, error: null };
      }
      case 'delete': {
        const hits = this.matching();
        this.db.tables[this.table] = this.rows().filter((r) => !hits.includes(r));
        return this.returning ? this.shape(hits) : { data: null, error: null };
      }
    }
  }
}

function likeToRegex(pattern: string, insensitive: boolean) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${esc}$`, insensitive ? 'i' : '');
}

export function fakeSupabase(db: FakeDb) {
  return {
    from: (table: string) => new Query(db, table),
    rpc: async () => ({ data: null, error: null }),
  };
}
