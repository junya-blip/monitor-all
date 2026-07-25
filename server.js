const express = require("express");
const app = express();

const fs = require("fs");
const path = require("path");

// 各 monitor の読み込み
const pickupMonitor = require("./pickup-monitor.js");
const bgMonitor = require("./bg-monitor.js");
const heavenMonitor = require("./heaven-monitor.js");
const yuuriMonitor = require("./yuuri-monitor.js");

/* ===============================
   過去日を除外（未来日だけ残す）
=============================== */
function filterFuture(schedule) {
  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth() + 1;
  const todayD = today.getDate();

  return schedule.filter(s => {
    const dateStr = s.date.replace(/\(.+\)/, "");
    const [m, d] = dateStr.split("/").map(Number);

    const sDate = new Date(todayY, m - 1, d);
    const todayDate = new Date(todayY, todayM - 1, todayD);

    return sDate >= todayDate;
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

/* ===============================
   safeLoad
=============================== */
function safeLoad(filename) {
  try {
    const file = path.join(__dirname, "data", filename);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/* ===============================
   JST 時刻
=============================== */
function getJSTTime() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");

  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mi = String(jst.getUTCMinutes()).padStart(2, "0");
  const ss = String(jst.getUTCSeconds()).padStart(2, "0");

  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

/* ===============================
   linkify
=============================== */
function linkify(text) {
  if (!text) return "-";

  return text.replace(
    /(https?:\/\/[^\s]+)/g,
    '<a href="$1" target="_blank" style="color:#4ea3ff;">$1</a>'
  );
}

/* ===============================
   各 monitor の API
=============================== */
app.get("/run-pickup", async (req, res) => {
  try {
    await pickupMonitor();
    res.send("pickup-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

app.get("/run-bg", async (req, res) => {
  try {
    await bgMonitor();
    res.send("bg-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

app.get("/run-heaven", async (req, res) => {
  try {
    await heavenMonitor();
    res.send("heaven-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

app.get("/run-yuuri", async (req, res) => {
  try {
    await yuuriMonitor();
    res.send("yuuri-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

/* ===============================
   Dashboard
=============================== */
app.get("/dashboard", (req, res) => {
  const pickup = safeLoad("pickup-last.json");
  const bg = safeLoad("bg-last.json");
  const bgNotice = safeLoad("bg-lastNotice.json");
  const yuuri = safeLoad("yuuri-last.json");

  // heaven-monitor はキャストごとに複数ファイル
  const heavenDir = path.join(__dirname, "data");
  const heavenFiles = fs.readdirSync(heavenDir).filter(f => f.startsWith("heaven-last-"));
  const heavenData = heavenFiles.map(f => ({
    name: f.replace("heaven-last-", "").replace(".json", ""),
    data: safeLoad(f)
  }));

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

    <!-- ピックアップ奥様（修正版） -->
    <div class="box">
      <h2>アバンチュール-ピックアップ奥様</h2>

      <div class="heaven-grid" style="display:flex; gap:20px; flex-wrap:wrap;">
        <div class="heaven-col" style="background:#333; padding:10px; border-radius:6px;">
          <h3>対象奥様</h3>

          <pre style="white-space: pre-wrap; color:#ccc; font-size:16px; line-height:1.6;">
${pickup.names && pickup.names.length > 0
  ? pickup.names.map(n => n.trim()).join("\n")
  : "-"}
          </pre>

          <p>最終通知: ${pickup.lastNoticeTime || "-"}</p>
        </div>
      </div>
    </div>

    <!-- heaven-monitor -->
    <div class="box">
      <h2>アバンチュール-オキニ出勤情報</h2>

      <div class="heaven-grid" style="display:flex; gap:20px; flex-wrap:wrap;">
        ${heavenData.map(h => {
          const data = h.data;

          if (data.noSchedule) {
            return `
              <div class="heaven-col" style="background:#333; padding:10px; border-radius:6px;">
                <h3>${h.name}</h3>
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
              <h3>${h.name}</h3>
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
      <p>最新ヒット数: ${bg.length}</p>

      <pre>
		${bg.length > 0
		  ? bg.map(n => linkify(
		      `${n.date}\n${n.title} (${n.keyword})\n${n.shift}\n${n.url}`
		    )).join("\n\n")
		  : "-"}
      </pre>

      <p>最終通知: ${bgNotice.lastNoticeTime || "-"}</p>
    </div>

    <!-- yuuri-monitor -->
    <div class="box">
      <h2>ゆうりちゃんの日記</h2>
      <p>タイトル: ${yuuri.title || "-"}</p>
      <p>
        URL: ${
          yuuri.link
            ? `<a href="https://fukuharaso-pu.com${yuuri.link}" target="_blank" style="color:#4ea3ff;">${yuuri.link}</a>`
            : "-"
        }
      </p>
      <p>最終通知: ${yuuri.lastNoticeTime || "-"}</p>
    </div>

  </body>
  </html>
  `;

  res.send(html);
});

// WebService 起動
app.listen(10000, () => {
  console.log("Web Service started on port 10000");
});
