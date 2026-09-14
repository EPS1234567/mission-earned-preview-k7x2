/* Mission Earned volunteer portal.
 *
 * One service, one origin: the public form posts here cross-origin without
 * credentials, and both authenticated surfaces (/staff and /p) are served from
 * here so their session cookies are first-party. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import config from "./config.js";
import { pool } from "./db.js";
import { securityHeaders, requireHttps } from "./lib/security.js";
import { storage } from "./lib/storage.js";
import { publicRouter } from "./routes/public.js";
import { staffRouter } from "./routes/staff.js";
import { caseRouter } from "./routes/case.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/* Railway terminates TLS at the edge; without this the client IP is the proxy
   and every rate limit becomes global. */
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    /* Never log the query string: magic-link tokens ride in it. */
    console.log(JSON.stringify({
      level: "info", method: req.method, path: req.path,
      status: res.statusCode, ms: Date.now() - started,
    }));
  });
  next();
});

app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(requireHttps);
app.use(securityHeaders);

/* The public submission endpoint takes multipart and is parsed by the route
   itself, so no body parser is mounted ahead of it. */
app.use("/api/v1", publicRouter);
app.use("/api/staff", express.json({ limit: "512kb" }), staffRouter);
app.use("/p", caseRouter);

app.use("/assets", express.static(path.join(here, "..", "public", "assets"), {
  maxAge: "1h", index: false, redirect: false, dotfiles: "ignore",
}));
app.use("/staff", express.static(path.join(here, "..", "public", "staff"), {
  index: "index.html", redirect: false, dotfiles: "ignore",
}));
/* Every /staff/* path is the same shell; routing happens in the page. */
app.get(/^\/staff(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(here, "..", "public", "staff", "index.html"));
});

app.get("/", (req, res) => res.redirect(302, "/staff/"));

app.use((req, res) => res.status(404).json({ error: "not_found" }));

app.use((err, req, res, _next) => {
  console.error(JSON.stringify({ level: "error", msg: "unhandled", path: req.path, err: err.message, stack: err.stack }));
  if (res.headersSent) return;
  /* Never hand an internal message to a browser. */
  res.status(500).json({ error: "server_error" });
});

async function start() {
  await storage.check();
  const { migrate } = await import("./migrate.js");
  if (process.env.MIGRATE_ON_BOOT === "true") await migrate();
  app.listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ level: "info", msg: "listening", port: config.port, env: config.env, origin: config.appOrigin }));
  });
}

if (process.env.NODE_ENV !== "test") {
  start().catch((err) => {
    console.error(JSON.stringify({ level: "fatal", msg: "startup failed", err: err.message }));
    process.exit(1);
  });
}

export { app };
