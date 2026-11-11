const express = require("express");
const app = express();

const fs = require("fs");
const path = require("path");

const {
  getJSTDate,
  getJSTTime
} = require("./common/time");

// 各 monitor の読み込み
const pickupMonitor = require("./pickup-monitor.js");
const bgMonitor = require("./bg-monitor.js");
const { installBgIngest } = require("./common/bg-ingest");
const { readState, getStateStore, heavenStateKey } = require("./common/state-store");
const bgMonitor2 = require("./bg-monitor2.js");
const heavenMonitor = require("./heaven-monitor.js");
const yuuriMonitor = require("./yuuri-monitor.js");
const activeMonitors = new Set();

async function runExclusive(name, res, callback) {
  if (activeMonitors.has(name)) return res.status(409).send(`${name} monitor is already running`);
  activeMonitors.add(name);
  try { await callback(); }
  finally { activeMonitors.delete(name); }
}

function stateStoreStatus(error) {
  return error?.stateStoreError || String(error?.code || "").startsWith("STATE_STORE_");
}

/* ===============================
   過去日を除外（JST基準で今日以降だけ残す）
=============================== */
function filterFuture(schedule) {
  const jst = getJSTDate();

  const todayY = jst.getUTCFullYear();
  const todayM = jst.getUTCMonth() + 1;
  const todayD = jst.getUTCDate();

  const todayValue =
    todayY * 10000 +
    todayM * 100 +
    todayD;

  return schedule.filter(s => {
    if (!s || !s.date) {
      return false;
    }

    const dateStr = String(s.date)
      .replace(/\u00A0/g, "")
      .replace(/[\u2000-\u200F]/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, "")
      .trim();

    const [m, d] =
      dateStr.split("/").map(Number);

    if (
      !Number.isFinite(m) ||
      !Number.isFinite(d)
    ) {
      console.log(
        `日付解析失敗: ${s.date}`
      );
      return false;
    }

    let scheduleY = todayY;

    // 12月に表示される1月分は翌年
    if (
      todayM === 12 &&
      m === 1
    ) {
      scheduleY = todayY + 1;
    }

    // 1月に残っている12月分は前年
    if (
      todayM === 1 &&
      m === 12
    ) {
      scheduleY = todayY - 1;
    }

    const scheduleValue =
      scheduleY * 10000 +
      m * 100 +
      d;

    return scheduleValue >= todayValue;
  });
}

/* ===============================
   最後の出勤日 index（time が "-" 以外）
=============================== */
function getLastWorkingIndex(schedule) {
  let lastIndex = -1;
  schedule.forEach((s, i) => {
    if (s.time && s.time !== "-" && s.time !== "_") {
      lastIndex = i;
    }
  });
  return lastIndex;
}

function statePath(filename) {
  return path.join(__dirname, "data", filename);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function validPickupState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const currentValid = data.current
    ? typeof data.current.period === "string" && Array.isArray(data.current.names)
    : typeof data.period === "string" && Array.isArray(data.names);
  const nextValid = data.next === undefined || (
    data.next && typeof data.next.period === "string" && Array.isArray(data.next.names)
  );
  return currentValid && nextValid &&
    (data.lastNoticeTime === null || typeof data.lastNoticeTime === "string");
}

/* ===============================
   linkify
=============================== */
function linkify(text) {
  if (!text) return "-";

  const escaped = text.replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
  return escaped.replace(
    /(https?:\/\/[^\s]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#4ea3ff;">$1</a>'
  );
}

/* ===============================
   各 monitor の API
=============================== */
app.get("/run-pickup", async (req, res) => {
  try {
    await runExclusive("pickup", res, async () => {
      await pickupMonitor();
      res.send("pickup-monitor done");
    });
  } catch (e) {
    console.error(`pickup-monitor failed (${e?.code || "ERROR"})`);
    res.status(stateStoreStatus(e) ? 503 : 500).send(stateStoreStatus(e) ? "state store unavailable" : "pickup-monitor failed");
  }
});

app.get("/run-bg", async (req, res) => {
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    await bgMonitor({ signal: controller.signal });
    if (!res.destroyed) res.send("bg-monitor done");
  } catch (e) {
    if (res.destroyed) return;
    const status = {
      BG_BUSY: 409,
      BG_UPSTREAM: 502,
      BG_DEADLINE: 504
    }[e.code] || 500;
    res.status(status).send("bg-monitor failed");
  }
});

