const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const cheerio = require("cheerio");
const { JST_OFFSET_MS, getJSTTime } = require("./common/time");
const { notify } = require("./common/notifier");
const { validateBgPages } = require("./common/bg-source");
const {
  getStateStore,
  readState: readStoredState,
  writeState: writeStoredState
} = require("./common/state-store");

const ROOT = __dirname;
const CASTS_FILE = path.join(ROOT, "bg-monitor2-casts.json");
const STATE_FILE = path.join(ROOT, "data", "bg-monitor2-last.json");
const TARGET_DAY_OFFSET = 4;
const RUN_AFTER_MINUTE = 16 * 60 + 30;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
let runningDate = null;

function jstDateAt(epochMillis) {
  const date = new Date(epochMillis + JST_OFFSET_MS);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDate(date) {
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
}

function targetDateAt(epochMillis = Date.now()) {
  return new Date(jstDateAt(epochMillis).getTime() + TARGET_DAY_OFFSET * 86_400_000);
}

function scheduleUrl(date) {
  return `https://www.kobe-b1.com/schedule/${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function loadCasts(file = CASTS_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`bg-monitor2-casts.json を読み込めません: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some(name => typeof name !== "string" || !name.trim())) {
    throw new Error("bg-monitor2-casts.json は空でないキャスト名のJSON配列にしてください");
  }
  const names = parsed.map(name => name.trim());
  if (new Set(names).size !== names.length) {
    throw new Error("bg-monitor2-casts.json に重複したキャスト名があります");
  }
  return names;
}

function normalizeText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/[\u2000-\u200f]/g, "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsExactCastName(text, name) {
  const pattern = new RegExp(`(?:^|[\\s　])${escapeRegExp(name)}(?:\\s*[（(]\\s*\\d{1,3}\\s*[）)])?(?=$|[\\s　]|\\d{1,2}:\\d{2})`);
  return pattern.test(text);
}

