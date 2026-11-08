const { fetchBgPages } = require("../common/bg-source");
const { sendBgPages } = require("../common/bg-ingest");

const ENDPOINTS = [
  "/run-pickup",
  "/run-bg",
  "/run-heaven",
  "/run-yuuri"
];

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
  let successes = 0;
  let failures = 0;

  for (const endpoint of ENDPOINTS) {
    const startedAt = Date.now();
    const url = `${baseUrl}${endpoint}`;

    console.log(`START ${endpoint}`);

    try {
      const signal = AbortSignal.timeout(timeoutMs);
      let response;
      const useIngest = endpoint === "/run-bg" && (
        process.env.RENDER_SERVICE_TYPE === "cron" || process.env.BG_INGEST_SECRET
      );
      if (useIngest) {
        if (!process.env.BG_INGEST_SECRET) throw new Error("BG ingest secret is missing");
        const pages = await fetchBgPages(signal, { checkSchedule: true });
        console.log("BG CRON fetched pages=8; sending to Web Service");
        response = await sendBgPages(baseUrl, pages, signal);
        console.log(`BG CRON transfer HTTP ${response.status}`);
      } else {
        response = await fetch(url, { signal });
        // Read the body before starting the next monitor.
        await response.arrayBuffer();
      }

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