installBgIngest(app, bgMonitor, ({ pages }) => bgMonitor2.runBgMonitor2({ pages }));

app.get("/run-heaven", async (req, res) => {
  try {
    await runExclusive("heaven", res, async () => {
      await heavenMonitor();
      res.send("heaven-monitor done");
    });
  } catch (e) {
    console.error(`heaven-monitor failed (${e?.code || "ERROR"})`);
    res.status(stateStoreStatus(e) ? 503 : 500).send(stateStoreStatus(e) ? "state store unavailable" : "heaven-monitor failed");
  }
});

app.get("/run-yuuri", async (req, res) => {
  try {
    await runExclusive("yuuri", res, async () => {
      await yuuriMonitor();
      res.send("yuuri-monitor done");
    });
  } catch (e) {
    console.error(`yuuri-monitor failed (${e?.code || "ERROR"})`);
    res.status(stateStoreStatus(e) ? 503 : 500).send(stateStoreStatus(e) ? "state store unavailable" : "yuuri-monitor failed");
  }
});

/* ===============================
   Dashboard
=============================== */
app.get("/dashboard", async (req, res) => {
  let pickup, bgState, bg2, yuuri, heavenData;
  try {
  // cast.json の登録順に、現在の監視対象だけを表示する。
  const casts = JSON.parse(
    fs.readFileSync(path.join(__dirname, "cast.json"), "utf8")
  );
  const load = (key, file) => readState(key, statePath(file));
  const currentStore = getStateStore();
  [pickup, bgState, bg2, yuuri, heavenData] = await Promise.all([
    load("pickup-last.json", "pickup-last.json"),
    (async () => {
      if (currentStore.mode === "r2") return load("bg-monitor.json", "bg-state.json");
      const [hits, history] = await Promise.all([
        load("bg-last.json", "bg-last.json"),
        load("bg-lastNotice.json", "bg-lastNotice.json")
      ]);
      return {
        initialized: true,
        data: {
          hits: Array.isArray(hits.data) ? hits.data : [],
          notices: Array.isArray(history.data?.notices) ? history.data.notices : [],
          lastNoticeTime: history.data?.lastNoticeTime || "-"
        }
      };
    })(),
    load("bg-monitor2-last.json", "bg-monitor2-last.json"),
    load("yuuri-last.json", "yuuri-last.json"),
    Promise.all(casts.map(async cast => ({
      name: cast.name,
      state: await load(heavenStateKey(cast.name), `heaven-last-${cast.name}.json`)
    })))
  ]);
  } catch (error) {
    const code = error?.code || "STATE_STORE_ERROR";
    console.error(`Dashboard state read failed (${code})`);
    return res.status(503).type("text/plain").send("監視状態を取得できません。保存先の接続状態を確認してください。");
  }

  const store = getStateStore();
  const emptyPickup = { current: { period: "", names: [] }, next: { period: "", names: [] }, lastNoticeTime: null };
  const pickupData = pickup.initialized ? pickup.data : emptyPickup;
  const bg = bgState.initialized && Array.isArray(bgState.data?.hits) ? bgState.data.hits : [];
  const bgNotice = bgState.initialized ? { notices: bgState.data.notices || [], lastNoticeTime: bgState.data.lastNoticeTime || "-" } : { notices: [], lastNoticeTime: "-" };
  const bg2Data = bg2.initialized ? bg2.data : {};
  const yuuriData = yuuri.initialized ? yuuri.data : {};
  const stateLabel = initialized => initialized ? "準備完了" : "初回基準登録待ち";
  const invalidState = (pickup.initialized && !validPickupState(pickupData)) ||
    (bgState.initialized && (!Array.isArray(bgState.data?.hits) || !bgState.data.hits.every(hit => hit && typeof hit === "object" && ["date", "title", "keyword", "shift", "url"].every(key => typeof hit[key] === "string")) || !Array.isArray(bgState.data?.notices) || !bgState.data.notices.every(item => typeof item === "string") || typeof bgState.data?.lastNoticeTime !== "string")) ||
    (bg2.initialized && (!bg2Data || typeof bg2Data.checkedAt !== "string" || typeof bg2Data.targetDate !== "string" || !Array.isArray(bg2Data.notificationCasts) || !bg2Data.notificationCasts.every(item => item && typeof item.name === "string" && typeof item.shift === "string") || typeof bg2Data.lastNotifiedAt !== "string" || (bg2Data.checkedJstDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(bg2Data.checkedJstDate)))) ||
    (yuuri.initialized && (!yuuriData || !(yuuriData.title === null || typeof yuuriData.title === "string") || !(yuuriData.link === null || typeof yuuriData.link === "string") || !(yuuriData.lastNoticeTime === null || typeof yuuriData.lastNoticeTime === "string")));
  if (invalidState || heavenData.some(item => item.state.initialized && (!Array.isArray(item.state.data?.schedule) || !item.state.data.schedule.every(row => row && typeof row.date === "string" && typeof row.time === "string") || typeof item.state.data?.noSchedule !== "boolean" || !(item.state.data?.lastNoticeTime === null || typeof item.state.data?.lastNoticeTime === "string")))) {
    console.error("Dashboard state schema validation failed");
    return res.status(503).type("text/plain").send("監視状態の形式を確認できません。通知判定を停止しています。");
  }

  let html = `
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body {
        background: #111;
        color: #eee;
        font-family: sans-serif;
        padding: 20px;
      }
      h1, h2 {
        color: #fff;
      }
      .box {
        background: #222;
        padding: 15px;
        margin-bottom: 20px;
        border-radius: 8px;
      }
      .cast-box {
        background: #333;
        padding: 10px;
        margin: 10px 0;
        border-radius: 6px;
      }
      pre {
        white-space: pre-wrap;
        color: #ccc;
        font-size: 16px;
        line-height: 1.6;
      }
      a {
        word-break: break-all;
      }
    </style>
  </head>
  <body>
    <h1>📊 Monitor Dashboard</h1>
    <p>最終更新: ${getJSTTime()}</p>
    <p>状態ストア: ${store.mode === "r2" ? "Cloudflare R2 読み込み成功" : "ローカルJSON"}</p>

    <!-- ピックアップ奥様 -->
    <div class="box">
      <h2>アバンチュール-ピックアップ奥様</h2>
      <p>状態: ${stateLabel(pickup.initialized)}</p>

      ${
        (() => {
          /*
           * 新旧どちらのpickup-last.jsonでも
           * ダッシュボードを表示できるようにする。
           */
          const currentPickup = pickupData.current || {
            period: pickupData.period || "",
            names: Array.isArray(pickupData.names)
              ? pickupData.names
              : []
          };

          const nextPickup = pickupData.next || {
            period: "",
            names: []
          };

			const renderPickupSection = data => {
			  const names =
			    Array.isArray(data.names) &&
			    data.names.length > 0
			      ? data.names
			          .map(name => name.trim())
			          .join("\n")
			      : "-";

			  return `
			    ${
			      data.period
			        ? `<div style="font-weight:bold;">${data.period}</div>`
			        : ""
			    }
			    <pre
			      style="
			        white-space:pre-wrap;
			        color:#ccc;
			        font-size:16px;
			        line-height:1.6;
			        margin:0;
			      "
			    >${names}</pre>
			  `;
			};

			return `
			  <div
			    style="
			      background:#333;
			      padding:15px;
			      border-radius:6px;
			    "
			  >
			    ${renderPickupSection(currentPickup)}

			    ${
			      nextPickup.names &&
			      nextPickup.names.length > 0
			        ? `
			          <div style="margin-top:18px;">
			            ${renderPickupSection(nextPickup)}
			          </div>
			        `
			        : ""
			    }
			  </div>

			  <p>
			    最終通知:
			    ${pickupData.lastNoticeTime || "-"}
			  </p>
			`;
        })()
      }
    </div>
    
    <!-- heaven-monitor -->
    <div class="box">
      <h2>アバンチュール-オキニ出勤情報</h2>

      <div class="heaven-grid" style="display:flex; gap:20px; flex-wrap:wrap;">
        ${heavenData.map(h => {
          const data = h.state.initialized ? h.state.data : {};

          if (!h.state.initialized) {
            return `
              <div class="heaven-col" style="background:#333; padding:10px; border-radius:6px;">
                <h3>${escapeHtml(h.name)}</h3>
                <div class="heaven-row">初回基準登録待ち</div>
              </div>
            `;
          }

          if (data.noSchedule) {
            return `
              <div class="heaven-col" style="background:#333; padding:10px; border-radius:6px;">
                <h3>${escapeHtml(h.name)}</h3>
                <div class="heaven-row">出勤予定なし</div>
                <p>最終通知: ${data.lastNoticeTime || "-"}</p>
              </div>
            `;
          }

          const schedule = data.schedule || [];

          const futureOnly = filterFuture(schedule);
          const lastIndex = getLastWorkingIndex(futureOnly);
          const visibleSchedule =
            lastIndex >= 0 ? futureOnly.slice(0, lastIndex + 1) : futureOnly;

          const rows = visibleSchedule.length > 0
            ? visibleSchedule
                .map(item => {
                  const time = item.time === "-" || item.time === "_" ? "-" : item.time;
                  return `<div class="heaven-row">${item.date} ${time}</div>`;
                })
                .join("")
            : "<div>データなし</div>";

          return `
            <div class="heaven-col" style="background:#333; padding:10px; border-radius:6px;">
            <h3>${escapeHtml(h.name)}</h3>
              ${rows}
              <p>最終通知: ${data.lastNoticeTime || "-"}</p>
            </div>
          `;
        }).join("")}
      </div>
    </div>

    <!-- bg-monitor -->
    <div class="box">
      <h2>ビギナーズ出勤アラート</h2>
      <p>状態: ${stateLabel(bgState.initialized)}</p>
      <p>最新ヒット数: ${bg.length}</p>

<pre>${bg.length > 0
  ? bg.map(n => linkify(
      `${n.date}\n${n.title} (${n.keyword})\n${n.shift}\n${n.url}`
    )).join("\n\n")
  : "-"}</pre>

      <p>最終通知: ${bgNotice.lastNoticeTime || "-"}</p>
    </div>

    <!-- bg-monitor2 -->
    <div class="box">
      <h2>ビギナーズ予約情報</h2>
      <p>最終チェック日時: ${escapeHtml(bg2Data.checkedAt || "-")}</p>
      <p>状態: ${stateLabel(bg2.initialized)}</p>
      <p>チェック対象日: ${escapeHtml(bg2Data.targetDate || "-")}</p>
      <pre>${Array.isArray(bg2Data.notificationCasts) && bg2Data.notificationCasts.length
        ? bg2Data.notificationCasts.map(item => escapeHtml(`${item.name}：${item.shift}`)).join("\n")
        : "通知対象なし"}</pre>
      <p>最終通知日時: ${escapeHtml(bg2Data.lastNotifiedAt || "-")}</p>
    </div>

    <!-- yuuri-monitor -->
    <div class="box">
      <h2>ゆうりちゃんの日記</h2>
      <p>状態: ${stateLabel(yuuri.initialized)}</p>
      <p>タイトル: ${escapeHtml(yuuriData.title || "-")}</p>
      <p>
        URL: ${
          yuuriData.link
            ? `<a href="https://fukuharaso-pu.com${escapeHtml(yuuriData.link)}" target="_blank" rel="noopener noreferrer" style="color:#4ea3ff;">${escapeHtml(yuuriData.link)}</a>`
            : "-"
        }
      </p>
      <p>最終通知: ${escapeHtml(yuuriData.lastNoticeTime || "-")}</p>
    </div>

  </body>
  </html>
  `;

  res.send(html);
});

// WebService 起動
const server = app.listen(10000, () => {
  console.log("Web Service started on port 10000");
});

try {
  const store = getStateStore();
  if (store.mode === "r2") {
    store.verify()
      .then(() => console.log("R2 state-store probe OK (temporary test object removed)"))
      .catch(error => console.error(`R2 state-store probe failed (${error?.code || "ERROR"})`));
  } else {
    console.log("State store mode: local JSON");
  }
} catch (error) {
  console.error(`State store configuration failed (${error?.code || "ERROR"})`);
}
