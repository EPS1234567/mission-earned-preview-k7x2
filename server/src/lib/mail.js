/* Outbound notification email.
 *
 * Mail leaves this system's control the moment it is sent, so a notification
 * never carries application content, message bodies or documents. It carries
 * the fact that something happened and a link to come and read it. */
import nodemailer from "nodemailer";
import config from "../config.js";

let transport = null;
function getTransport() {
  if (!config.mail.enabled) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    });
  }
  return transport;
}

/* Resolves to whether the message was actually handed to an SMTP server.
   Callers record that outcome rather than assuming delivery. */
export async function send({ to, subject, text }) {
  const t = getTransport();
  if (!t) {
    console.warn(JSON.stringify({ level: "warn", msg: "email not sent: no SMTP configured", to, subject }));
    return { sent: false, reason: "smtp_not_configured" };
  }
  try {
    await t.sendMail({ from: config.mail.from, to, subject, text });
    return { sent: true };
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "email send failed", to, subject, err: err.message }));
    return { sent: false, reason: err.message };
  }
}

const sig = `\n\n— ${config.org.shortName}\n${config.org.phone}\n${config.org.email}\n`;

export const templates = {
  caseLink: (name, url) => ({
    subject: `Your ${config.org.shortName} volunteer application`,
    text: `Hello ${name},\n\nUse the link below to check your volunteer application, send us a message, ` +
      `upload a document, or sign a form.\n\n${url}\n\nThis link is for you alone and expires in 15 minutes. ` +
      `If you need a new one, ask us and we'll send another.\n\nIf you didn't apply to volunteer with us, ` +
      `you can ignore this email.${sig}`,
  }),
  newMessage: (name, url) => ({
    subject: `A message about your ${config.org.shortName} application`,
    text: `Hello ${name},\n\nOur team has sent you a message about your volunteer application. ` +
      `Use the link below to read it and reply.\n\n${url}\n\nWe don't include message content in email.${sig}`,
  }),
  documentRequested: (name, kind, url) => ({
    subject: `${config.org.shortName} needs a document from you`,
    text: `Hello ${name},\n\nWe've asked for the following to continue your application: ${kind}\n\n` +
      `You can upload it here:\n\n${url}\n\nIf you'd rather send it another way, call us at ${config.org.phone}.${sig}`,
  }),
  signatureRequested: (name, title, url) => ({
    subject: `${config.org.shortName}: please sign "${title}"`,
    text: `Hello ${name},\n\nThere's a form waiting for your signature: ${title}\n\n` +
      `You can read and sign it here:\n\n${url}${sig}`,
  }),
  staffNewApplication: (name, reference, url) => ({
    subject: `New volunteer application — ${name} (${reference})`,
    text: `A new volunteer application has been received.\n\nApplicant: ${name}\nReference: ${reference}\n\n` +
      `Review it here:\n\n${url}\n`,
  }),
  staffNewMessage: (name, reference, url) => ({
    subject: `Reply from ${name} (${reference})`,
    text: `${name} has replied about their volunteer application.\n\nReference: ${reference}\n\n${url}\n`,
  }),
};
