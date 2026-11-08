const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { gzipSync, gunzipSync } = require("node:zlib");
const { validateBgPages } = require("./bg-source");

const ROOT = "/bg-ingest";
const BODY_LIMIT = 10 * 1024 * 1024;
const WIRE_LIMIT = 512 * 1024;
const CONTENT_TYPE = "application/gzip";
const TOKEN_TTL_MS = 90_000;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const MAC_FORMAT = /^[a-f0-9]{64}$/;

function equal(a, b) {
  return typeof a === "string" && typeof b === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function signature(secret, token, body) {
  return createHmac("sha256", secret)
    .update(`bg-ingest/v1\n${token}\n`)
    .update(body)
    .digest("hex");
}

function installBgIngest(app, monitor) {
  const express = require("express");
  const raw = express.raw({ type: CONTENT_TYPE, inflate: false, limit: WIRE_LIMIT });
  const secret = process.env.BG_INGEST_SECRET;
  const tokens = new Map();

  app.post(ROOT + "/challenge", (req, res) => {
    if (!TOKEN_FORMAT.test(secret ?? "")) return res.sendStatus(503);
    if (!equal(req.get("Authorization"), `Bearer ${secret}`)) return res.sendStatus(401);
    const now = Date.now();
    for (const [token, expires] of tokens) {
      if (expires <= now) tokens.delete(token);
    }
    if (tokens.size >= 4) return res.sendStatus(429);
    const token = randomBytes(32).toString("base64url");
    tokens.set(token, now + TOKEN_TTL_MS);
    res.set("Cache-Control", "no-store").json({ token });
  });

  app.post(ROOT, (req, res, next) => {
    if (!TOKEN_FORMAT.test(secret ?? "")) return res.sendStatus(503);
    const token = req.get("X-BG-Token");
    const mac = req.get("X-BG-Signature");
    // Reject callers without a live challenge before reading the body.
    if (!TOKEN_FORMAT.test(token ?? "") || !MAC_FORMAT.test(mac ?? "") ||
        !(tokens.get(token) > Date.now())) return res.sendStatus(401);
    if (!req.is(CONTENT_TYPE)) return res.sendStatus(415);
    const length = Number(req.get("Content-Length"));
    if (!Number.isSafeInteger(length) || length < 1) return res.sendStatus(411);
    if (length > WIRE_LIMIT) return res.sendStatus(413);
    raw(req, res, error => {
      if (!error) return next();
      if (!res.destroyed) res.sendStatus([413, 415].includes(error.status) ? error.status : 400);
    });
  }, async (req, res) => {
    const token = req.get("X-BG-Token");
    if (!Buffer.isBuffer(req.body) || !(tokens.get(token) > Date.now()) ||
        !equal(req.get("X-BG-Signature"), signature(secret, token, req.body))) {
      return res.sendStatus(401);
    }
    tokens.delete(token);

    let pages;
    try {
      const decoded = gunzipSync(req.body, { maxOutputLength: BODY_LIMIT });
      pages = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
      validateBgPages(pages);
    } catch (error) {
      return res.sendStatus(error.code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400);
    }

    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    console.log("BG INGEST received pages=8");
    try {
      await monitor({ signal: controller.signal, pages });
      console.log("BG INGEST OK pages=8");
      if (!res.destroyed) res.send("bg-monitor done");
    } catch (error) {
      if (res.destroyed) return;
      const status = { BG_BUSY: 409, BG_UPSTREAM: 502, BG_DEADLINE: 504 }[error.code] || 500;
      console.error(`BG INGEST failed HTTP ${status}`);
      res.sendStatus(status);
    }
  });
}

async function sendBgPages(baseUrl, pages, signal) {
  const secret = process.env.BG_INGEST_SECRET;
  if (!TOKEN_FORMAT.test(secret ?? "")) throw new Error("BG ingest secret is missing or invalid");
  const target = new URL(ROOT, baseUrl);
  if (target.protocol !== "https:" || target.username || target.password) {
    throw new Error("BG ingest requires HTTPS");
  }
  validateBgPages(pages);
  const json = Buffer.from(JSON.stringify(pages));
  if (json.length > BODY_LIMIT) throw new Error("BG payload exceeds size limit");
  const body = gzipSync(json);
  if (body.length > WIRE_LIMIT) throw new Error("BG compressed payload exceeds size limit");
  console.log(`BG CRON payload bytes=${body.length} rawBytes=${json.length}`);
  const challenge = await fetch(target.href + "/challenge", {
    method: "POST",
    signal,
    redirect: "error",
    headers: { Authorization: `Bearer ${secret}` }
  });
  if (challenge.status !== 200) {
    await challenge.body?.cancel();
    throw new Error(`BG challenge HTTP ${challenge.status}`);
  }
  const { token } = await challenge.json();
  if (!TOKEN_FORMAT.test(token ?? "")) throw new Error("Invalid BG challenge");

  const response = await fetch(target, {
    method: "POST",
    signal,
    redirect: "error",
    body,
    headers: {
      "Content-Type": CONTENT_TYPE,
      "X-BG-Token": token,
      "X-BG-Signature": signature(secret, token, body)
    }
  });
  await response.arrayBuffer();
  return response;
}

module.exports = { installBgIngest, sendBgPages };
