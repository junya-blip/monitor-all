const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createHmac, randomBytes } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const express = require("express");
const { test } = require("node:test");
const {
  targetDateAt,
  scheduleUrl,
  loadCasts,
  parseScheduleHtml,
  buildMessage,
  loadOneShotConfig,
  runBgMonitor2
} = require("../bg-monitor2");
const { buildBgUrls } = require("../common/bg-source");
const { JST_OFFSET_MS } = require("../common/time");
const { installBgIngest } = require("../common/bg-ingest");

function runBg2(options = {}) {
  return runBgMonitor2({ oneShotFile: path.join(os.tmpdir(), `bg-monitor2-no-test-${process.pid}.json`), ...options });
}

function epochJst(year, month, day, hour = 0, minute = 0) {
  return Date.UTC(year, month - 1, day, hour - 9, minute);
}

function pageHtml(cards = "") {
  return `<title>出勤情報 | test</title><table><tr>${cards}</tr></table>`;
}

function card(name, time, { soldAlt = false, soldImage = false, literalSold = false } = {}) {
  const marker = literalSold
    ? `<div class="realtime-icon"> SOLD OUT </div>`
    : `<div class="realtime-icon">${soldAlt || soldImage ? `<img alt="${soldAlt ? "SOLD OUT" : ""}" src="/common/img/${soldImage ? "realtime-sold.png" : "realtime.png"}">` : ""}</div>`;
  return `<td><div class="txtbox"><div>${name}</div>${marker}<span class="shifttime">${time}</span></div></td>`;
}

function pagesFor(todayHtml) {
  const urls = buildBgUrls();
  const nowJst = new Date(Date.now() + JST_OFFSET_MS);
  const date = new Date(Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate() + 4));
  const targetUrl = scheduleUrl(date);
  return urls.map(url => ({ url, html: url === targetUrl ? todayHtml : pageHtml(card("その他", "12:00～20:00")) }));
}

async function tempFiles(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-monitor2-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "data"));
  const castsFile = path.join(dir, "casts.json");
  const stateFile = path.join(dir, "data", "last.json");
  return { dir, castsFile, stateFile };
}

test("JST target date adds four calendar days across month, year, leap year", () => {
  assert.equal(scheduleUrl(targetDateAt(epochJst(2026, 11, 10))), "https://www.kobe-b1.com/schedule/2026/11/14");
  assert.equal(scheduleUrl(targetDateAt(epochJst(2026, 1, 30))), "https://www.kobe-b1.com/schedule/2026/2/3");
  assert.equal(scheduleUrl(targetDateAt(epochJst(2026, 12, 29))), "https://www.kobe-b1.com/schedule/2027/1/2");
  assert.equal(scheduleUrl(targetDateAt(epochJst(2024, 2, 27))), "https://www.kobe-b1.com/schedule/2024/3/2");
});

test("schedule parser scopes sold-out markers to exact cast cards and excludes no-shift/other casts", () => {
  const casts = ["リンス", "シャンプー", "しずく", "ゆうひ", "アテナ", "さくらんぼ", "ゆいな", "るのあ"];
  const html = pageHtml([
    card("リンス(22)", "10:00～20:00", { soldAlt: true }),
    card("シャンプー(20)", "12:00～20:00", { soldImage: true }),
    card("しずく(21)", "14:00～23:50", { literalSold: true }),
    card("ゆうひ(23)", "10:00～19:00"),
    card("ゆいな", ""),
    card("リンスコ(20)", "09:00～18:00"),
    card("対象外(20)", "09:00～18:00")
  ].join(""));
  const result = parseScheduleHtml(html, casts);
  assert.deepEqual([...result.values()], [
    { name: "リンス", shift: "10:00～20:00", soldOut: true },
    { name: "シャンプー", shift: "12:00～20:00", soldOut: true },
    { name: "しずく", shift: "14:00～23:50", soldOut: true },
    { name: "ゆうひ", shift: "10:00～19:00", soldOut: false },
    { name: "ゆいな", shift: "", soldOut: false }
  ]);
});

