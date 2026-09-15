/* Response headers, cookies, CSRF and rate limiting. */
import crypto from "node:crypto";
import config from "../config.js";
import { hmac, timingSafeEqualStr } from "./crypto.js";
import { query } from "../db.js";

/* The portal is served by this app, so the policy can be strict: no inline
   script at all, nothing loaded from anywhere but this origin. Inline SVG in
   the markup is fine — it is not a fetched resource. */
export function securityHeaders(req, res, next) {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; ")
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (config.isProd) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  /* Nothing this service returns should sit in a shared cache. */
  res.setHeader("Cache-Control", "no-store, private");
  next();
}

/* Railway terminates TLS at the edge and forwards the original scheme. */
export function requireHttps(req, res, next) {
  if (!config.isProd) return next();
  if (req.get("x-forwarded-proto") === "https") return next();
  res.status(403).json({ error: "https_required" });
}

export function setCookie(res, name, value, maxAgeMs, path = "/") {
  /* The __Host- prefix binds the cookie to exactly this hostname and forbids a
     Domain attribute, so a subdomain cannot overwrite it. It requires Secure,
     which localhost over http cannot satisfy — hence the dev-only name. */
  const cookieName = config.isProd ? `__Host-${name}` : name;
  const parts = [`${cookieName}=${value}`, `Path=${path}`, "HttpOnly", "SameSite=Lax"];
  if (config.isProd) parts.push("Secure");
  if (maxAgeMs != null) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  appendCookie(res, parts.join("; "));
}

export function clearCookie(res, name, path = "/") {
  const cookieName = config.isProd ? `__Host-${name}` : name;
  const parts = [`${cookieName}=`, `Path=${path}`, "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (config.isProd) parts.push("Secure");
  appendCookie(res, parts.join("; "));
}

function appendCookie(res, value) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) res.setHeader("Set-Cookie", [value]);
  else res.setHeader("Set-Cookie", [].concat(existing, value));
}

export function readCookie(req, name) {
  const cookieName = config.isProd ? `__Host-${name}` : name;
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === cookieName) return part.slice(idx + 1).trim();
  }
  return null;
}

/* CSRF: an Origin / Sec-Fetch-Site gate that fails closed, plus a token bound
   to the session so a cookie an attacker can write is not a token they can
   use. Both must pass. */
export function csrfToken(sessionId) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const sig = hmac(config.secrets.csrf, `${sessionId}.${nonce}`).toString("base64url");
  return `${nonce}.${sig}`;
}

export function csrfTokenValid(token, sessionId) {
  const [nonce, sig] = String(token || "").split(".");
  if (!nonce || !sig) return false;
  const expected = hmac(config.secrets.csrf, `${sessionId}.${nonce}`).toString("base64url");
  return timingSafeEqualStr(sig, expected);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function checkOrigin(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  const site = req.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.get("origin");
  if (origin) return origin === config.appOrigin;
  /* Neither header present: an old browser, or a non-browser client that
     happens to hold a cookie. Refuse rather than guess. */
  return false;
}

/* Counts attempts in Postgres rather than memory, so the limit survives a
   redeploy and holds across replicas. */
export async function rateLimit(bucket, limit, windowMs) {
  const resetAt = new Date(Date.now() + windowMs);
  const { rows } = await query(
    `INSERT INTO rate_limits (bucket, count, reset_at)
          VALUES ($1, 1, $2)
     ON CONFLICT (bucket) DO UPDATE
        SET count    = CASE WHEN rate_limits.reset_at < now() THEN 1 ELSE rate_limits.count + 1 END,
            reset_at = CASE WHEN rate_limits.reset_at < now() THEN $2 ELSE rate_limits.reset_at END
      RETURNING count, reset_at`,
    [bucket, resetAt]
  );
  const row = rows[0];
  return { allowed: row.count <= limit, count: row.count, resetAt: row.reset_at };
}

export function clientIp(req) {
  const fwd = req.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}
