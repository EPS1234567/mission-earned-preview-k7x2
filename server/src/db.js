/* Postgres pool and a couple of helpers. */
import pg from "pg";
import config from "./config.js";

/* Timestamps come back as ISO strings rather than local Date objects, so the
   wire format never depends on the server's timezone. */
pg.types.setTypeParser(1114, (v) => new Date(v + "Z").toISOString());

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  console.error(JSON.stringify({ level: "error", msg: "idle pg client error", err: err.message }));
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

export async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}