test("message is one notification with configured order and one target date", () => {
  const target = new Date(Date.UTC(2026, 10, 14));
  const text = buildMessage(target, [
    { name: "リンス", shift: "10:00～20:00" },
    { name: "シャンプー", shift: "12:00～20:00" }
  ]);
  assert.equal(text, "★ビギナーズ予約情報★\n\n対象日付：2026/11/14（土）\n対象キャスト：リンス\n出勤時間：10:00～20:00\n\n対象キャスト：シャンプー\n出勤時間：12:00～20:00");
});

test("config is reread, preserves order, and rejects malformed or duplicate names", async t => {
  const { castsFile } = await tempFiles(t);
  await fs.writeFile(castsFile, JSON.stringify(["ゆうひ", "リンス"]));
  assert.deepEqual(loadCasts(castsFile), ["ゆうひ", "リンス"]);
  await fs.writeFile(castsFile, JSON.stringify(["ゆうひ", "ゆうひ"]));
  assert.throws(() => loadCasts(castsFile), /重複/);
  await fs.writeFile(castsFile, "{}");
  assert.throws(() => loadCasts(castsFile), /JSON配列/);
});

test("before 16:30 does not check; after 16:30 checks once including zero matches", async t => {
  const { castsFile, stateFile } = await tempFiles(t);
  await fs.writeFile(castsFile, JSON.stringify(["リンス"]));
  const pages = pagesFor(pageHtml(card("リンス(22)", "10:00～20:00", { soldAlt: true })));
  const base = new Date(Date.now() + JST_OFFSET_MS);
  const before = epochJst(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 16, 29);
  const due = before + 60_000;
  let calls = 0;
  assert.equal((await runBg2({ pages, now: before, castsFile, stateFile, notifyFn: async () => { calls++; } })).status, "before-window");
  assert.equal(calls, 0);
  const first = await runBg2({ pages, now: due, castsFile, stateFile, notifyFn: async () => { calls++; } });
  assert.equal(first.status, "checked");
  assert.deepEqual(first.entries, []);
  assert.equal(calls, 0);
  assert.equal((await runBg2({ pages, now: due + 300_000, castsFile, stateFile, notifyFn: async () => { calls++; } })).status, "already-checked");
  assert.equal(calls, 0);
  assert.ok((await fs.readFile(stateFile, "utf8")).includes('"checkedJstDate"'));
});

test("missing or failed shared-page fetch does not mark the day complete", async t => {
  const { castsFile, stateFile } = await tempFiles(t);
  await fs.writeFile(castsFile, JSON.stringify(["ゆうひ"]));
  const base = new Date(Date.now() + JST_OFFSET_MS);
  const due = epochJst(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 16, 30);
  await assert.rejects(runBg2({ now: due, castsFile, stateFile, notifyFn: async () => {} }), /8ページ分/);
  await assert.rejects(fs.access(stateFile));
});

