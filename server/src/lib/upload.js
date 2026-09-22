/* Multipart parsing with a hard size cap and magic-byte type checking.
 *
 * The extension and the browser-declared Content-Type are both attacker
 * controlled. What the bytes actually are is not, so that is what decides. */
import Busboy from "busboy";
import config from "../config.js";

/* Deliberately short. Legacy .doc is an OLE container indistinguishable from
 * .xls and is a macro carrier; SVG and HTML are executable content and must
 * never be near a system that serves files back to staff. */
const SIGNATURES = [
  { mime: "application/pdf", ext: ["pdf"], test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", ext: ["png"], test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: ["jpg", "jpeg"], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/tiff", ext: ["tif", "tiff"], test: (b) => { const m = b.subarray(0, 4); return m.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || m.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])); } },
  { mime: "image/heic", ext: ["heic", "heif"], test: (b) => b.length > 12 && b.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|hevc|mif1|heim|heis)$/.test(b.subarray(8, 12).toString("latin1")) },
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: ["docx"],
    /* A docx is a zip. Accepting it means accepting a container, so it is
       checked for the Word parts and rejected if it carries macros. */
    test: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && looksLikeDocx(b),
  },
];

function looksLikeDocx(buf) {
  const text = buf.toString("latin1");
  if (text.includes("vbaProject.bin")) return false;
  return text.includes("[Content_Types].xml") || text.includes("word/");
}

export function detectType(buf, filename) {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  for (const sig of SIGNATURES) {
    if (sig.test(buf)) {
      /* The bytes decide, but a mismatched extension is still a red flag
         worth refusing rather than silently renaming. */
      if (!sig.ext.includes(ext)) {
        return { ok: false, reason: `The file looks like ${sig.mime} but is named .${ext}.` };
      }
      return { ok: true, mime: sig.mime };
    }
  }
  return { ok: false, reason: "That file type isn't accepted. Please send a PDF, DOCX, JPG, PNG, TIFF or HEIC." };
}

export const ACCEPTED_EXTENSIONS = ".pdf,.docx,.jpg,.jpeg,.png,.tif,.tiff,.heic";

/* Collects fields and at most one file into memory. Files are capped well
   under Railway's five-minute edge body timeout, so a weak connection gets a
   real error rather than an opaque gateway failure. */
export function parseMultipart(req, { maxBytes = config.uploads.maxBytes, maxFiles = 1 } = {}) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { fileSize: maxBytes, files: maxFiles, fields: 200, fieldSize: 1024 * 1024 },
      });
    } catch (err) {
      return reject(Object.assign(new Error("not multipart"), { status: 400, code: "not_multipart" }));
    }

    const fields = {};
    const files = [];
    let tooBig = false;
    let settled = false;

    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    bb.on("field", (name, value) => {
      if (Object.prototype.hasOwnProperty.call(fields, name)) {
        fields[name] = [].concat(fields[name], value);
      } else {
        fields[name] = value;
      }
    });

    bb.on("file", (name, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on("data", (c) => { chunks.push(c); size += c.length; });
      stream.on("limit", () => { tooBig = true; stream.resume(); });
      stream.on("end", () => {
        if (tooBig || !size) return;
        files.push({ field: name, filename: info.filename, declaredMime: info.mimeType, bytes: Buffer.concat(chunks), size });
      });
      stream.on("error", fail);
    });

    bb.on("error", fail);
    bb.on("close", () => {
      if (settled) return;
      settled = true;
      if (tooBig) {
        return reject(Object.assign(
          new Error(`File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`),
          { status: 413, code: "file_too_large" }
        ));
      }
      resolve({ fields, files });
    });

    req.pipe(bb);
  });
}
