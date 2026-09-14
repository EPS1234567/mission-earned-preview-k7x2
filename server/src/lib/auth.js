/* Staff sessions and candidate case sessions. */
import config from "../config.js";
import { one, query } from "../db.js";
import { newToken, sha256, newMagicLinkToken, parseMagicLinkToken } from "./crypto.js";
import { readCookie, setCookie, clearCookie, checkOrigin, csrfTokenValid, clientIp } from "./security.js";

export const STAFF_COOKIE = "me_staff";
export const CASE_COOKIE = "me_case";
export const CSRF_COOKIE = "me_csrf";

/* ------------------------------------------------------------ staff ------ */

export async function createStaffSession(res, staffId, req, { totpVerified }) {
  const token = newToken();
  const row = await one(
    `INSERT INTO staff_sessions (staff_id, token_sha256, totp_verified, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' milliseconds')::interval)
     RETURNING id`,
    [staffId, sha256(token), totpVerified, clientIp(req), req.get("user-agent") || null, String(config.session.staffAbsoluteMs)]
  );
  setCookie(res, STAFF_COOKIE, token, config.session.staffAbsoluteMs);
  return row.id;
}

export async function loadStaffSession(req) {
  const token = readCookie(req, STAFF_COOKIE);
  if (!token) return null;
  const row = await one(
    `SELECT s.id, s.staff_id, s.totp_verified, s.expires_at, s.last_seen_at,
            u.email, u.name, u.role, u.is_active, u.totp_confirmed
       FROM staff_sessions s
       JOIN staff u ON u.id = s.staff_id
      WHERE s.token_sha256 = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [sha256(token)]
  );
  if (!row || !row.is_active) return null;
  /* Idle timeout is enforced here rather than by cookie lifetime, which the
     browser controls and we do not. */
  if (Date.now() - new Date(row.last_seen_at).getTime() > config.session.staffIdleMs) {
    await query("UPDATE staff_sessions SET revoked_at = now() WHERE id = $1", [row.id]);
    return null;
  }
  await query("UPDATE staff_sessions SET last_seen_at = now() WHERE id = $1", [row.id]);
  return row;
}

export async function revokeStaffSession(req, res) {
  const token = readCookie(req, STAFF_COOKIE);
  if (token) await query("UPDATE staff_sessions SET revoked_at = now() WHERE token_sha256 = $1", [sha256(token)]);
  clearCookie(res, STAFF_COOKIE);
  clearCookie(res, CSRF_COOKIE);
}

/* Second factor is required for administrators — they are the accounts that
   can export in bulk and read the audit log. */
function needsTotp(session) {
  if (!config.requireTotpForAdmin) return false;
  if (session.role !== "admin") return false;
  return !session.totp_verified;
}

export function requireStaff(options = {}) {
  return async function (req, res, next) {
    try {
      const session = await loadStaffSession(req);
      if (!session) return res.status(401).json({ error: "not_authenticated" });
      if (!csrfOk(req, session.id)) return res.status(403).json({ error: "csrf_failed" });
      if (needsTotp(session) && !options.allowPendingTotp) {
        return res.status(403).json({ error: "totp_required" });
      }
      if (options.role === "admin" && session.role !== "admin") {
        return res.status(403).json({ error: "forbidden" });
      }
      req.staff = session;
      next();
    } catch (err) { next(err); }
  };
}

function csrfOk(req, sessionId) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  if (!checkOrigin(req)) return false;
  const header = req.get("x-csrf-token") || (req.body && req.body._csrf);
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!header || !cookie || header !== cookie) return false;
  return csrfTokenValid(header, sessionId);
}

export { csrfOk };

/* --------------------------------------------------------- candidate ----- */

export async function issueMagicLink(applicationId) {
  const { selector, token, verifierHmac } = newMagicLinkToken();
  await query(
    `INSERT INTO case_tokens (application_id, selector, verifier_hmac, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
    [applicationId, selector, verifierHmac, String(config.session.magicLinkMs)]
  );
  return `${config.appOrigin}/p/enter?t=${encodeURIComponent(token)}`;
}

/* Single-use and atomic: the UPDATE ... WHERE consumed_at IS NULL is what makes
   a replayed link fail, even if two requests arrive at once. */
export async function consumeMagicLink(token) {
  const parsed = parseMagicLinkToken(token);
  if (!parsed) return null;
  const row = await one(
    `UPDATE case_tokens
        SET consumed_at = now()
      WHERE selector = $1
        AND verifier_hmac = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING application_id`,
    [parsed.selector, parsed.verifierHmac]
  );
  return row ? row.application_id : null;
}

export async function createCaseSession(res, applicationId, req) {
  const token = newToken();
  await query(
    `INSERT INTO case_sessions (application_id, token_sha256, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
    [applicationId, sha256(token), clientIp(req), req.get("user-agent") || null, String(config.session.caseAbsoluteMs)]
  );
  setCookie(res, CASE_COOKIE, token, config.session.caseAbsoluteMs, "/p");
}

export async function loadCaseSession(req) {
  const token = readCookie(req, CASE_COOKIE);
  if (!token) return null;
  const row = await one(
    `SELECT id, application_id, last_seen_at
       FROM case_sessions
      WHERE token_sha256 = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256(token)]
  );
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > config.session.caseIdleMs) {
    await query("UPDATE case_sessions SET revoked_at = now() WHERE id = $1", [row.id]);
    return null;
  }
  await query("UPDATE case_sessions SET last_seen_at = now() WHERE id = $1", [row.id]);
  return row;
}

export async function revokeCaseSession(req, res) {
  const token = readCookie(req, CASE_COOKIE);
  if (token) await query("UPDATE case_sessions SET revoked_at = now() WHERE token_sha256 = $1", [sha256(token)]);
  clearCookie(res, CASE_COOKIE, "/p");
  clearCookie(res, CSRF_COOKIE, "/p");
}

/* Changing where links are delivered invalidates every outstanding link and
   session for the case, so a leaked link cannot be turned into a takeover. */
export async function revokeAllCaseAccess(applicationId) {
  await query("UPDATE case_tokens SET consumed_at = now() WHERE application_id = $1 AND consumed_at IS NULL", [applicationId]);
  await query("UPDATE case_sessions SET revoked_at = now() WHERE application_id = $1 AND revoked_at IS NULL", [applicationId]);
}
