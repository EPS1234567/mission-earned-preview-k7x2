/* The one endpoint the public static site calls.
 *
 * Cookieless and cross-origin: the volunteer form lives on the marketing site
 * and this request carries no credentials, so CORS here grants nothing an
 * attacker could not already do with curl. */
import { createHash } from "node:crypto";
import express from "express";
import config from "../config.js";
import { one, tx } from "../db.js";
import { parseMultipart, detectType } from "../lib/upload.js";
import { normaliseSubmission, newReference, fingerprint, fullName, SCALAR_FIELDS, MULTI_FIELDS, DATE_FIELDS, AGREEMENT_FIELDS } from "../lib/applications.js";
import { storeDocument } from "../lib/documents.js";
import { rateLimit, clientIp } from "../lib/security.js";
import { audit } from "../lib/audit.js";
import { send, templates } from "../lib/mail.js";
import { issueMagicLink } from "../lib/auth.js";

export const publicRouter = express.Router();

publicRouter.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && config.formOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
    res.setHeader("Access-Control-Max-Age", "86400");
    /* Explicitly NOT Allow-Credentials: this endpoint must never see a cookie. */
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

publicRouter.post("/applications", async (req, res, next) => {
  try {
    const ip = clientIp(req);
    const limit = await rateLimit(`apply:${ip || "unknown"}`, 10, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "rate_limited",
        message: `Too many submissions from this connection. Please call ${config.org.phone} and we'll take your application directly.`,
      });
    }

    let fields, files;
    if ((req.get("content-type") || "").startsWith("multipart/form-data")) {
      ({ fields, files } = await parseMultipart(req));
    } else {
      fields = req.body || {};
      files = [];
    }

    /* Honeypot: accept and discard, so a bot learns nothing from the response. */
    if (fields.botcheck) {
      return res.status(202).json({ ok: true });
    }

    const { app, errors } = normaliseSubmission(fields);
    if (errors.length) {
      return res.status(422).json({ error: "validation_failed", errors });
    }

    /* Every accepted application emails a link to the address given. Without a
       per-address limit this endpoint is an email-bombing relay pointed at
       whoever an attacker names, and an IP limit alone does not stop a
       distributed one. Hashed so the limiter table holds no addresses. */
    const emailKey = createHash("sha256").update(app.email.toLowerCase()).digest("hex").slice(0, 32);
    const perEmail = await rateLimit(`apply:email:${emailKey}`, 3, 24 * 60 * 60 * 1000);
    if (!perEmail.allowed) {
      await audit({ actorType: "public", action: "application.email_rate_limited", ip });
      return res.status(429).json({
        error: "rate_limited",
        message: `We've already received applications for that email address today. ` +
          `If something went wrong, please call ${config.org.phone} and we'll sort it out.`,
      });
    }

    /* Validate the attachment before opening a transaction — a rejected file
       should not leave a half-written application behind. */
    let resume = null;
    const resumeFile = files.find((f) => f.field === "resume");
    if (resumeFile) {
      const detected = detectType(resumeFile.bytes, resumeFile.filename);
      if (!detected.ok) {
        return res.status(422).json({
          error: "validation_failed",
          errors: [{ field: "resume", message: detected.reason }],
        });
      }
      resume = { ...resumeFile, mime: detected.mime };
    }

    const idempotencyKey = req.get("idempotency-key") || null;
    const fp = fingerprint(app);

    const result = await tx(async (client) => {
      if (idempotencyKey) {
        const existing = await client.query(
          "SELECT application_id FROM idempotency_keys WHERE key = $1", [idempotencyKey]
        );
        if (existing.rows[0]?.application_id) {
          return { id: existing.rows[0].application_id, duplicate: true };
        }
      }
      /* Same person, same answers, same day — a refresh-resubmit after a
         timeout, not a second application. */
      const sameDay = await client.query(
        `SELECT id FROM applications
          WHERE lower(email) = lower($1)
            AND received_at > now() - interval '1 day'
            AND md5(coalesce(motivation,'')) = md5(coalesce($2,''))
          LIMIT 1`,
        [app.email, app.motivation]
      );
      if (sameDay.rows[0]) {
        if (idempotencyKey) {
          await client.query(
            "INSERT INTO idempotency_keys (key, application_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [idempotencyKey, sameDay.rows[0].id]
          );
        }
        return { id: sameDay.rows[0].id, duplicate: true };
      }

      const columns = [
        ...SCALAR_FIELDS, ...MULTI_FIELDS, ...DATE_FIELDS, ...AGREEMENT_FIELDS,
        "signature_png", "extra_answers", "raw_submission",
      ];
      const values = columns.map((c) => app[c]);
      const placeholders = columns.map((_, i) => `$${i + 1}`);

      const inserted = await client.query(
        `INSERT INTO applications (${columns.join(", ")}, reference, submitted_ip)
         VALUES (${placeholders.join(", ")}, $${columns.length + 1}, $${columns.length + 2})
         RETURNING id, reference`,
        [...values, newReference(), ip]
      );
      const row = inserted.rows[0];

      if (idempotencyKey) {
        await client.query(
          "INSERT INTO idempotency_keys (key, application_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [idempotencyKey, row.id]
        );
      }
      await client.query(
        `INSERT INTO application_status_events (application_id, to_status, note)
         VALUES ($1, 'received', 'Application submitted')`,
        [row.id]
      );
      return { id: row.id, reference: row.reference, duplicate: false, fp };
    });

    if (result.duplicate) {
      return res.status(200).json({ ok: true, duplicate: true, reference: result.reference });
    }

    /* The resume is stored encrypted, keyed to the document row, and is only
       ever served back through an authorised, non-rendering download. */
    if (resume) {
      try {
        await storeDocument({
          applicationId: result.id, direction: "inbound", kind: "resume",
          filename: resume.filename, mime: resume.mime, bytes: resume.bytes,
        });
      } catch (err) {
        /* A failed attachment must not lose the application itself. */
        console.error(JSON.stringify({ level: "error", msg: "resume store failed", err: err.message }));
      }
    }

    await audit({ actorType: "public", action: "application.submitted", applicationId: result.id, ip });

    /* Notify out of band — a slow mail server must not hold up the applicant. */
    queueMicrotask(async () => {
      try {
        const name = fullName(app);
        const link = await issueMagicLink(result.id);
        await send({ to: app.email, ...templates.caseLink(name, link) });
        for (const to of config.mail.staffNotify) {
          await send({ to, ...templates.staffNewApplication(name, result.reference, `${config.appOrigin}/staff/#/case/${result.id}`) });
        }
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "post-submit notify failed", err: err.message }));
      }
    });

    res.status(201).json({ ok: true, reference: result.reference });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    next(err);
  }
});
