const axios = require("axios");
const { createBgHttpTrace } = require("./bg-http-trace");
const { getJSTDate } = require("./time");

const PAGE_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT = 12_000;
const FETCH_CONCURRENCY = 3;

function buildBgUrls() {
  const jst = getJSTDate();
  const today = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return Array.from({ length: 8 }, (_, offset) => {
    const date = new Date(today + offset * 86_400_000);
    return `https://www.kobe-b1.com/schedule/${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
  });
}

function invalidPages() {
  return Object.assign(new Error("BGの8日分の取得結果が不完全です"), { code: "BG_UPSTREAM" });
}

function looksLikeSchedule(html) {
  return /<title\b[^>]*>[^<]*出勤情報/i.test(html) && /<table\b/i.test(html);
}

function validateBgPages(pages) {
  const urls = buildBgUrls();
  if (!Array.isArray(pages) || pages.length !== urls.length ||
      !pages.every((page, i) => page && Object.keys(page).length === 2 &&
        page.url === urls[i] && typeof page.html === "string" &&
        page.html.length > 0 && Buffer.byteLength(page.html) <= PAGE_LIMIT)) {
    throw invalidPages();
  }
}

async function fetchBgPages(signal, { checkSchedule = false } = {}) {
  const urls = buildBgUrls();
  const results = new Array(urls.length);
  let next = 0;

  async function worker() {
    while (next < urls.length && !signal.aborted) {
      const index = next++;
      const url = urls[index];
      const trace = createBgHttpTrace(url);
      const deadline = AbortSignal.timeout(REQUEST_TIMEOUT);
      try {
        const response = await axios.get(url, {
          signal: AbortSignal.any([signal, deadline]),
          timeout: REQUEST_TIMEOUT,
          maxRedirects: 0,
          maxContentLength: PAGE_LIMIT,
          responseType: "text",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 Chrome/120 Safari/537.36"
          }
        });
        if (response.status !== 200 || typeof response.data !== "string" ||
            !response.data.trim() || (checkSchedule && !looksLikeSchedule(response.data))) {
          throw Object.assign(invalidPages(), { status: response.status });
        }
        results[index] = { url, html: response.data };
        trace.finish("ok", undefined, response.status);
      } catch (error) {
        trace.finish(signal.aborted ? signal.reason.name
          : deadline.aborted || ["ECONNABORTED", "ETIMEDOUT"].includes(error.code)
            ? "timeout" : "error", error, error.response?.status ?? error.status);
      }
    }
  }

  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  signal.throwIfAborted();
  const failed = urls.length - results.filter(Boolean).length;
  if (failed) {
    throw Object.assign(
      new Error(`${failed}/${urls.length}ページの取得に失敗したため、通知・保存を中止します`),
      { code: "BG_UPSTREAM" }
    );
  }
  return results;
}

module.exports = { buildBgUrls, fetchBgPages, validateBgPages };