test("eligible casts are notified once; notification or parse failure remains retryable", async t => {
  const { castsFile, stateFile } = await tempFiles(t);
  await fs.writeFile(castsFile, JSON.stringify(["ゆうひ", "リンス"]));
  const pages = pagesFor(pageHtml(card("リンス(22)", "10:00～20:00", { soldAlt: true }) + card("ゆうひ(23)", "10:00～19:00")));
  const base = new Date(Date.now() + JST_OFFSET_MS);
  const due = epochJst(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 16, 30);
  const messages = [];
  const first = await runBg2({ pages, now: due, castsFile, stateFile, notifyFn: async message => messages.push(message) });
  assert.equal(first.entries.length, 1);
  assert.match(messages[0], /対象キャスト：ゆうひ/);
  assert.doesNotMatch(messages[0], /リンス/);
  assert.equal((await runBg2({ pages, now: due + 300_000, castsFile, stateFile, notifyFn: async message => messages.push(message) })).status, "already-checked");
  assert.equal(messages.length, 1);

  const retryState = path.join(path.dirname(stateFile), "retry.json");
  await assert.rejects(runBg2({ pages, now: due, castsFile, stateFile: retryState, notifyFn: async () => { throw new Error("temporary notification error"); } }), /temporary notification error/);
  await assert.rejects(fs.access(retryState));
  await assert.rejects(runBg2({ pages: pagesFor("<title>Maintenance</title><table></table>"), now: due, castsFile, stateFile: retryState, notifyFn: async () => {} }), /構造/);
  await assert.rejects(fs.access(retryState));
  assert.ok((await runBg2({ pages, now: due + 1000, castsFile, stateFile: retryState, notifyFn: async () => {} })).status === "checked");
});

test("concurrent same-day cron deliveries cannot send duplicate notifications", async t => {
  const { castsFile, stateFile } = await tempFiles(t);
  await fs.writeFile(castsFile, JSON.stringify(["ゆうひ"]));
  const pages = pagesFor(pageHtml(card("ゆうひ(23)", "10:00～19:00")));
  const base = new Date(Date.now() + JST_OFFSET_MS);
  const due = epochJst(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 16, 30);
  let release;
  const first = runBg2({ pages, now: due, castsFile, stateFile, notifyFn: () => new Promise(resolve => { release = resolve; }) });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const second = await runBg2({ pages, now: due, castsFile, stateFile, notifyFn: async () => assert.fail("duplicate notification") });
  assert.equal(second.status, "busy");
  release();
  assert.equal((await first).status, "checked");
});

test("one-shot mode sends only the configured cast once and leaves normal BG2 state untouched", async t => {
  const { dir, castsFile, stateFile } = await tempFiles(t);
  const oneShotFile = path.join(dir, "one-shot.json");
  const oneShotStateFile = path.join(dir, "one-shot-state.json");
  const names = ["リンス", "シャンプー", "しずく", "ゆうひ", "アテナ", "さくらんぼ", "ゆいな", "るのあ", "みなも"];
  await fs.writeFile(castsFile, JSON.stringify(names));
  const base = new Date(Date.now() + JST_OFFSET_MS);
  const runEpoch = epochJst(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 17, 0);
  const runDay = new Date(runEpoch + JST_OFFSET_MS);
  const target = new Date(Date.UTC(runDay.getUTCFullYear(), runDay.getUTCMonth(), runDay.getUTCDate() + 4));
  const targetDate = `${target.getUTCFullYear()}/${String(target.getUTCMonth() + 1).padStart(2, "0")}/${String(target.getUTCDate()).padStart(2, "0")}`;
  const runDate = `${runDay.getUTCFullYear()}/${String(runDay.getUTCMonth() + 1).padStart(2, "0")}/${String(runDay.getUTCDate()).padStart(2, "0")}`;
  await fs.writeFile(oneShotFile, JSON.stringify({ id: "minamo-one-shot-test", runDate, targetDate, cast: "みなも" }));
  assert.deepEqual(loadOneShotConfig(oneShotFile), { id: "minamo-one-shot-test", runDate, targetDate, cast: "みなも" });
  const prior = { checkedJstDate: runDate.replaceAll("/", "-"), checkedAt: "prior", targetDate: "prior", notificationCasts: [], lastNotifiedAt: "-" };
  await fs.writeFile(stateFile, JSON.stringify(prior));
  const pages = pagesFor(pageHtml(card("みなも(24)", "11:00～20:00") + card("ゆうひ(23)", "10:00～19:00")));
  const messages = [];
  const opts = { pages, now: runEpoch, castsFile, stateFile, oneShotFile, oneShotStateFile, notifyFn: async message => messages.push(message), logger: { log() {}, error() {} } };
  const sent = await runBg2(opts);
  assert.equal(sent.status, "sent");
  assert.equal(sent.shift, "11:00～20:00");
  assert.equal(messages.length, 1);
  assert.equal(messages[0], buildMessage(target, [{ name: "みなも", shift: "11:00～20:00" }]));
  assert.doesNotMatch(messages[0], /ゆうひ|リンス|シャンプー/);
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, "utf8")), prior);
  assert.equal((await runBg2(opts)).status, "already-attempted");
  assert.equal(messages.length, 1);
  assert.equal(JSON.parse(await fs.readFile(oneShotStateFile, "utf8")).status, "sent");
});

