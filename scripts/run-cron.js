const { createBgHttpTrace } = require("../common/bg-http-trace");

const ENDPOINTS = [
  "/run-pickup",
  "/run-bg",
  "/run-heaven",
  "/run-yuuri"
];

// At most three scheduled probes, one per 5-minute slot. Remove after diagnosis.
const PROBE_FROM = Date.parse("2026-11-08T02:45:00Z");
const PROBE_UNTIL = Date.parse("2026-11-08T03:00:00Z");
const PROBE_URL = "https://www.kobe-b1.com/schedule/2026/11/8";

async function probeBg() {
  const now = Date.now();
  if (process.env.RENDER_SERVICE_ID !== "crn-d98pqu4s728c73c45gvg" ||
      now < PROBE_FROM || now >= PROBE_UNTIL) return;

  const trace = createBgHttpTrace(PROBE_URL);
  const deadline = AbortSignal.timeout(8_000);
  try {
    const response = await trace.run(() => require("axios").get(PROBE_URL, {
      signal: deadline,
      maxRedirects: 0,
      maxContentLength: 2 * 1024 * 1024,
      validateStatus: () => true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 Chrome/120 Safari/537.36"
      }
    }));
    trace.finish(response.status === 200 ? "ok" : "http_error", undefined, response.status);
  } catch (error) {
    trace.finish(deadline.aborted ? "timeout" : "error", error, error.response?.status);
  }
}

const baseUrl = (
  process.env.MONITOR_BASE_URL ||
  "https://monitor-all.onrender.com"
).replace(/\/+$/, "");

const timeoutMs = Number(
  process.env.MONITOR_REQUEST_TIMEOUT_MS || 60_000
);

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error(
    `Invalid MONITOR_REQUEST_TIMEOUT_MS: ${process.env.MONITOR_REQUEST_TIMEOUT_MS}`
  );
  process.exit(1);
}

async function run() {
  const probe = probeBg().catch(() => console.error("BG probe failed to start"));
  let successes = 0;
  let failures = 0;

  for (const endpoint of ENDPOINTS) {
    const startedAt = Date.now();
    const url = `${baseUrl}${endpoint}`;

    console.log(`START ${endpoint}`);

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs)
      });

      // Read the full body before starting the next request, while keeping
      // response content out of the logs.
      await response.arrayBuffer();

      const elapsedMs = Date.now() - startedAt;

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
      }

      successes += 1;
      console.log(
        `SUCCESS ${endpoint} HTTP ${response.status} ${elapsedMs}ms`
      );
    } catch (error) {
      failures += 1;
      const elapsedMs = Date.now() - startedAt;
      const message = error?.name === "TimeoutError"
        ? `timeout after ${timeoutMs}ms`
        : error?.message || String(error);

      console.error(
        `FAIL ${endpoint} ${elapsedMs}ms: ${message}`
      );
    }
  }

  await probe;
  console.log(
    `SUMMARY successes=${successes} failures=${failures}`
  );

  if (failures > 0) {
    process.exitCode = 1;
  }
}

run().catch(error => {
  console.error("Cron runner failed:", error?.message || error);
  process.exitCode = 1;
});
