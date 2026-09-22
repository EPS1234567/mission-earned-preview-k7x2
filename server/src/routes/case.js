/* The candidate's own view of their application.
 *
 * Server-rendered plain HTML with real form posts: it must work on an old
 * phone, a library machine, and with a screen reader, with JavaScript off. */
import express from "express";
import config from "../config.js";
import { one, many, query } from "../db.js";
import {
  consumeMagicLink, createCaseSession, loadCaseSession, revokeCaseSession, CSRF_COOKIE,
} from "../lib/auth.js";
import { csrfToken, csrfTokenValid, readCookie, checkOrigin, rateLimit, clientIp } from "../lib/security.js";
import { audit } from "../lib/audit.js";
import { send, templates } from "../lib/mail.js";
import { parseMultipart, detectType, ACCEPTED_EXTENSIONS } from "../lib/upload.js";
import { storeDocument, loadDocumentMeta, readDocumentBytes, sendDocument } from "../lib/documents.js";
import { fullName } from "../lib/applications.js";
import { page, html, esc, raw, notice } from "../lib/html.js";

export const caseRouter = express.Router();

const STATUS_TEXT = {
  received: ["Application received", "We have your application and it's in the queue for review."],
  in_review: ["In review", "A member of our team is reading through your application."],
  interview_scheduled: ["Interview scheduled", "We'll be in touch about your interview."],
  interviewed: ["Interview complete", "Thanks for meeting with us. We're making a decision."],
  onboarding: ["Onboarding", "You're approved. We're getting your paperwork and training sorted."],
  active: ["Active volunteer", "You're all set. Thank you for standing with those who served."],
  on_hold: ["On hold", "Your application is paused for now. We'll be in touch."],
  withdrawn: ["Withdrawn", "This application has been withdrawn."],
  declined: ["Not moving forward", "We're not able to place you at this time. Thank you for offering your time."],
};

function issueCsrfCookie(res, sessionKey) {
  const token = csrfToken(sessionKey);
  const name = config.isProd ? `__Host-${CSRF_COOKIE}` : CSRF_COOKIE;
  const parts = [`${name}=${token}`, "Path=/p", "SameSite=Lax"];
  if (config.isProd) parts.push("Secure");
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", existing ? [].concat(existing, parts.join("; ")) : [parts.join("; ")]);
  return token;
}

/* Landing point for an emailed link. The token is consumed and exchanged for a
   session, then dropped from the URL immediately so it cannot leak through
   history, a Referer header or a shared screenshot. */
caseRouter.get("/enter", async (req, res, next) => {
  try {
    res.setHeader("Referrer-Policy", "no-referrer");
    const limit = await rateLimit(`case-enter:${clientIp(req) || "unknown"}`, 30, 15 * 60 * 1000);
    if (!limit.allowed) return res.status(429).send(page({
      title: "Too many attempts", heading: "Too many attempts",
      body: notice("error", `Please wait a few minutes, or call ${config.org.phone}.`),
    }));

    const applicationId = await consumeMagicLink(req.query.t);
    if (!applicationId) {
      return res.status(401).send(page({
        title: "Link expired", heading: "That link has expired",
        body: notice("error",
          "For your security these links work once and last 15 minutes. " +
          `Ask us for a new one, or call ${config.org.phone} and we'll help you directly.`),
      }));
    }
    await createCaseSession(res, applicationId, req);
    await audit({ actorType: "candidate", actorId: applicationId, action: "case.entered", applicationId, ip: clientIp(req) });
    res.redirect(303, "/p/");
  } catch (err) { next(err); }
});

async function requireCase(req, res, next) {
  try {
    const session = await loadCaseSession(req);
    if (!session) {
      return res.status(401).send(page({
        title: "Session ended", heading: "Your session has ended",
        body: notice("error",
          "For your security we sign you out after a period of inactivity. " +
          "Use the link in your email again, or ask us for a new one."),
      }));
    }
    req.caseSession = session;
    next();
  } catch (err) { next(err); }
}

/* The no-JS portal posts _csrf as a form field, so for multipart the body must
   be parsed before the token can be checked. Origin is checked first either
   way, and nothing is written until both pass. */
function caseCsrfOk(req, token) {
  if (!checkOrigin(req)) return false;
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!cookie || !token || cookie !== token) return false;
  return csrfTokenValid(token, req.caseSession.id);
}

