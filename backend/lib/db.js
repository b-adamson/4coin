import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }, // Neon requires SSL
  max: 20,                           // tune as needed
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

// prevent unhandled 'error' events from crashing the process
pool.on("error", (err) => {
  console.error("[pg pool error]", err.code || err.message, err);
});

export { pool };       // named export
export default pool;   // default export

// quick health check, useful at startup or /healthz
export async function dbHealth() {
  const { rows } = await pool.query("SELECT now()");
  return rows[0].now;
}
