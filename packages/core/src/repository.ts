import { Pool } from "pg";
import { CORE_STATE_MIGRATION } from "./migration.js";
import type { CoreState } from "./model.js";
export interface Repository {
  close?(): Promise<void>;
  transaction<T>(change: (state: CoreState) => T | Promise<T>): Promise<T>;
}
export class MemoryRepository implements Repository {
  private state: CoreState;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(initial: CoreState) { this.state = structuredClone(initial); }
  transaction<T>(change: (state: CoreState) => T | Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.state);
      const result = await change(draft);
      this.state = draft;
      return structuredClone(result);
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
// Structural driver interface also permits an embedded Postgres test client.
export type SqlClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
};
export type SqlPool = { connect(): Promise<SqlClient>; end?(): Promise<void> };
export class PostgresRepository implements Repository {
  constructor(private pool: SqlPool, private siteId: string, private initial: CoreState) {}
  async close(): Promise<void> { await this.pool.end?.(); }
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query(CORE_STATE_MIGRATION); }
    finally { client.release(); }
  }
  async transaction<T>(change: (state: CoreState) => T | Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO recyclone_core_state (site_id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (site_id) DO NOTHING", [this.siteId, JSON.stringify(this.initial)]);
      const result = await client.query("SELECT payload FROM recyclone_core_state WHERE site_id = $1 FOR UPDATE", [this.siteId]);
      const state = result.rows[0]?.payload as CoreState;
      if (!state || state.schema_version !== 1) throw new Error("Unsupported core state schema");
      const value = await change(state);
      await client.query("UPDATE recyclone_core_state SET payload = $2::jsonb, revision = revision + 1, updated_at = now() WHERE site_id = $1", [this.siteId, JSON.stringify(state)]);
      await client.query("COMMIT");
      return structuredClone(value);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

export async function connectPostgres(connectionString: string, state: CoreState): Promise<PostgresRepository> {
  const pool = new Pool({ connectionString, max: 3 });
  const repository = new PostgresRepository(pool, state.seed.site.site_id, state);
  try { await repository.migrate(); return repository; }
  catch (error) { await pool.end(); throw error; }
}