function isSoldOut($, $cell) {
  const marker = $cell.find(".realtime-icon").first();
  if (!marker.length) return false;
  const markup = marker.html() || "";
  if (/SOLD\s*OUT/i.test(normalizeText(marker.text()))) return true;
  let sold = false;
  marker.find("img").each((_, image) => {
    const $image = $(image);
    const alt = $image.attr("alt") || "";
    const urls = [$image.attr("src"), $image.attr("data-src"), $image.attr("srcset")].filter(Boolean).join(" ");
    if (/SOLD\s*OUT/i.test(alt) || /(?:^|[\/_-])sold(?:[-_]?out)?(?:[._/?#]|$)/i.test(urls)) sold = true;
  });
  return sold || /SOLD\s*OUT/i.test(markup);
}

function parseScheduleHtml(html, castNames) {
  const $ = cheerio.load(html);
  if (!$('title').text().includes("出勤情報") || !$('table').length) {
    throw new Error("出勤予定ページの構造を確認できません");
  }
  const cells = $('table').first().find("td").filter((_, td) => $(td).find(".txtbox").length > 0);
  if (!cells.length) throw new Error("出勤表のキャスト欄を確認できません");
  if (!$('table').first().find(".shifttime").length) throw new Error("出勤時間の表示構造を確認できません");

  const found = new Map();
  cells.each((_, td) => {
    const $cell = $(td);
    const cardText = normalizeText($cell.find(".txtbox").first().text());
    const matches = castNames.filter(name => containsExactCastName(cardText, name));
    if (!matches.length) return;
    if (matches.length > 1) throw new Error("1つの出勤欄に複数の監視対象名が一致しました");
    const name = matches[0];
    const shift = normalizeText($cell.find(".shifttime").first().text());
    if (found.has(name)) throw new Error(`出勤表で「${name}」が重複しており判定できません`);
    found.set(name, { name, shift, soldOut: isSoldOut($, $cell) });
  });
  return found;
}

function buildMessage(targetDate, entries) {
  const date = `${formatDate(targetDate)}（${WEEKDAYS[targetDate.getUTCDay()]}）`;
  const body = entries.map(({ name, shift }) => `対象キャスト：${name}\n出勤時間：${shift}`).join("\n\n");
  return `★ビギナーズ予約情報★\n\n対象日付：${date}\n${body}`;
}

async function readState(file = STATE_FILE) {
  try {
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("state must be an object");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`bg-monitor2 状態ファイルを読み込めません: ${error.message}`);
  }
}

async function writeState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function getJstMinute(epochMillis) {
  const jst = new Date(epochMillis + JST_OFFSET_MS);
  return jst.getUTCHours() * 60 + jst.getUTCMinutes();
}

function jstDateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

async function runBgMonitor2({ pages, now = Date.now(), castsFile = CASTS_FILE, stateFile = STATE_FILE, notifyFn = notify, logger = console } = {}) {
  const epochMillis = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(epochMillis)) throw new TypeError("now は有効な日時である必要があります");
  const runDate = jstDateAt(epochMillis);
  const runDateKey = jstDateKey(runDate);
  if (runningDate === runDateKey) return { status: "busy", runDate: runDateKey };
  runningDate = runDateKey;
  try {
    const stored = await readStoredState("bg-monitor2-last.json", stateFile);
    const state = stored.initialized ? stored.data : {};
    const isR2 = getStateStore().mode === "r2";
    const stateInitialized = stored.initialized || !isR2;
    if (stored.initialized && (!state || typeof state !== "object" || Array.isArray(state) ||
        typeof state.checkedAt !== "string" || typeof state.targetDate !== "string" ||
        !Array.isArray(state.notificationCasts) || !state.notificationCasts.every(item => item && typeof item.name === "string" && typeof item.shift === "string") || typeof state.lastNotifiedAt !== "string" ||
        (state.checkedJstDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(state.checkedJstDate)))) {
      const error = new Error("BG2 state schema is invalid");
      error.code = "STATE_STORE_CORRUPT";
      error.stateStoreError = true;
      throw error;
    }
    const beforeWindow = getJstMinute(epochMillis) < RUN_AFTER_MINUTE;

    // Establish a silent comparison baseline before today's notification
    // window when the first post-migration cron already has validated pages.
    // Do not mark the daily check complete; the scheduled 16:30 run still
    // sends its normal combined notification.
    if (beforeWindow) {
      if (!stateInitialized && isR2 && Array.isArray(pages) && pages.length === 8) {
        validateBgPages(pages);
        const targetDate = targetDateAt(epochMillis);
        const targetUrl = scheduleUrl(targetDate);
        const page = pages.find(item => item && item.url === targetUrl && typeof item.html === "string");
        if (!page) throw new Error(`BG共有HTMLに対象日ページがありません: ${targetUrl}`);
        const names = loadCasts(castsFile);
        const schedule = parseScheduleHtml(page.html, names);
        const eligible = names.flatMap(name => {
          const entry = schedule.get(name);
          if (!entry || !entry.shift || entry.soldOut) return [];
          return [{ name, shift: entry.shift }];
        });
        await writeStoredState("bg-monitor2-last.json", stateFile, {
          checkedAt: "-",
          targetDate: formatDate(targetDate),
          notificationCasts: [],
          lastNotifiedAt: "-"
        }, { initialize: true });
        logger.log?.(`BG2 R2 baseline saved before notification window target=${formatDate(targetDate)} eligible=${eligible.length}; no LINE sent`);
      }
      return { status: "before-window", runDate: runDateKey };
    }
    if (state.checkedJstDate === runDateKey) return { status: "already-checked", runDate: runDateKey };

    if (!Array.isArray(pages) || pages.length !== 8) throw new Error("BGから8ページ分の認証済みHTMLが渡されていません");
    validateBgPages(pages);
    const targetDate = targetDateAt(epochMillis);
    const targetUrl = scheduleUrl(targetDate);
    const page = pages.find(item => item && item.url === targetUrl && typeof item.html === "string");
    if (!page) throw new Error(`BG共有HTMLに対象日ページがありません: ${targetUrl}`);

    const names = loadCasts(castsFile);
    const schedule = parseScheduleHtml(page.html, names);
    const eligible = names.flatMap(name => {
      const entry = schedule.get(name);
      if (!entry || !entry.shift || entry.soldOut) return [];
      return [{ name, shift: entry.shift }];
    });
    const checkedAt = getJSTTime();
    let notifiedAt = state.lastNotifiedAt || "-";
    if (!stateInitialized) {
      const nextState = {
        checkedJstDate: runDateKey,
        checkedAt,
        targetDate: formatDate(targetDate),
        notificationCasts: [],
        lastNotifiedAt: state.lastNotifiedAt || "-"
      };
      await writeStoredState("bg-monitor2-last.json", stateFile, nextState, { initialize: true });
      logger.log?.(`BG2 R2 first baseline ${runDateKey}; no LINE sent`);
      return { status: "initialized", runDate: runDateKey, targetDate: formatDate(targetDate), entries: eligible, checkedAt, notifiedAt: "-" };
    }
    if (eligible.length) {
      await notifyFn(buildMessage(targetDate, eligible));
      notifiedAt = getJSTTime();
    }
    const nextState = {
      checkedJstDate: runDateKey,
      checkedAt,
      targetDate: formatDate(targetDate),
      notificationCasts: eligible,
      lastNotifiedAt: eligible.length ? notifiedAt : state.lastNotifiedAt || "-"
    };
    await writeStoredState("bg-monitor2-last.json", stateFile, nextState);
    logger.log?.(`BG2 checked ${runDateKey} target=${formatDate(targetDate)} eligible=${eligible.length} notified=${eligible.length > 0}`);
    return { status: "checked", runDate: runDateKey, targetDate: formatDate(targetDate), entries: eligible, checkedAt, notifiedAt: eligible.length ? notifiedAt : "-" };
  } finally {
    runningDate = null;
  }
}

module.exports = {
  TARGET_DAY_OFFSET,
  targetDateAt,
  scheduleUrl,
  loadCasts,
  containsExactCastName,
  isSoldOut,
  parseScheduleHtml,
  buildMessage,
  readState,
  runBgMonitor2
};