function guard(req, res, token) {
  if (caseCsrfOk(req, token)) return true;
  res.status(403).send(page({
    title: "Please try again", heading: "Please try again",
    body: notice("error", "Your form session expired before that was sent. Go back and resend it."),
  }));
  return false;
}

caseRouter.get("/", requireCase, async (req, res, next) => {
  try {
    const id = req.caseSession.application_id;
    const app = await one(
      `SELECT id, reference, first_name, last_name, email, status, received_at FROM applications WHERE id = $1`, [id]
    );
    if (!app) return res.status(404).send(page({ title: "Not found", heading: "Not found", body: "" }));

    const [messages, requests, signatures, documents] = await Promise.all([
      many(`SELECT m.id, m.author, m.body, m.created_at, s.name AS staff_name
              FROM messages m LEFT JOIN staff s ON s.id = m.staff_id
             WHERE m.application_id = $1 ORDER BY m.created_at`, [id]),
      many(`SELECT id, kind, instructions, fulfilled_at FROM document_requests
             WHERE application_id = $1 AND cancelled_at IS NULL ORDER BY created_at DESC`, [id]),
      many(`SELECT id, title, signed_at FROM signature_requests
             WHERE application_id = $1 AND cancelled_at IS NULL ORDER BY created_at DESC`, [id]),
      many(`SELECT id, direction, kind, filename, size_bytes, created_at FROM documents
             WHERE application_id = $1 AND shredded_at IS NULL ORDER BY created_at DESC`, [id]),
    ]);

    await query(
      `UPDATE messages SET read_by_candidate_at = now()
        WHERE application_id = $1 AND author = 'staff' AND read_by_candidate_at IS NULL`, [id]);

    const token = issueCsrfCookie(res, req.caseSession.id);
    const [statusTitle, statusBlurb] = STATUS_TEXT[app.status] || ["In progress", ""];
    const outstanding = requests.filter((r) => !r.fulfilled_at);
    const unsigned = signatures.filter((s) => !s.signed_at);

    const body = html`
      <div class="portal-status card">
        <p class="eyebrow">Reference ${app.reference}</p>
        <h2>${statusTitle}</h2>
        <p>${statusBlurb}</p>
        <p class="fine-print">Submitted ${new Date(app.received_at).toLocaleDateString("en-US", { dateStyle: "long" })}</p>
      </div>

      ${raw(outstanding.length ? `
      <section class="portal-section">
        <h2>We need something from you</h2>
        ${outstanding.map((r) => `
          <div class="card portal-task">
            <h3>${esc(r.kind)}</h3>
            ${r.instructions ? `<p>${esc(r.instructions)}</p>` : ""}
            <form method="post" action="/p/upload" enctype="multipart/form-data">
              <input type="hidden" name="_csrf" value="${esc(token)}">
              <input type="hidden" name="request_id" value="${esc(r.id)}">
              <div class="field">
                <label class="field__label" for="file-${esc(r.id)}">Choose a file</label>
                <input class="portal-file" type="file" id="file-${esc(r.id)}" name="file" accept="${ACCEPTED_EXTENSIONS}" required>
                <p class="field__hint">PDF, DOCX, JPG, PNG, TIFF or HEIC, up to
                  ${Math.round(config.uploads.maxBytes / 1024 / 1024)} MB. If your document shows a
                  Social Security number, please black it out first.</p>
              </div>
              <button class="btn btn--navy" type="submit">Send this to Mission Earned</button>
            </form>
          </div>`).join("")}
      </section>` : "")}

      ${raw(unsigned.length ? `
      <section class="portal-section">
        <h2>Waiting for your signature</h2>
        ${unsigned.map((s) => `
          <div class="card portal-task">
            <h3>${esc(s.title)}</h3>
            <p><a class="btn btn--red" href="/p/sign/${esc(s.id)}">Read and sign</a></p>
          </div>`).join("")}
      </section>` : "")}

      <section class="portal-section">
        <h2>Messages</h2>
        ${raw(messages.length ? `<ol class="portal-thread">${messages.map((m) => `
          <li class="portal-msg portal-msg--${m.author === "staff" ? "them" : "you"}">
            <p class="portal-msg__who">${m.author === "staff" ? esc(m.staff_name || config.org.shortName) : "You"}
              <span class="portal-msg__when">${new Date(m.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
            </p>
            <p class="portal-msg__body">${esc(m.body)}</p>
          </li>`).join("")}</ol>`
          : `<p>No messages yet. If you have a question, send it here.</p>`)}

        <form method="post" action="/p/messages">
          <input type="hidden" name="_csrf" value="${esc(token)}">
          <div class="field">
            <label class="field__label" for="message-body">Write a message</label>
            <textarea id="message-body" name="body" required rows="4"></textarea>
          </div>
          <button class="btn btn--navy" type="submit">Send message</button>
        </form>
      </section>

      ${raw(documents.length ? `
      <section class="portal-section">
        <h2>Documents</h2>
        <ul class="portal-docs">
          ${documents.map((d) => `
            <li>
              <a href="/p/documents/${esc(d.id)}">${esc(d.filename)}</a>
              <span class="fine-print">${d.direction === "outbound" ? "Sent to you" : "You sent this"}
                · ${Math.max(1, Math.round(d.size_bytes / 1024))} KB
                · ${new Date(d.created_at).toLocaleDateString("en-US", { dateStyle: "medium" })}</span>
            </li>`).join("")}
        </ul>
      </section>` : "")}

      <form method="post" action="/p/signout" class="portal-signout">
        <input type="hidden" name="_csrf" value="${esc(token)}">
        <button class="btn btn--outline btn--xs" type="submit">Sign out</button>
      </form>
    `;

    res.send(page({
      title: "Your application",
      heading: `Hello ${app.first_name || "there"}`,
      subheading: "This is your private page for your volunteer application.",
      body,
    }));
  } catch (err) { next(err); }
});

