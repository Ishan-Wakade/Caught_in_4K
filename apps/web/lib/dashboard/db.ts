import { Pool } from "pg";
import binsJson from "../../../../worker/rules/cambridge-ma-2022.bins.json";

/**
 * Tiny, purpose-built store for the dashboard's catalog + new-item review
 * queue. Deliberately separate from packages/core's Postgres repository
 * (that's the old misorting-detection product's JSONB-blob state) — this is
 * one flat table, migrated lazily on first use like packages/core's own
 * `connectPostgres`/`migrate()` does, just without the state-machine
 * wrapped around it.
 */
export type Destination = "compost" | "recycle" | "trash" | "none";
export type Status = "approved" | "pending" | "rejected";
export type CatalogRow = {
  id: string;
  name: string;
  destination: Destination;
  basis: string;
  status: Status;
  confidence: number | null;
  times_seen: number;
  first_seen_at: string;
  last_seen_at: string;
};

const MIGRATION = `
CREATE TABLE IF NOT EXISTS dashboard_catalog_items (
  id text PRIMARY KEY,
  name text NOT NULL,
  destination text NOT NULL CHECK (destination IN ('compost', 'recycle', 'trash', 'none')),
  basis text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('approved', 'pending', 'rejected')),
  confidence real,
  times_seen integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
`;

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

const BINS = (binsJson as { items: Record<string, { bin: Exclude<Destination, "none">; name: string; basis: string }> }).items;

let pool: Pool | null = null;
let migrated: Promise<void> | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for the dashboard catalog database.");
    pool = new Pool({ connectionString, max: 3 });
  }
  return pool;
}

/** Runs the migration + one-time seed exactly once per warm process, lazily on first real query. */
function ensureReady(): Promise<void> {
  if (!migrated) {
    migrated = (async () => {
      const client = await getPool().connect();
      try {
        await client.query(MIGRATION);
        for (const [id, row] of Object.entries(BINS)) {
          await client.query(
            `INSERT INTO dashboard_catalog_items (id, name, destination, basis, status)
             VALUES ($1, $2, $3, $4, 'approved') ON CONFLICT (id) DO NOTHING`,
            [id, row.name, row.bin, row.basis],
          );
        }
      } finally {
        client.release();
      }
    })().catch((error) => {
      migrated = null; // allow retrying on the next call instead of caching a permanent failure
      throw error;
    });
  }
  return migrated;
}

export async function listApproved(): Promise<CatalogRow[]> {
  await ensureReady();
  const { rows } = await getPool().query("SELECT * FROM dashboard_catalog_items WHERE status = 'approved' ORDER BY name");
  return rows as CatalogRow[];
}

export async function listPending(): Promise<CatalogRow[]> {
  await ensureReady();
  const { rows } = await getPool().query("SELECT * FROM dashboard_catalog_items WHERE status = 'pending' ORDER BY last_seen_at DESC");
  return rows as CatalogRow[];
}

export type Sighting = { id: string; name: string; destination: Destination; basis: string; confidence?: number | null };

/** Upserts a sighting: a new id is inserted as pending; a repeat just bumps times_seen/last_seen_at. */
export async function recordSighting(item: Sighting): Promise<void> {
  await ensureReady();
  await getPool().query(
    `INSERT INTO dashboard_catalog_items (id, name, destination, basis, confidence)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET times_seen = dashboard_catalog_items.times_seen + 1, last_seen_at = now()`,
    [item.id, item.name, item.destination, item.basis, item.confidence ?? null],
  );
}

export async function decide(id: string, decision: "approved" | "rejected"): Promise<CatalogRow | null> {
  await ensureReady();
  const { rows } = await getPool().query(
    "UPDATE dashboard_catalog_items SET status = $2 WHERE id = $1 RETURNING *",
    [id, decision],
  );
  return (rows[0] as CatalogRow) ?? null;
}
