/* Password hashing, opaque tokens, TOTP and envelope encryption.
 *
 * Everything here is built on node:crypto. That is deliberate: a native
 * binding that fails to compile on a deploy is an outage, and this service is
 * the only route a veteran has to apply. */
import crypto from "node:crypto";
import { promisify } from "node:util";
import config from "../config.js";

const scrypt = promisify(crypto.scrypt);

/* OWASP's scrypt floor. ~150-350ms on a shared vCPU, which is the point. */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* 256 bits of randomness needs no stretching; the database stores only the
   digest, so a dump yields nothing usable. */
export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest();
}

export function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* Magic links are selector.verifier: the selector is indexed and looked up in
   constant work, the verifier is compared against a peppered HMAC. Splitting
   them means the lookup cannot be turned into a timing oracle and the stored
   row cannot mint a session on its own. */
export function newMagicLinkToken() {
  const selector = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  return {
    selector,
    verifier,
    token: `${selector}.${verifier}`,
    verifierHmac: hmac(config.secrets.magicPepper, verifier),
  };
}

export function parseMagicLinkToken(token) {
  const [selector, verifier] = String(token || "").split(".");
  if (!selector || !verifier) return null;
  return { selector, verifier, verifierHmac: hmac(config.secrets.magicPepper, verifier) };
}

/* ---------------------------------------------------------------- TOTP ---- */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret) {
  let bits = "";
  for (const ch of secret.toUpperCase().replace(/=+$/, "")) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) |
               (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

/* One step either side absorbs clock drift without meaningfully widening the
   window an attacker has to guess a six-digit code. */
export function verifyTotp(secret, code, atMs = Date.now()) {
  const clean = String(code || "").replace(/\D/g, "");
  if (clean.length !== 6) return false;
  const counter = Math.floor(atMs / 1000 / 30);
  for (const drift of [-1, 0, 1]) {
    if (timingSafeEqualStr(totpAt(secret, counter + drift), clean)) return true;
  }
  return false;
}

export function totpUri(secret, email) {
  const label = encodeURIComponent(`${config.org.shortName}:${email}`);
  const issuer = encodeURIComponent(config.org.shortName);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

/* -------------------------------------------------- envelope encryption ---- */

/* Each document gets its own key; that key is stored wrapped under the master
   key. Rotating the master key is then a cheap re-wrap of a few rows rather
   than rewriting every file, and destroying one wrapped key shreds exactly one
   document without touching the rest. */
export function encryptDocument(plaintext, documentId) {
  const dek = crypto.randomBytes(32);
  const fileIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dek, fileIv);
  cipher.setAAD(Buffer.from(documentId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const fileTag = cipher.getAuthTag();

  const dekIv = crypto.randomBytes(12);
  const wrapper = crypto.createCipheriv("aes-256-gcm", config.secrets.fileMaster, dekIv);
  wrapper.setAAD(Buffer.from(documentId, "utf8"));
  const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()]);
  const dekTag = wrapper.getAuthTag();

  dek.fill(0);
  return { ciphertext, fileIv, fileTag, wrappedDek, dekIv, dekTag };
}

export function decryptDocument(ciphertext, doc, documentId) {
  const unwrap = crypto.createDecipheriv("aes-256-gcm", config.secrets.fileMaster, doc.dek_iv);
  unwrap.setAAD(Buffer.from(documentId, "utf8"));
  unwrap.setAuthTag(doc.dek_tag);
  const dek = Buffer.concat([unwrap.update(doc.wrapped_dek), unwrap.final()]);

  const decipher = crypto.createDecipheriv("aes-256-gcm", dek, doc.file_iv);
  decipher.setAAD(Buffer.from(documentId, "utf8"));
  decipher.setAuthTag(doc.file_tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  dek.fill(0);
  return plaintext;
}
