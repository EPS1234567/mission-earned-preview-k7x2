/* Create or update a staff account.
 *
 *   npm run createstaff -- --email a@b.org --name "A B" --role admin
 *
 * The password is read from the STAFF_PASSWORD environment variable so it
 * never lands in shell history or a process list. */
import { pool } from "../db.js";
import { hashPassword } from "../lib/crypto.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const email = (arg("email") || "").trim().toLowerCase();
const name = arg("name") || "";
const role = arg("role") === "admin" ? "admin" : "reviewer";
const password = process.env.STAFF_PASSWORD || "";

if (!email || !name || !password) {
  console.error("Usage: STAFF_PASSWORD='...' npm run createstaff -- --email you@org --name 'Your Name' [--role admin]");
  process.exit(1);
}
if (password.length < 12) {
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}

const hash = await hashPassword(password);
const { rows } = await pool.query(
  `INSERT INTO staff (email, name, role, password_hash)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (lower(email)) DO UPDATE
     SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash,
         is_active = true, failed_logins = 0, locked_until = NULL
   RETURNING id, email, role`,
  [email, name, role, hash]
);
console.log(`staff account ready: ${rows[0].email} (${rows[0].role})`);
if (role === "admin") {
  console.log("This is an admin account, so it must enrol a second factor at first sign-in.");
}
await pool.end();
