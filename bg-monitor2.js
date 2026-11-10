const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const cheerio = require("cheerio");
const { JST_OFFSET_MS, getJSTTime } = require("./common/time");
const { notify } = require("./common/notifier");
const { validateBgPages } = require("./common/bg-source");

const ROOT = __dirname;
const CASTS_FILE = path.join(ROOT, "bg-monitor2-casts.json");
const STATE_FILE = path.join(ROOT, "data", "bg-monitor2-last.json");
const ONE_SHOT_FILE = path.join(ROOT, "bg-monitor2-test-once.json");
const ONE_SHOT_STATE_FILE = path.join(ROOT, "data", "bg-monitor2-test-once-last.json");
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

function loadOneShotConfig(file = ONE_SHOT_FILE) {
  let config;
  try {
    config = JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`BG2一回限り設定を読み込めません: ${error.message}`);
  }
  const keys = ["id", "runDate", "targetDate", "cast"];
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).sort().join(",") !== keys.sort().join(",") ||
      typeof config.id !== "string" || !/^[a-z0-9-]{8,80}$/.test(config.id) ||
      !/^\d{4}\/\d{2}\/\d{2}$/.test(config.runDate) ||
      !/^\d{4}\/\d{2}\/\d{2}$/.test(config.targetDate) ||
      typeof config.cast !== "string" || !config.cast.trim()) {
    throw new Error("BG2一回限り設定の形式が不正です");
  }
  return { ...config, cast: config.cast.trim() };
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

async function runOneShotTest({ config, pages, runDateKey, epochMillis, castsFile, stateFile, notifyFn, logger }) {
  if (!config) return { status: "not-configured" };
  if (config.runDate.replaceAll("/", "-") !== runDateKey) {
    logger.log?.(`BG2 one-shot ignored: run date does not match (${runDateKey})`);
    return { status: "expired" };
  }
  const originalCasts = loadCasts(castsFile);
  if (!originalCasts.includes(config.cast)) throw new Error("一回限り対象がBG2キャスト設定にありません");
  const previous = await readState(stateFile);
  if (previous.id === config.id) return { status: "already-attempted" };
  if (!Array.isArray(pages) || pages.length !== 8) throw new Error("BGから8ページ分の認証済みHTMLが渡されていません");
  validateBgPages(pages);

  const [year, month, day] = config.targetDate.split("/").map(Number);
  const targetDate = new Date(Date.UTC(year, month - 1, day));
  if (formatDate(targetDate) !== config.targetDate) throw new Error("一回限り対象日の形式が不正です");
  const expectedTargetDate = targetDateAt(epochMillis);
  if (formatDate(targetDate) !== formatDate(expectedTargetDate)) throw new Error("一回限り対象日が本日の4日後ではありません");
  const targetUrl = scheduleUrl(targetDate);
  const page = pages.find(item => item && item.url === targetUrl && typeof item.html === "string");
  if (!page) throw new Error(`BG共有HTMLにテスト対象日ページがありません: ${targetUrl}`);

  // Test mode intentionally evaluates only the one explicitly configured cast.
  const entry = parseScheduleHtml(page.html, [config.cast]).get(config.cast);
  if (!entry) {
    logger.log?.(`BG2 one-shot waiting: ${config.cast} not scheduled on ${config.targetDate}`);
    return { status: "not-eligible", cast: config.cast, targetDate: config.targetDate };
  }
  if (!entry.shift) {
    logger.log?.(`BG2 one-shot waiting: ${config.cast} has no published shift`);
    return { status: "not-eligible", cast: config.cast, targetDate: config.targetDate };
  }
  if (entry.soldOut) {
    logger.log?.(`BG2 one-shot skipped: ${config.cast} is SOLD OUT`);
    return { status: "sold-out", cast: config.cast, targetDate: config.targetDate };
  }

  // Claim before the external call. A retry after an ambiguous LINE response
  // must not create a second test notification.
  const attempt = { id: config.id, status: "attempted", attemptedAt: getJSTTime(), targetDate: config.targetDate, cast: config.cast, shift: entry.shift };
  await writeState(stateFile, attempt);
  try {
    await notifyFn(buildMessage(targetDate, [{ name: config.cast, shift: entry.shift }]));
    const sentAt = getJSTTime();
    await writeState(stateFile, { ...attempt, status: "sent", sentAt });
    logger.log?.(`BG2 one-shot LINE accepted cast=${config.cast} shift=${entry.shift} target=${config.targetDate} sentAt=${sentAt}`);
    return { status: "sent", cast: config.cast, shift: entry.shift, targetDate: config.targetDate, sentAt };
  } catch (error) {
    await writeState(stateFile, { ...attempt, status: "failed", failedAt: getJSTTime(), error: error?.message || String(error) });
    logger.error?.(`BG2 one-shot LINE failed cast=${config.cast} target=${config.targetDate}: ${error?.message || error}`);
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

async function runBgMonitor2({ pages, now = Date.now(), castsFile = CASTS_FILE, stateFile = STATE_FILE, oneShotFile = ONE_SHOT_FILE, oneShotStateFile = ONE_SHOT_STATE_FILE, notifyFn = notify, logger = console } = {}) {
  const epochMillis = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(epochMillis)) throw new TypeError("now は有効な日時である必要があります");
  const runDate = jstDateAt(epochMillis);
  const runDateKey = jstDateKey(runDate);
  if (getJstMinute(epochMillis) < RUN_AFTER_MINUTE) return { status: "before-window", runDate: runDateKey };
  if (runningDate === runDateKey) return { status: "busy", runDate: runDateKey };
  runningDate = runDateKey;
  try {
    const oneShot = await runOneShotTest({
      config: loadOneShotConfig(oneShotFile), pages, runDateKey, epochMillis, castsFile,
      stateFile: oneShotStateFile, notifyFn, logger
    });
    if (oneShot.status !== "not-configured") return oneShot;

    const state = await readState(stateFile);
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
    await writeState(stateFile, nextState);
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
  loadOneShotConfig,
  containsExactCastName,
  isSoldOut,
  parseScheduleHtml,
  buildMessage,
  readState,
  runBgMonitor2
};