test("one-shot mode does not send for absent shift or SOLD OUT and records failed LINE attempt once", async t => {
  const { dir, castsFile } = await tempFiles(t);
  const stateFile = path.join(dir, "daily.json");
  const oneShotFile = path.join(dir, "one-shot.json");
  const oneShotStateFile = path.join(dir, "once.json");
  await fs.writeFile(castsFile, JSON.stringify(["みなも"]));
  const base = new Date(Date.now() + JST_OFFSET_MS);
  const now = epochJst(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 17, 0);
  const d = new Date(now + JST_OFFSET_MS);
  const runDate = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4));
  const targetDate = `${target.getUTCFullYear()}/${String(target.getUTCMonth() + 1).padStart(2, "0")}/${String(target.getUTCDate()).padStart(2, "0")}`;
  await fs.writeFile(oneShotFile, JSON.stringify({ id: "minamo-one-shot-test", runDate, targetDate, cast: "みなも" }));
  let calls = 0;
  let pages = pagesFor(pageHtml(card("みなも(24)", "")));
  let opts = { pages, now, castsFile, stateFile, oneShotFile, oneShotStateFile, notifyFn: async () => { calls++; }, logger: { log() {}, error() {} } };
  assert.equal((await runBg2(opts)).status, "not-eligible");
  pages = pagesFor(pageHtml(card("みなも(24)", "11:00～20:00", { soldAlt: true })));
  opts = { ...opts, pages };
  assert.equal((await runBg2(opts)).status, "sold-out");
  assert.equal(calls, 0);
  await assert.rejects(fs.access(oneShotStateFile));

  pages = pagesFor(pageHtml(card("みなも(24)", "11:00～20:00")));
  opts = { ...opts, pages, notifyFn: async () => { calls++; throw new Error("LINE HTTP error"); } };
  await assert.rejects(runBg2(opts), /LINE HTTP error/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await fs.readFile(oneShotStateFile, "utf8")).status, "failed");
  assert.equal((await runBg2(opts)).status, "already-attempted");
  assert.equal(calls, 1);
});

test("authenticated BG ingest passes the same eight HTML pages to both monitors", async t => {
  const secret = randomBytes(32).toString("base64url");
  process.env.BG_INGEST_SECRET = secret;
  t.after(() => { delete process.env.BG_INGEST_SECRET; });
  const app = express();
  const calls = [];
  installBgIngest(app, async ({ pages }) => calls.push(["bg", pages]), async ({ pages }) => calls.push(["bg2", pages]));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const challenge = await fetch(`${base}/bg-ingest/challenge`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
  const token = (await challenge.json()).token;
  const pages = buildBgUrls().map(url => ({ url, html: pageHtml(card("その他", "12:00～20:00")) }));
  const body = gzipSync(JSON.stringify(pages));
  const signature = createHmac("sha256", secret).update(`bg-ingest/v1\n${token}\n`).update(body).digest("hex");
  const response = await fetch(`${base}/bg-ingest`, { method: "POST", body, headers: {
    "Content-Type": "application/gzip", "X-BG-Token": token, "X-BG-Signature": signature
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(([name]) => name), ["bg", "bg2"]);
  assert.deepEqual(calls[0][1], pages);
  assert.deepEqual(calls[1][1], pages);
});
