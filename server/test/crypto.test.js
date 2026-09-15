import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword, verifyPassword, newToken, newMagicLinkToken, parseMagicLinkToken,
  newTotpSecret, verifyTotp, encryptDocument, decryptDocument, timingSafeEqualStr,
} from "../src/lib/crypto.js";

test("password hashing round-trips and rejects wrong passwords", async () => {
  const h = await hashPassword("correct horse battery staple");
  assert.match(h, /^scrypt\$131072\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse battery staple", h), true);
  assert.equal(await verifyPassword("Correct horse battery staple", h), false);
  assert.equal(await verifyPassword("", h), false);
});

test("same password hashes differently each time (unique salt)", async () => {
  const a = await hashPassword("hunter2");
  const b = await hashPassword("hunter2");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("hunter2", a), true);
  assert.equal(await verifyPassword("hunter2", b), true);
});

test("verifyPassword survives garbage instead of throwing", async () => {
  for (const junk of ["", "nonsense", "scrypt$x$y$z", null, undefined, "a$b$c$d$e$f"]) {
    assert.equal(await verifyPassword("x", junk), false);
  }
});

test("tokens are 256-bit and unique", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const t = newToken();
    assert.equal(Buffer.from(t, "base64url").length, 32);
    assert.equal(seen.has(t), false);
    seen.add(t);
  }
});

test("magic link token parses back to the same verifier HMAC", () => {
  const made = newMagicLinkToken();
  const parsed = parseMagicLinkToken(made.token);
  assert.equal(parsed.selector, made.selector);
  assert.equal(Buffer.compare(parsed.verifierHmac, made.verifierHmac), 0);
  // A tampered verifier must not produce the stored HMAC.
  const bad = parseMagicLinkToken(`${made.selector}.${newToken()}`);
  assert.notEqual(Buffer.compare(bad.verifierHmac, made.verifierHmac), 0);
  assert.equal(parseMagicLinkToken("no-dot-here"), null);
  assert.equal(parseMagicLinkToken(""), null);
});

/* RFC 6238 Appendix B test vectors (SHA-1, secret "12345678901234567890").
   Validating against the standard is what proves an authenticator app will
   agree with us — a self-consistency check would not. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

test("TOTP matches the RFC 6238 test vectors", () => {
  for (const [seconds, code] of RFC_VECTORS) {
    assert.equal(verifyTotp(RFC_SECRET, code, seconds * 1000), true,
      `expected ${code} to verify at t=${seconds}`);
  }
});

test("TOTP rejects wrong, malformed and stale codes", () => {
  const at = 1111111111 * 1000;
  assert.equal(verifyTotp(RFC_SECRET, "050472", at), false);
  assert.equal(verifyTotp(RFC_SECRET, "50471", at), false, "5 digits must not pass");
  assert.equal(verifyTotp(RFC_SECRET, "", at), false);
  assert.equal(verifyTotp(RFC_SECRET, null, at), false);
  assert.equal(verifyTotp(RFC_SECRET, "abcdef", at), false);
  // Far outside the drift window.
  assert.equal(verifyTotp(RFC_SECRET, "050471", at + 10 * 30_000), false);
});

test("TOTP tolerates one step of clock drift either side", () => {
  const at = 1111111111 * 1000;
  assert.equal(verifyTotp(RFC_SECRET, "050471", at + 30_000), true, "one step late");
  assert.equal(verifyTotp(RFC_SECRET, "050471", at - 30_000), true, "one step early");
  assert.equal(verifyTotp(RFC_SECRET, "050471", at + 2 * 30_000), false, "two steps is too far");
});

test("generated TOTP secrets are valid base32 and unique", () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const s = newTotpSecret();
    assert.match(s, /^[A-Z2-7]{32}$/);
    assert.equal(seen.has(s), false);
    seen.add(s);
  }
});

test("document encryption round-trips and is bound to its document id", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const plain = Buffer.from("DD-214 discharge papers, sensitive content");
  const enc = encryptDocument(plain, id);
  assert.notEqual(Buffer.compare(enc.ciphertext, plain), 0, "must not store plaintext");

  const row = {
    wrapped_dek: enc.wrappedDek, dek_iv: enc.dekIv, dek_tag: enc.dekTag,
    file_iv: enc.fileIv, file_tag: enc.fileTag,
  };
  assert.equal(decryptDocument(enc.ciphertext, row, id).toString(), plain.toString());

  // Wrong document id must fail the AAD check rather than return bytes.
  assert.throws(() => decryptDocument(enc.ciphertext, row, "22222222-2222-2222-2222-222222222222"));

  // Tampered ciphertext must fail the auth tag.
  const tampered = Buffer.from(enc.ciphertext);
  tampered[0] ^= 0xff;
  assert.throws(() => decryptDocument(tampered, row, id));
});

test("timing-safe compare handles unequal lengths", () => {
  assert.equal(timingSafeEqualStr("abc", "abc"), true);
  assert.equal(timingSafeEqualStr("abc", "abcd"), false);
  assert.equal(timingSafeEqualStr("", ""), true);
});
