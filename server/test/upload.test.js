import { test } from "node:test";
import assert from "node:assert/strict";
import { detectType } from "../src/lib/upload.js";

const PDF  = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64)]);
const PNG  = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(64)]);
const DOCX = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), Buffer.from("....[Content_Types].xml....word/document.xml")]);
const MACRO_DOCX = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), Buffer.from("..[Content_Types].xml..word/vbaProject.bin")]);
const SVG  = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>");
const EXE  = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);
const DOC  = Buffer.concat([Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]), Buffer.alloc(64)]);

test("accepts the document types a veteran would actually send", () => {
  assert.deepEqual(detectType(PDF,  "dd214.pdf"),   { ok: true, mime: "application/pdf" });
  assert.deepEqual(detectType(PNG,  "scan.png"),    { ok: true, mime: "image/png" });
  assert.deepEqual(detectType(JPEG, "photo.jpg"),   { ok: true, mime: "image/jpeg" });
  assert.deepEqual(detectType(JPEG, "photo.jpeg"),  { ok: true, mime: "image/jpeg" });
  assert.equal(detectType(DOCX, "resume.docx").ok, true);
});

test("rejects active content outright", () => {
  for (const [buf, name] of [[SVG, "logo.svg"], [HTML, "page.html"], [EXE, "setup.exe"], [DOC, "resume.doc"]]) {
    const r = detectType(buf, name);
    assert.equal(r.ok, false, `${name} must be rejected`);
    assert.match(r.reason, /isn't accepted/);
  }
});

test("rejects a macro-bearing docx", () => {
  assert.equal(detectType(MACRO_DOCX, "resume.docx").ok, false);
});

test("rejects a file whose bytes disagree with its extension", () => {
  // The classic: an executable or script renamed to something innocuous.
  const r = detectType(PDF, "resume.docx");
  assert.equal(r.ok, false);
  assert.match(r.reason, /looks like application\/pdf but is named \.docx/);

  const r2 = detectType(PNG, "dd214.pdf");
  assert.equal(r2.ok, false);
});

test("rejects an SVG even when named .png (bytes decide, not the name)", () => {
  const r = detectType(SVG, "innocent.png");
  assert.equal(r.ok, false);
});

test("handles empty and tiny buffers without throwing", () => {
  assert.equal(detectType(Buffer.alloc(0), "x.pdf").ok, false);
  assert.equal(detectType(Buffer.from([0x25]), "x.pdf").ok, false);
});