caseRouter.post("/messages", requireCase, express.urlencoded({ extended: false, limit: "64kb" }), async (req, res, next) => {
  try {
    if (!guard(req, res, req.body?._csrf)) return;
    const body = String(req.body?.body || "").trim();
    if (!body) return res.redirect(303, "/p/");
    const id = req.caseSession.application_id;

    await one(`INSERT INTO messages (application_id, author, body) VALUES ($1,'candidate',$2) RETURNING id`,
      [id, body.slice(0, 20000)]);
    await audit({ actorType: "candidate", actorId: id, action: "message.sent", applicationId: id, ip: clientIp(req) });

    const app = await one("SELECT reference, first_name, last_name FROM applications WHERE id = $1", [id]);
    for (const to of config.mail.staffNotify) {
      await send({ to, ...templates.staffNewMessage(fullName(app), app.reference, `${config.appOrigin}/staff/#/case/${id}`) });
    }
    res.redirect(303, "/p/?sent=1");
  } catch (err) { next(err); }
});

caseRouter.post("/upload", requireCase, async (req, res, next) => {
  try {
    const { fields, files } = await parseMultipart(req);
    if (!guard(req, res, fields._csrf)) return;
    const file = files[0];
    if (!file) return res.redirect(303, "/p/?error=nofile");

    const detected = detectType(file.bytes, file.filename);
    if (!detected.ok) {
      return res.status(422).send(page({
        title: "File not accepted", heading: "We couldn't accept that file",
        body: notice("error", detected.reason) + `<p><a class="btn btn--navy" href="/p/">Go back and try again</a></p>`,
      }));
    }

    const id = req.caseSession.application_id;
    const requestId = /^\d+$/.test(String(fields.request_id || "")) ? Number(fields.request_id) : null;
    const request = requestId
      ? await one("SELECT id, kind FROM document_requests WHERE id = $1 AND application_id = $2", [requestId, id])
      : null;

    const doc = await storeDocument({
      applicationId: id, direction: "inbound",
      kind: request ? request.kind : "document",
      filename: file.filename, mime: detected.mime, bytes: file.bytes,
      requestId: request ? request.id : null,
    });
    if (request) {
      await query("UPDATE document_requests SET fulfilled_at = now(), fulfilled_by_document_id = $2 WHERE id = $1",
        [request.id, doc.id]);
    }
    await audit({ actorType: "candidate", actorId: id, action: "document.uploaded", applicationId: id,
                  detail: { documentId: doc.id }, ip: clientIp(req) });
    res.redirect(303, "/p/?uploaded=1");
  } catch (err) {
    if (err.status === 413) {
      return res.status(413).send(page({
        title: "File too large", heading: "That file is too large",
        body: notice("error", err.message) + `<p><a class="btn btn--navy" href="/p/">Go back and try again</a></p>`,
      }));
    }
    next(err);
  }
});

