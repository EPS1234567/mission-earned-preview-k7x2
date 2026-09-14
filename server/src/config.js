/* Configuration, read once from the environment and validated at boot.
 *
 * A misconfigured secret must stop the process, not surface later as a
 * quietly insecure default. Everything security-critical is required in
 * production and has no fallback. */
import crypto from "node:crypto";

const PROD = process.env.NODE_ENV === "production";

function required(name) {
  const v = process.env[name];
  if (v) return v;
  if (PROD) throw new Error(`Missing required environment variable: ${name}`);
  /* Development only: a deterministic-per-boot value so the app runs locally
     without a .env, while never silently shipping a known key. */
  return crypto.randomBytes(32).toString("base64");
}

function key32(name) {
  const raw = required(name);
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    const detail = `${name} must be 32 bytes, base64-encoded (got ${buf.length}). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`;
    if (PROD) throw new Error(detail);
    /* Substituting a random key here would make every process disagree and
       every token silently fail to verify. Say so rather than letting someone
       lose an afternoon to it. */
    if (process.env[name]) console.warn(`WARNING: ${detail}\n  Using a random key for this process only.`);
    return crypto.randomBytes(32);
  }
  return buf;
}

function list(name, fallback = []) {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export const config = {
  env: process.env.NODE_ENV || "development",
  isProd: PROD,
  port: Number(process.env.PORT) || 3000,

  /* The origin this service is served from, e.g. https://app.missionearned.org.
     Used for magic links, cookie checks and the Origin allow-list. */
  appOrigin: (process.env.APP_ORIGIN || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/$/, ""),

  /* Origins allowed to POST the public volunteer form cross-site. That request
     is credential-free, so this list does not gate anything authenticated. */
  formOrigins: list("FORM_ORIGINS", ["http://localhost:8080", "http://localhost:8082"]),

  db: {
    url: process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5433/me_test",
    /* Railway's managed Postgres presents a self-signed certificate generated
       inside its own container, reachable only over the private network. Chain
       verification cannot succeed and is not the control that matters here. */
    ssl: process.env.DATABASE_SSL === "false"
      ? false
      : process.env.DATABASE_SSL === "true" || /\.railway\.internal|proxy\.rlwy\.net/.test(process.env.DATABASE_URL || "")
        ? { rejectUnauthorized: false }
        : false,
    poolMax: Number(process.env.DATABASE_POOL_MAX) || 8,
  },

  secrets: {
    /* Wraps every per-document encryption key. Losing it makes every stored
       document permanently unreadable — it must be backed up out of band. */
    fileMaster: key32("FILE_MASTER_KEY"),
    /* Peppers the stored magic-link verifier, so the tokens table alone
       cannot be used to mint a session. */
    magicPepper: key32("MAGICLINK_PEPPER"),
    csrf: key32("CSRF_HMAC_KEY"),
  },

  session: {
    staffIdleMs: 8 * 60 * 60 * 1000,
    staffAbsoluteMs: 12 * 60 * 60 * 1000,
    caseIdleMs: 30 * 60 * 1000,
    caseAbsoluteMs: 4 * 60 * 60 * 1000,
    magicLinkMs: 15 * 60 * 1000,
  },

  uploads: {
    /* Railway's edge gives a request body five minutes to arrive. A cap well
       under that keeps a veteran on a weak connection from hitting an opaque
       edge timeout instead of a real error message. */
    maxBytes: Number(process.env.UPLOAD_MAX_BYTES) || 10 * 1024 * 1024,
  },

  storage: {
    driver: process.env.STORAGE_DRIVER || "local",
    localDir: process.env.STORAGE_DIR || "/data/blobs",
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  },

  mail: {
    /* With no SMTP configured the app still runs; it records that a
       notification could not be sent rather than pretending it was. */
    enabled: Boolean(process.env.SMTP_HOST),
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || "Mission Earned <no-reply@missionearned.org>",
    staffNotify: list("STAFF_NOTIFY_EMAILS"),
  },

  org: {
    name: "Mission Earned Veteran Resource Network, Inc.",
    shortName: "Mission Earned",
    phone: process.env.ORG_PHONE || "(833) 674-6387",
    email: process.env.ORG_EMAIL || "info@missionearned.org",
  },

  /* Admin accounts are required to carry a second factor. Set to "false" only
     for a first-run bootstrap, and turn it back on. */
  requireTotpForAdmin: process.env.REQUIRE_TOTP_FOR_ADMIN !== "false",
};

export default config;
