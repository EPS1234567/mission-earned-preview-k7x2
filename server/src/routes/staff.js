/* Staff review portal API. Every route is session-authenticated, CSRF-gated
 * and audit-logged. */
import express from "express";
import config from "../config.js";
import { one, many, query } from "../db.js";
import { verifyPassword, hashPassword, verifyTotp, newTotpSecret, totpUri } from "../lib/crypto.js";
import {
  createStaffSession, loadStaffSession, revokeStaffSession, requireStaff,
  issueMagicLink, revokeAllCaseAccess, CSRF_COOKIE,
} from "../lib/auth.js";
import { csrfToken, setCookie, rateLimit, clientIp, checkOrigin } from "../lib/security.js";
import { audit } from "../lib/audit.js";
import { send, templates } from "../lib/mail.js";
import { parseMultipart, detectType } from "../lib/upload.js";
import { storeDocument, loadDocumentMeta, readDocumentBytes, sendDocument, shredDocument } from "../lib/documents.js";
import { fullName } from "../lib/applications.js";

export const staffRouter = express.Router();

const STATUSES = [
  "received", "in_review", "interview_scheduled", "interviewed",
  "onboarding", "active", "on_hold", "withdrawn", "declined",
];

function caseLink(id) { return `${config.appOrigin}/staff/#/case/${id}`; }

/* ------------------------------------------------------------ session ---- */

