/* Append-only record of who did what.
 *
 * Never record the content of a message, an answer or a document — only that
 * the action happened, to which case, by whom. */
import { query } from "../db.js";

export async function audit({ actorType, actorId = null, action, applicationId = null, detail = {}, ip = null }) {
  try {
    await query(
      `INSERT INTO audit_log (actor_type, actor_id, action, application_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorType, actorId ? String(actorId) : null, action, applicationId, detail, ip]
    );
  } catch (err) {
    /* An audit write must never take down the action it describes, but it
       must be loud when it fails. */
    console.error(JSON.stringify({ level: "error", msg: "audit write failed", action, err: err.message }));
  }
}
