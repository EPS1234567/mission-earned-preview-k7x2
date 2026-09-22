/* Migration runner. Applies every .sql file in migrations/ once, in filename
 * order, each in its own transaction.
 *
 * Run as Railway's pre-deploy command: a failure exits non-zero, the deploy
 * does not proceed, and the previous version keeps serving. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate({ log = console.log } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await pool.query("SELECT filename FROM schema_migrations");
  const done = new Set(rows.map((r) => r.filename));

  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      log(`applied ${file}`);
      applied++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return { applied, total: files.length };
}

if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  try {
    const { applied, total } = await migrate();
    console.log(`migrations: ${applied} applied, ${total} total`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}