staffRouter.post("/login", async (req, res, next) => {
  try {
    if (!checkOrigin(req)) return res.status(403).json({ error: "bad_origin" });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const ip = clientIp(req);

    /* Limit by account and by source, so neither a single account nor a single
       host can be ground down. */
    const byIp = await rateLimit(`login:ip:${ip}`, 20, 15 * 60 * 1000);
    const byAccount = await rateLimit(`login:acct:${email}`, 8, 15 * 60 * 1000);
    if (!byIp.allowed || !byAccount.allowed) {
      await audit({ actorType: "staff", actorId: email, action: "login.rate_limited", ip });
      return res.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again shortly." });
    }

    const user = await one(
      `SELECT id, email, name, role, password_hash, totp_secret, totp_confirmed, is_active, locked_until
         FROM staff WHERE lower(email) = $1`,
      [email]
    );

    /* Always do the work, so a missing account and a wrong password take the
       same time and reveal the same thing. */
    const hash = user?.password_hash || "scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";
    const ok = await verifyPassword(password, hash);

    if (!user || !ok || !user.is_active || (user.locked_until && new Date(user.locked_until) > new Date())) {
      if (user) {
        await query(
          `UPDATE staff SET failed_logins = failed_logins + 1,
                  locked_until = CASE WHEN failed_logins + 1 >= 10 THEN now() + interval '15 minutes' ELSE locked_until END
             WHERE id = $1`, [user.id]);
      }
      await audit({ actorType: "staff", actorId: email, action: "login.failed", ip });
      return res.status(401).json({ error: "invalid_credentials", message: "That email and password don't match." });
    }

    await query("UPDATE staff SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [user.id]);

    /* An administrator's session does not count as fully authenticated until a
       second factor is presented. Everyone else is done here. */
    const totpRequired = config.requireTotpForAdmin && user.role === "admin";
    const sessionId = await createStaffSession(res, user.id, req, { totpVerified: !totpRequired });
    issueCsrf(res, sessionId);

    await audit({ actorType: "staff", actorId: user.id, action: "login.succeeded", ip });
    res.json({
      ok: true,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      totp: {
        required: totpRequired,
        enrolled: user.totp_confirmed,
        /* An admin with no second factor yet must enrol before doing anything. */
        next: totpRequired ? (user.totp_confirmed ? "verify" : "enrol") : "none",
      },
    });
  } catch (err) { next(err); }
});

function issueCsrf(res, sessionId) {
  const token = csrfToken(sessionId);
  /* Readable by the portal's own script so it can echo it in a header — that
     is the point of double-submit. It is bound to the session, so a cookie an
     attacker can write is not a token they can forge. */
  const name = config.isProd ? `__Host-${CSRF_COOKIE}` : CSRF_COOKIE;
  const parts = [`${name}=${token}`, "Path=/", "SameSite=Lax"];
  if (config.isProd) parts.push("Secure");
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", existing ? [].concat(existing, parts.join("; ")) : [parts.join("; ")]);
  return token;
}

staffRouter.post("/logout", requireStaff({ allowPendingTotp: true }), async (req, res, next) => {
  try {
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "logout", ip: clientIp(req) });
    await revokeStaffSession(req, res);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

staffRouter.get("/me", async (req, res, next) => {
  try {
    const session = await loadStaffSession(req);
    if (!session) return res.status(401).json({ error: "not_authenticated" });
    const token = issueCsrf(res, session.id);
    res.json({
      user: { id: session.staff_id, name: session.name, email: session.email, role: session.role },
      totp: {
        required: config.requireTotpForAdmin && session.role === "admin",
        enrolled: session.totp_confirmed,
        verified: session.totp_verified,
      },
      csrfToken: token,
    });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------- TOTP ---- */

staffRouter.post("/totp/enrol", requireStaff({ allowPendingTotp: true }), async (req, res, next) => {
  try {
    if (req.staff.totp_confirmed) return res.status(409).json({ error: "already_enrolled" });
    const secret = newTotpSecret();
    await query("UPDATE staff SET totp_secret = $2, totp_confirmed = false WHERE id = $1", [req.staff.staff_id, secret]);
    res.json({ secret, uri: totpUri(secret, req.staff.email) });
  } catch (err) { next(err); }
});

staffRouter.post("/totp/confirm", requireStaff({ allowPendingTotp: true }), async (req, res, next) => {
  try {
    const row = await one("SELECT totp_secret FROM staff WHERE id = $1", [req.staff.staff_id]);
    if (!row?.totp_secret) return res.status(409).json({ error: "not_enrolling" });
    if (!verifyTotp(row.totp_secret, req.body?.code)) {
      return res.status(401).json({ error: "invalid_code", message: "That code isn't right. Try the next one." });
    }
    await query("UPDATE staff SET totp_confirmed = true WHERE id = $1", [req.staff.staff_id]);
    await query("UPDATE staff_sessions SET totp_verified = true WHERE id = $1", [req.staff.id]);
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "totp.enrolled", ip: clientIp(req) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

staffRouter.post("/totp/verify", requireStaff({ allowPendingTotp: true }), async (req, res, next) => {
  try {
    const limit = await rateLimit(`totp:${req.staff.staff_id}`, 10, 15 * 60 * 1000);
    if (!limit.allowed) return res.status(429).json({ error: "rate_limited" });
    const row = await one("SELECT totp_secret FROM staff WHERE id = $1", [req.staff.staff_id]);
    if (!row?.totp_secret || !verifyTotp(row.totp_secret, req.body?.code)) {
      await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "totp.failed", ip: clientIp(req) });
      return res.status(401).json({ error: "invalid_code", message: "That code isn't right." });
    }
    await query("UPDATE staff_sessions SET totp_verified = true WHERE id = $1", [req.staff.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------- applications ---- */

staffRouter.get("/applications", requireStaff(), async (req, res, next) => {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const q = String(req.query.q || "").trim().slice(0, 120);
    const mine = req.query.assigned === "me";
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const where = ["true"];
    const params = [];
    if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
    if (mine) { params.push(req.staff.staff_id); where.push(`a.assigned_staff_id = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(a.search_text ILIKE $${params.length} OR a.reference ILIKE $${params.length})`);
    }
    params.push(limit);

    const rows = await many(
      `SELECT a.id, a.reference, a.first_name, a.last_name, a.email, a.phone,
              a.military_connection, a.status, a.received_at, a.assigned_staff_id,
              s.name AS assigned_name,
              (SELECT count(*) FROM messages m
                WHERE m.application_id = a.id AND m.author = 'candidate' AND m.read_by_staff_at IS NULL) AS unread,
              (SELECT count(*) FROM documents d WHERE d.application_id = a.id AND d.shredded_at IS NULL) AS documents,
              (SELECT max(created_at) FROM messages m WHERE m.application_id = a.id) AS last_message_at
         FROM applications a
         LEFT JOIN staff s ON s.id = a.assigned_staff_id
        WHERE ${where.join(" AND ")}
        ORDER BY a.received_at DESC, a.id DESC
        LIMIT $${params.length}`,
      params
    );

    const counts = await many(`SELECT status, count(*)::int AS n FROM applications GROUP BY status`);
    res.json({ applications: rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
  } catch (err) { next(err); }
});

staffRouter.get("/applications/:id", requireStaff(), async (req, res, next) => {
  try {
    const app = await one(`SELECT * FROM applications WHERE id = $1`, [req.params.id]);
    if (!app) return res.status(404).json({ error: "not_found" });

    const [notes, messages, documents, requests, signatures, events] = await Promise.all([
      many(`SELECT n.id, n.body, n.created_at, s.name AS staff_name
              FROM review_notes n LEFT JOIN staff s ON s.id = n.staff_id
             WHERE n.application_id = $1 ORDER BY n.created_at DESC`, [req.params.id]),
      many(`SELECT m.id, m.author, m.body, m.created_at, m.read_by_candidate_at, s.name AS staff_name
              FROM messages m LEFT JOIN staff s ON s.id = m.staff_id
             WHERE m.application_id = $1 ORDER BY m.created_at`, [req.params.id]),
      many(`SELECT id, direction, kind, filename, mime_type, size_bytes, created_at, shredded_at
              FROM documents WHERE application_id = $1 ORDER BY created_at DESC`, [req.params.id]),
      many(`SELECT r.id, r.kind, r.instructions, r.fulfilled_at, r.cancelled_at, r.created_at,
                   r.fulfilled_by_document_id
              FROM document_requests r WHERE r.application_id = $1 ORDER BY r.created_at DESC`, [req.params.id]),
      many(`SELECT id, title, body, signed_at, signed_name, cancelled_at, created_at
              FROM signature_requests WHERE application_id = $1 ORDER BY created_at DESC`, [req.params.id]),
      many(`SELECT e.from_status, e.to_status, e.note, e.created_at, s.name AS staff_name
              FROM application_status_events e LEFT JOIN staff s ON s.id = e.staff_id
             WHERE e.application_id = $1 ORDER BY e.created_at DESC`, [req.params.id]),
    ]);

    await query(
      `UPDATE messages SET read_by_staff_at = now()
        WHERE application_id = $1 AND author = 'candidate' AND read_by_staff_at IS NULL`,
      [req.params.id]
    );
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "application.viewed", applicationId: app.id, ip: clientIp(req) });

    res.json({ application: app, notes, messages, documents, requests, signatures, events, statuses: STATUSES });
  } catch (err) { next(err); }
});

staffRouter.post("/applications/:id/status", requireStaff(), async (req, res, next) => {
  try {
    const to = String(req.body?.status || "");
    if (!STATUSES.includes(to)) return res.status(422).json({ error: "invalid_status" });
    const app = await one("SELECT id, status FROM applications WHERE id = $1", [req.params.id]);
    if (!app) return res.status(404).json({ error: "not_found" });

    const decided = ["active", "declined", "withdrawn"].includes(to);
    await query(
      `UPDATE applications
          SET status = $2, updated_at = now(),
              decided_at = CASE WHEN $3 THEN now() ELSE decided_at END,
              decided_by = CASE WHEN $3 THEN $4 ELSE decided_by END,
              decision_reason = COALESCE($5, decision_reason)
        WHERE id = $1`,
      [app.id, to, decided, req.staff.staff_id, req.body?.reason || null]
    );
    await query(
      `INSERT INTO application_status_events (application_id, from_status, to_status, staff_id, note)
       VALUES ($1,$2,$3,$4,$5)`,
      [app.id, app.status, to, req.staff.staff_id, req.body?.reason || null]
    );
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "application.status_changed",
                  applicationId: app.id, detail: { from: app.status, to }, ip: clientIp(req) });
    res.json({ ok: true, status: to });
  } catch (err) { next(err); }
});

staffRouter.post("/applications/:id/assign", requireStaff(), async (req, res, next) => {
  try {
    const assignee = req.body?.staffId === "me" ? req.staff.staff_id : (req.body?.staffId || null);
    await query("UPDATE applications SET assigned_staff_id = $2, updated_at = now() WHERE id = $1", [req.params.id, assignee]);
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "application.assigned",
                  applicationId: req.params.id, detail: { assignee }, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

staffRouter.post("/applications/:id/notes", requireStaff(), async (req, res, next) => {
  try {
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(422).json({ error: "empty_note" });
    const note = await one(
      `INSERT INTO review_notes (application_id, staff_id, body) VALUES ($1,$2,$3)
       RETURNING id, body, created_at`,
      [req.params.id, req.staff.staff_id, body.slice(0, 20000)]
    );
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "note.added", applicationId: req.params.id, ip: clientIp(req) });
    res.status(201).json({ note: { ...note, staff_name: req.staff.name } });
  } catch (err) { next(err); }
});

/* ----------------------------------------------------------- messaging ---- */

staffRouter.post("/applications/:id/messages", requireStaff(), async (req, res, next) => {
  try {
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(422).json({ error: "empty_message" });
    const app = await one("SELECT id, email, first_name, last_name FROM applications WHERE id = $1", [req.params.id]);
    if (!app) return res.status(404).json({ error: "not_found" });

    const message = await one(
      `INSERT INTO messages (application_id, author, staff_id, body) VALUES ($1,'staff',$2,$3)
       RETURNING id, author, body, created_at`,
      [app.id, req.staff.staff_id, body.slice(0, 20000)]
    );
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "message.sent", applicationId: app.id, ip: clientIp(req) });

    /* The notification says a message exists; the message itself stays here. */
    const link = await issueMagicLink(app.id);
    const mailed = await send({ to: app.email, ...templates.newMessage(fullName(app), link) });
    if (mailed.sent) {
      await query("UPDATE messages SET notified_at = now() WHERE id = $1", [message.id]);
    }

    res.status(201).json({ message: { ...message, staff_name: req.staff.name }, notified: mailed.sent });
  } catch (err) { next(err); }
});

/* ----------------------------------------------------------- documents ---- */

staffRouter.post("/applications/:id/documents", requireStaff(), async (req, res, next) => {
  try {
    const { fields, files } = await parseMultipart(req);
    const file = files[0];
    if (!file) return res.status(422).json({ error: "no_file" });
    const detected = detectType(file.bytes, file.filename);
    if (!detected.ok) return res.status(422).json({ error: "rejected", message: detected.reason });

    const doc = await storeDocument({
      applicationId: req.params.id, direction: "outbound",
      kind: String(fields.kind || "document").slice(0, 80),
      filename: file.filename, mime: detected.mime, bytes: file.bytes,
      uploadedByStaffId: req.staff.staff_id,
    });
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "document.sent",
                  applicationId: req.params.id, detail: { documentId: doc.id }, ip: clientIp(req) });
    res.status(201).json({ document: doc });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    next(err);
  }
});

staffRouter.get("/documents/:id", requireStaff(), async (req, res, next) => {
  try {
    const doc = await loadDocumentMeta(req.params.id);
    if (!doc) return res.status(404).json({ error: "not_found" });
    const bytes = await readDocumentBytes(doc);
    if (!bytes) return res.status(404).json({ error: "not_found" });
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "document.downloaded",
                  applicationId: doc.application_id, detail: { documentId: doc.id }, ip: clientIp(req) });
    sendDocument(res, doc, bytes);
  } catch (err) { next(err); }
});

staffRouter.delete("/documents/:id", requireStaff({ role: "admin" }), async (req, res, next) => {
  try {
    const doc = await one("SELECT application_id FROM documents WHERE id = $1", [req.params.id]);
    if (!doc) return res.status(404).json({ error: "not_found" });
    await shredDocument(req.params.id);
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "document.shredded",
                  applicationId: doc.application_id, detail: { documentId: req.params.id }, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

staffRouter.post("/applications/:id/document-requests", requireStaff(), async (req, res, next) => {
  try {
    const kind = String(req.body?.kind || "").trim();
    if (!kind) return res.status(422).json({ error: "missing_kind" });
    const app = await one("SELECT id, email, first_name, last_name FROM applications WHERE id = $1", [req.params.id]);
    if (!app) return res.status(404).json({ error: "not_found" });

    const request = await one(
      `INSERT INTO document_requests (application_id, kind, instructions, requested_by)
       VALUES ($1,$2,$3,$4) RETURNING id, kind, instructions, created_at`,
      [app.id, kind.slice(0, 120), String(req.body?.instructions || "").slice(0, 4000) || null, req.staff.staff_id]
    );
    const link = await issueMagicLink(app.id);
    const mailed = await send({ to: app.email, ...templates.documentRequested(fullName(app), kind, link) });
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "document.requested",
                  applicationId: app.id, detail: { kind }, ip: clientIp(req) });
    res.status(201).json({ request, notified: mailed.sent });
  } catch (err) { next(err); }
});

/* --------------------------------------------------- forms for signature ---- */

staffRouter.post("/applications/:id/signature-requests", requireStaff(), async (req, res, next) => {
  try {
    const title = String(req.body?.title || "").trim();
    const body = String(req.body?.body || "").trim();
    if (!title || !body) return res.status(422).json({ error: "missing_fields" });
    const app = await one("SELECT id, email, first_name, last_name FROM applications WHERE id = $1", [req.params.id]);
    if (!app) return res.status(404).json({ error: "not_found" });

    const request = await one(
      `INSERT INTO signature_requests (application_id, title, body, requested_by)
       VALUES ($1,$2,$3,$4) RETURNING id, title, body, created_at`,
      [app.id, title.slice(0, 200), body.slice(0, 50000), req.staff.staff_id]
    );
    const link = await issueMagicLink(app.id);
    const mailed = await send({ to: app.email, ...templates.signatureRequested(fullName(app), title, link) });
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "signature.requested",
                  applicationId: app.id, detail: { title }, ip: clientIp(req) });
    res.status(201).json({ request, notified: mailed.sent });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------- admin ---- */

staffRouter.get("/staff", requireStaff(), async (req, res, next) => {
  try {
    res.json({ staff: await many("SELECT id, name, email, role, is_active FROM staff ORDER BY name") });
  } catch (err) { next(err); }
});

staffRouter.post("/applications/:id/resend-link", requireStaff(), async (req, res, next) => {
  try {
    const app = await one("SELECT id, email, first_name, last_name FROM applications WHERE id = $1", [req.params.id]);
    if (!app) return res.status(404).json({ error: "not_found" });
    const link = await issueMagicLink(app.id);
    const mailed = await send({ to: app.email, ...templates.caseLink(fullName(app), link) });
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "case_link.resent", applicationId: app.id, ip: clientIp(req) });
    res.json({ ok: true, notified: mailed.sent });
  } catch (err) { next(err); }
});

/* Changing the delivery address revokes every outstanding link and session, so
   a link sent to the old address cannot be used afterwards. */
staffRouter.post("/applications/:id/email", requireStaff({ role: "admin" }), async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(422).json({ error: "invalid_email" });
    await query("UPDATE applications SET email = $2, updated_at = now() WHERE id = $1", [req.params.id, email]);
    await revokeAllCaseAccess(req.params.id);
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "application.email_changed",
                  applicationId: req.params.id, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

const CSV_COLUMNS = [
  "reference", "status", "received_at", "first_name", "last_name", "email", "phone",
  "city", "state", "zip", "contact_method", "military_connection", "branch",
  "occupation", "education", "volunteer_setting", "willing_to_travel", "start_date",
];

staffRouter.get("/export.csv", requireStaff({ role: "admin" }), async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT ${CSV_COLUMNS.join(", ")} FROM applications ORDER BY received_at DESC LIMIT 5000`
    );
    await audit({ actorType: "staff", actorId: req.staff.staff_id, action: "export.csv",
                  detail: { rows: rows.length }, ip: clientIp(req) });
    /* A leading =, +, - or @ makes a spreadsheet treat a value as a formula. */
    const cell = (v) => {
      let s = v == null ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = "﻿" + [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(","))].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="mission-earned-applications.csv"');
    res.setHeader("Cache-Control", "no-store, private");
    res.end(csv);
  } catch (err) { next(err); }
});
