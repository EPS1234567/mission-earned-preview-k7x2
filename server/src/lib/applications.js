/* Mapping between the volunteer form's field names and the applications table. */
import crypto from "node:crypto";

/* Every field the portal filters, searches, sorts or exports on is a real
   column. Anything the form grows later lands in extra_answers instead of
   silently disappearing. */
export const SCALAR_FIELDS = [
  "title", "first_name", "last_name", "email", "phone", "address", "city",
  "state", "zip", "contact_method", "military_connection", "branch",
  "occupation", "education", "interests_other", "volunteer_setting",
  "willing_to_travel", "has_experience", "experience_detail",
  "speaks_languages", "languages_detail", "motivation", "anything_else",
  "signature_name",
];

export const MULTI_FIELDS = ["interests", "availability"];
export const DATE_FIELDS = ["start_date", "signature_date"];
export const AGREEMENT_FIELDS = [
  "agree_age", "agree_review", "agree_screening", "agree_assignment", "agree_accurate",
];
/* Submitted but deliberately not stored as their own column. */
export const IGNORED_FIELDS = new Set([
  "botcheck", "access_key", "subject", "to_email", "from_name",
  "signature", "signature_typed", "resume_filename", "_csrf",
]);

const REQUIRED = ["first_name", "last_name", "email", "phone", "motivation"];

/* A DD-214 carries an SSN and a veteran may type one into a free-text box out
   of habit. This system has no field that needs one, so it refuses it at the
   door rather than storing it. */
const SSN_RE = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;
const EMAIL_RE = /^[^\s@]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

function str(v) {
  if (Array.isArray(v)) v = v[v.length - 1];
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function arr(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
}

function dateOrNull(v) {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const year = Number(s.slice(0, 4));
  if (year < 1900 || year > 2200) return null;
  return s;
}

export function normaliseSubmission(fields) {
  const errors = [];
  const app = {};

  for (const name of SCALAR_FIELDS) app[name] = str(fields[name]) || null;
  for (const name of MULTI_FIELDS) app[name] = arr(fields[name]);
  for (const name of DATE_FIELDS) app[name] = dateOrNull(fields[name]);
  for (const name of AGREEMENT_FIELDS) app[name] = Boolean(str(fields[name]));

  app.signature_png = str(fields.signature) || null;
  if (app.signature_png && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(app.signature_png)) {
    app.signature_png = null;
    errors.push({ field: "signature", message: "The signature didn't come through. Please sign again." });
  }
  /* Keep a signature image to a sane size — it is a scribble, not a photo. */
  if (app.signature_png && app.signature_png.length > 400_000) {
    errors.push({ field: "signature", message: "The signature image is too large." });
  }

  for (const name of REQUIRED) {
    if (!app[name]) errors.push({ field: name, message: "This field is required." });
  }
  if (app.email && !EMAIL_RE.test(app.email)) {
    errors.push({ field: "email", message: "Enter a valid email address." });
  }
  if (app.phone && app.phone.replace(/\D/g, "").length < 10) {
    errors.push({ field: "phone", message: "Enter a phone number with area code." });
  }
  for (const name of AGREEMENT_FIELDS) {
    if (!app[name]) errors.push({ field: name, message: "This agreement is required." });
  }

  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "string" && SSN_RE.test(value)) {
      errors.push({
        field: name,
        message: "Please remove the Social Security number — we never need it and don't store it.",
      });
    }
  }

  const known = new Set([
    ...SCALAR_FIELDS, ...MULTI_FIELDS, ...DATE_FIELDS, ...AGREEMENT_FIELDS, ...IGNORED_FIELDS,
  ]);
  const extra = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!known.has(name)) extra[name] = value;
  }
  app.extra_answers = extra;

  /* The raw copy never includes the honeypot or the signature blob. */
  const raw = { ...fields };
  for (const k of ["botcheck", "access_key", "signature"]) delete raw[k];
  app.raw_submission = raw;

  return { app, errors };
}

/* A short, sayable reference a veteran can quote on the phone. */
export function newReference(when = new Date()) {
  const y = when.getUTCFullYear();
  const alphabet = "ACDEFHJKLMNPRTUVWXY3479";
  let tail = "";
  const bytes = crypto.randomBytes(5);
  for (const b of bytes) tail += alphabet[b % alphabet.length];
  return `ME-${y}-${tail}`;
}

/* A resubmit after a timeout arrives with a fresh idempotency key, so content
   is fingerprinted too: same person, same answers, same day is one
   application. */
export function fingerprint(app) {
  const material = [
    (app.email || "").toLowerCase(),
    (app.first_name || "").toLowerCase(),
    (app.last_name || "").toLowerCase(),
    (app.motivation || "").slice(0, 200),
    new Date().toISOString().slice(0, 10),
  ].join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
}

export function fullName(app) {
  return [app.first_name, app.last_name].filter(Boolean).join(" ").trim() || app.email || "Applicant";
}
