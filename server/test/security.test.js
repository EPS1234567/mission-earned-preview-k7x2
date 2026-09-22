import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../src/lib/security.js";

/* A request as Express presents it under app.set("trust proxy", 1): req.ip is
   the entry the trusted edge appended, whatever the client put in front. */
function req(ip, remoteAddress = "10.0.0.2") {
  return { ip, socket: { remoteAddress }, get: () => undefined };
}

test("clientIp takes the proxy-derived address, not a client-written header", () => {
  assert.equal(clientIp(req("203.0.113.9")), "203.0.113.9");
  assert.equal(clientIp(req("::ffff:198.51.100.7")), "::ffff:198.51.100.7");
  assert.equal(clientIp(req("2001:db8::1")), "2001:db8::1");
});

test("clientIp falls back to the socket when Express has no address", () => {
  assert.equal(clientIp(req(undefined, "127.0.0.1")), "127.0.0.1");
  assert.equal(clientIp(req("", "10.0.0.2")), "10.0.0.2");
});

test("clientIp returns null for anything that is not an address", () => {
  assert.equal(clientIp(req("unknown")), null);
  assert.equal(clientIp(req("attacker, 203.0.113.9")), null);
  assert.equal(clientIp({ ip: undefined, socket: undefined, get: () => undefined }), null);
});
