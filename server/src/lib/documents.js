/* Storing and reading documents.
 *
 * The row id is generated up front so the storage key, the encryption AAD and
 * the row all agree before anything is written — no placeholder key that two
 * concurrent uploads could collide on, and no window where a row points at
 * bytes that are not there yet. */
import crypto from "node:crypto";
import { one } from "../db.js";
import { encryptDocument, decryptDocument } from "./crypto.js";
import { storage, newStorageKey } from "./storage.js";

export async function storeDocument({
  applicationId, direction, kind, filename, mime, bytes,
  uploadedByStaffId = null, requestId = null,
}) {
  const id = crypto.randomUUID();
  const key = newStorageKey(id);
  const enc = encryptDocument(bytes, id);
  const sha = crypto.createHash("sha256").update(bytes).digest();

  /* Bytes first: an orphaned object costs a few kilobytes, whereas a row
     pointing at nothing is a broken download for staff. */
  await storage.put(key, enc.ciphertext);

  try {
    return await one(
      `INSERT INTO documents (id, application_id, direction, kind, filename, mime_type,
                              size_bytes, sha256, storage_key, wrapped_dek, dek_iv, dek_tag,
                              file_iv, file_tag, scan_status, uploaded_by_staff_id, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'skipped',$15,$16)
       RETURNING id, filename, mime_type, size_bytes, direction, kind, created_at`,
      [id, applicationId, direction, kind, filename, mime, bytes.length, sha, key,
       enc.wrappedDek, enc.dekIv, enc.dekTag, enc.fileIv, enc.fileTag, uploadedByStaffId, requestId]
    );
  } catch (err) {
    await storage.del(key).catch(() => {});
    throw err;
  }
}

/* Metadata only. Callers authorise against this BEFORE any bytes are read, so
   a document is never fetched or decrypted for someone not entitled to it. */
export async function loadDocumentMeta(documentId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(documentId))) return null;
  const doc = await one(
    `SELECT id, application_id, filename, mime_type, size_bytes, storage_key,
            wrapped_dek, dek_iv, dek_tag, file_iv, file_tag, scan_status, shredded_at
       FROM documents WHERE id = $1`,
    [documentId]
  );
  if (!doc || doc.shredded_at) return null;
  /* A file that has not cleared scanning is never handed back. With no scanner
     configured the upload allowlist is the control, and rows are marked
     'skipped' rather than pretending a scan happened. */
  if (doc.scan_status === "infected" || doc.scan_status === "pending") return null;
  return doc;
}

/* Resolves null when the bytes are gone or fail authentication, so a caller
   returns "not found" rather than a 500 that leaks that the row exists. */
export async function readDocumentBytes(doc) {
  try {
    const ciphertext = await storage.get(doc.storage_key);
    return decryptDocument(ciphertext, doc, doc.id);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "document read failed", documentId: doc.id, err: err.message }));
    return null;
  }
}

/* Destroying the wrapped key makes the stored bytes unreadable for good, so a
   DD-214 can be shredded once it has served the verification it was needed
   for, while the record that verification happened survives. */
export async function shredDocument(documentId) {
  const doc = await one("SELECT storage_key FROM documents WHERE id = $1 AND shredded_at IS NULL", [documentId]);
  if (!doc) return false;
  await storage.del(doc.storage_key).catch(() => {});
  await one(
    `UPDATE documents
        SET shredded_at = now(),
            wrapped_dek = '\\x00'::bytea, dek_iv = '\\x00'::bytea, dek_tag = '\\x00'::bytea
      WHERE id = $1 RETURNING id`,
    [documentId]
  );
  return true;
}

/* Never echo the stored MIME type back. One fixed set of headers guarantees
   no uploaded bytes can render as active content in a staff browser, whatever
   got past validation on the way in. */
export function sendDocument(res, doc, bytes) {
  const safeName = String(doc.filename).replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "document";
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("Content-Length", bytes.length);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "no-store, private");
  res.end(bytes);
}