caseRouter.get("/sign/:id", requireCase, async (req, res, next) => {
  try {
    const appId = req.caseSession.application_id;
    const request = await one(
      `SELECT id, title, body, signed_at FROM signature_requests
        WHERE id = $1 AND application_id = $2 AND cancelled_at IS NULL`,
      [req.params.id, appId]
    );
    if (!request) return res.status(404).send(page({ title: "Not found", heading: "That form isn't available", body: "" }));
    if (request.signed_at) {
      return res.send(page({
        title: request.title, heading: request.title,
        body: notice("success", "You've already signed this. Thank you.") +
              `<p><a class="btn btn--navy" href="/p/">Back to your application</a></p>`,
      }));
    }
    const token = issueCsrfCookie(res, req.caseSession.id);
    const app = await one("SELECT first_name, last_name FROM applications WHERE id = $1", [appId]);

    res.send(page({
      title: request.title,
      heading: request.title,
      subheading: "Please read this and sign at the bottom.",
      body: html`
        <div class="card portal-doc">${raw(esc(request.body).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>").replace(/^/, "<p>").concat("</p>"))}</div>
        <form method="post" action="/p/sign/${request.id}" class="portal-sign">
          <input type="hidden" name="_csrf" value="${token}">
          <div class="field">
            <label class="field__label" for="signed_name">Type your full name to sign <span class="req" aria-hidden="true">*</span></label>
            <input type="text" id="signed_name" name="signed_name" required autocomplete="name"
                   value="${[app?.first_name, app?.last_name].filter(Boolean).join(" ")}">
            <p class="field__hint">Typing your name here is your signature on this form.</p>
          </div>
          <label class="choice">
            <input type="checkbox" name="agree" required value="yes">
            <span>I have read this form and I agree to it. <span class="req" aria-hidden="true">*</span></span>
          </label>
          <p><button class="btn btn--red btn--lg" type="submit">Sign and return</button></p>
        </form>`,
    }));
  } catch (err) { next(err); }
});

caseRouter.post("/sign/:id", requireCase, express.urlencoded({ extended: false, limit: "256kb" }), async (req, res, next) => {
  try {
    if (!guard(req, res, req.body?._csrf)) return;
    const appId = req.caseSession.application_id;
    const name = String(req.body?.signed_name || "").trim();
    if (!name || req.body?.agree !== "yes") return res.redirect(303, `/p/sign/${req.params.id}`);

    const updated = await one(
      `UPDATE signature_requests
          SET signed_at = now(), signed_name = $3, signature_png = $4, signed_ip = $5, signed_user_agent = $6
        WHERE id = $1 AND application_id = $2 AND signed_at IS NULL AND cancelled_at IS NULL
        RETURNING id, title`,
      [req.params.id, appId, name.slice(0, 200), String(req.body?.signature_png || "").slice(0, 400000) || null,
       clientIp(req), (req.get("user-agent") || "").slice(0, 500)]
    );
    if (!updated) return res.redirect(303, "/p/");

    await audit({ actorType: "candidate", actorId: appId, action: "signature.signed", applicationId: appId,
                  detail: { requestId: updated.id }, ip: clientIp(req) });
    for (const to of config.mail.staffNotify) {
      const app = await one("SELECT reference, first_name, last_name FROM applications WHERE id = $1", [appId]);
      await send({ to, subject: `Signed: ${updated.title} — ${fullName(app)}`,
                   text: `${fullName(app)} has signed "${updated.title}".\n\n${config.appOrigin}/staff/#/case/${appId}\n` });
    }
    res.redirect(303, "/p/?signed=1");
  } catch (err) { next(err); }
});

caseRouter.get("/documents/:id", requireCase, async (req, res, next) => {
  try {
    const notFound = () => res.status(404).send(page({
      title: "Not found", heading: "That document isn't available", body: "",
    }));
    /* Authorise before reading: a candidate may only ever see a document on
       their own case, and we never decrypt one to find that out. */
    const doc = await loadDocumentMeta(req.params.id);
    if (!doc || doc.application_id !== req.caseSession.application_id) return notFound();
    const bytes = await readDocumentBytes(doc);
    if (!bytes) return notFound();
    await audit({ actorType: "candidate", actorId: req.caseSession.application_id, action: "document.downloaded",
                  applicationId: req.caseSession.application_id, detail: { documentId: doc.id }, ip: clientIp(req) });
    sendDocument(res, doc, bytes);
  } catch (err) { next(err); }
});

caseRouter.post("/signout", requireCase, express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    await revokeCaseSession(req, res);
    res.send(page({
      title: "Signed out", heading: "You're signed out",
      body: `<p>Use the link in your email to come back, or call ${esc(config.org.phone)} and we'll help.</p>`,
    }));
  } catch (err) { next(err); }
});
