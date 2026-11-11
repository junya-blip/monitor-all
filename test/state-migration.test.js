const assert = require("node:assert/strict");
const { test } = require("node:test");
const axios = require("axios");
const {
  GetObjectCommand, PutObjectCommand, DeleteObjectCommand
} = require("@aws-sdk/client-s3");
const { R2StateStore, setStateStoreForTests } = require("../common/state-store");
const { buildBgUrls } = require("../common/bg-source");
const { JST_OFFSET_MS } = require("../common/time");

class MemoryS3 {
  objects = new Map();
  async send(command) {
    const { Key, Body } = command.input;
    if (command instanceof GetObjectCommand) {
      if (!this.objects.has(Key)) { const error = new Error("missing"); error.name = "NoSuchKey"; throw error; }
      const value = this.objects.get(Key);
      return { Body: { transformToString: async () => value } };
    }
    if (command instanceof PutObjectCommand) { this.objects.set(Key, String(Body)); return {}; }
    if (command instanceof DeleteObjectCommand) { this.objects.delete(Key); return {}; }
    throw new Error("unexpected command");
  }
}

function cityHtml(time = "10:00-18:00") {
  return `<div id="syukin_month"><div class="girlitem_waku"><div class="girlitem_waku_left">11/12(木)</div><div class="girlitem_waku_right">${time}</div></div></div>`;
}
function pageHtml(text = "") {
  return `<title>出勤情報</title><table><tr><td>${text}</td></tr></table>`;
}

test("five monitors establish silent R2 baselines then retain normal change/daily behavior", async t => {
  const originalGet = axios.get;
  const originalPost = axios.post;
  const originalMode = process.env.NOTIFY_MODE;
  const originalToken = process.env.LINE_TOKEN;
  const originalUser = process.env.LINE_USER_ID;
  const messages = [];
  let pickupNames = ["対象A"];
  let yuuriTitle = "最新日記";
  let heavenTime = "10:00-18:00";
  axios.get = async url => {
    if (String(url).includes("pickup]=Y")) return { data: `<span class="name"><a>${pickupNames[0]}</a></span>` };
    if (String(url).includes("/umeda/top/")) return { data: "<html><body>次週情報なし</body></html>" };
    if (String(url).includes("cityheaven")) return { data: cityHtml(heavenTime) };
    if (String(url).includes("photodiary")) return { data: `<div class="diary_cont"><div class="tit"><a href="/diary/latest/">${yuuriTitle}</a></div></div>` };
    throw new Error(`unexpected HTTP GET ${url}`);
  };
  axios.post = async (_url, body) => { messages.push(body?.messages?.[0]?.text || body?.content || ""); return { status: 200 }; };
  process.env.NOTIFY_MODE = "line";
  process.env.LINE_TOKEN = "mock";
  process.env.LINE_USER_ID = "mock";
  const priorStore = require("../common/state-store").getStateStore();
  const store = new R2StateStore({ client: new MemoryS3(), bucket: "test", logger: { warn() {} } });
  setStateStoreForTests(store);
  t.after(() => {
    axios.get = originalGet;
    axios.post = originalPost;
    setStateStoreForTests(priorStore);
    for (const [key, value] of [["NOTIFY_MODE", originalMode], ["LINE_TOKEN", originalToken], ["LINE_USER_ID", originalUser]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const pickup = require("../pickup-monitor");
  await pickup();
  assert.equal(messages.length, 0, "pickup baseline must be silent");
  await pickup();
  assert.equal(messages.length, 0, "same pickup data must not duplicate");
  pickupNames = ["対象B"];
  await pickup();
  assert.equal(messages.length, 1, "pickup changes notify after initialization");

  const bg = require("../bg-monitor");
  const urls = buildBgUrls();
  const emptyPages = urls.map(url => ({ url, html: pageHtml() }));
  await bg({ pages: emptyPages });
  assert.equal(messages.length, 1, "BG baseline must be silent");
  await bg({ pages: emptyPages });
  assert.equal(messages.length, 1, "same BG state must not duplicate");
  const changedPages = urls.map((url, index) => ({
    url,
    html: pageHtml(index === 0 ? '<h4>ゆうひ</h4>キャンセル発生' : "")
  }));
  await bg({ pages: changedPages });
  assert.equal(messages.length, 2, "BG diff notifies after initialization");

  const heaven = require("../heaven-monitor");
  await heaven();
  assert.equal(messages.length, 2, "Heaven baseline for each cast must be silent");
  await heaven();
  assert.equal(messages.length, 2, "same Heaven state must not duplicate");
  heavenTime = "11:00-19:00";
  await heaven();
  assert.equal(messages.length, 4, "Heaven schedule changes notify per cast after initialization");

  const yuuri = require("../yuuri-monitor");
  await yuuri();
  assert.equal(messages.length, 4, "Yuuri baseline must be silent");
  await yuuri();
  assert.equal(messages.length, 4, "same Yuuri state must not duplicate");
  yuuriTitle = "新しい日記";
  await yuuri();
  assert.equal(messages.length, 5, "Yuuri change notifies after initialization");

  const deniedStore = new R2StateStore({
    client: { async send() { const error = new Error("denied"); error.name = "AccessDenied"; throw error; } },
    bucket: "test",
    logger: { warn() {} }
  });
  setStateStoreForTests(deniedStore);
  await assert.rejects(yuuri(), error => error.code === "STATE_STORE_AUTH");
  assert.equal(messages.length, 5, "R2 read failure stops before scrape, diff, and notification");
  setStateStoreForTests(store);

  const bg2 = require("../bg-monitor2");
  const nowJst = new Date(Date.now() + JST_OFFSET_MS);
  const beforeWindow = Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate(), 1, 0);
  const due = beforeWindow + 7 * 60 * 60_000;
  const pages = buildBgUrls().map((url, index) => ({
    url,
    html: pageHtml(index === 4
      ? '<td><div class="txtbox">ゆうひ(23)<span class="shifttime">10:00～20:00</span></div></td>'
      : '<td><div class="txtbox">その他<span class="shifttime">12:00～20:00</span></div></td>')
  }));
  const castFile = require("node:path").join(__dirname, "bg-monitor2-casts.test.json");
  const fs = require("node:fs/promises");
  await fs.writeFile(castFile, JSON.stringify(["ゆうひ"]));
  t.after(() => fs.rm(castFile, { force: true }));
  const daily = await bg2.runBgMonitor2({ pages, now: beforeWindow, castsFile: castFile, notifyFn: async message => messages.push(message) });
  assert.equal(daily.status, "before-window");
  assert.equal(messages.length, 5, "BG2 baseline before 16:30 must not notify");
  const checked = await bg2.runBgMonitor2({ pages, now: due, castsFile: castFile, notifyFn: async message => messages.push(message) });
  assert.equal(checked.status, "checked");
  assert.equal(messages.length, 6, "BG2 daily notification remains active at 16:30");
});
