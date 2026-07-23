const express = require("express");
const app = express();

const fs = require("fs");
const path = require("path");

// 各 monitor の読み込み
const pickupMonitor = require("./pickup-monitor.js");
const bgMonitor = require("./bg-monitor.js");
const heavenMonitor = require("./heaven-monitor.js");
const yuuriMonitor = require("./yuuri-monitor.js");

// pickup-monitor
app.get("/run-pickup", async (req, res) => {
  try {
    await pickupMonitor();
    res.send("pickup-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

// bg-monitor
app.get("/run-bg", async (req, res) => {
  try {
    await bgMonitor();
    res.send("bg-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

// heaven-monitor
app.get("/run-heaven", async (req, res) => {
  try {
    await heavenMonitor();
    res.send("heaven-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

// yuuri-monitor
app.get("/run-yuuri", async (req, res) => {
  try {
    await yuuriMonitor();
    res.send("yuuri-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

app.get("/dashboard", (req, res) => {
  // 各 monitor の last.json を読み込む
  const pickup = safeLoad("pickup-last.json");
  const bg = safeLoad("bg-last.json");
  const bgNotice = safeLoad("bg-lastNotice.json");   // ★ notices[] に対応
  const yuuri = safeLoad("yuuri-last.json");

  // heaven-monitor はキャストごとに複数ファイル
  const heavenDir = path.join(__dirname, "data");
  const heavenFiles = fs.readdirSync(heavenDir).filter(f => f.startsWith("heaven-last-"));
  const heavenData = heavenFiles.map(f => ({
    name: f.replace("heaven-last-", "").replace(".json", ""),
    data: safeLoad(f)
  }));

  // HTML生成（黒背景・スマホ対応）
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

	<div class="box">
	  <h2>アバンチュール-ピックアップ奥様</h2>

	  <!-- 期間は新仕様では存在しないため非表示 -->
	  <p>対象奥様:</p>

	  <pre style="white-space: pre-wrap; color:#ccc; font-size:16px; line-height:1.6;">
	${pickup.names && pickup.names.length > 0
	  ? pickup.names.join("\n")
	  : "-"}
	  </pre>

	  <p>最終通知: ${pickup.lastNoticeTime || "-"}</p>
	</div>

    <div class="box">
      <h2>アバンチュール-オキニ出勤情報</h2>

      <style>
        .heaven-grid {
          display: flex;
          gap: 20px;
          flex-wrap: wrap;
        }

        .heaven-col {
          flex: none;
          width: auto;
          background: #333;
          padding: 10px;
          border-radius: 6px;
        }
        .heaven-col h3 {
          margin-top: 0;
          color: #fff;
        }
        .heaven-row {
          padding: 4px 0;
          border-bottom: 1px solid #444;
          font-size: 14px;
        }
      </style>

      <div class="heaven-grid">
        ${heavenData.map(h => {
          const data = h.data;

          // ★ noSchedule の場合は「出勤予定なし」だけ表示
          if (data.noSchedule) {
            return `
              <div class="heaven-col">
                <h3>${h.name}</h3>
                <div class="heaven-row">出勤予定なし</div>
                <p>最終通知: ${data.lastNoticeTime || "-"}</p>
              </div>
            `;
          }

          // ★ 通常の schedule 表示
          const schedule = data.schedule || data;

          let lastWorkIndex = -1;
          if (Array.isArray(schedule)) {
            schedule.forEach((item, idx) => {
              if (item.time && item.time !== "_" && item.time !== "-") {
                lastWorkIndex = idx;
              }
            });
          }

          const visibleSchedule =
            lastWorkIndex >= 0 ? schedule.slice(0, lastWorkIndex + 1) : schedule;

          const rows = Array.isArray(visibleSchedule)
            ? visibleSchedule
                .map(item => {
                  const time =
                    item.time === "_" || item.time === "-" ? "-" : item.time;
                  return `<div class="heaven-row">${item.date} ${time}</div>`;
                })
                .join("")
            : "<div>データなし</div>";

          return `
            <div class="heaven-col">
              <h3>${h.name}</h3>
              ${rows}
              <p>最終通知: ${data.lastNoticeTime || "-"}</p>
            </div>
          `;
        }).join("")}
      </div>
    </div>

    <div class="box">
      <h2>ビギナーズ出勤アラート</h2>
      <p>最新ヒット数: ${bg.length}</p>

      <pre>
${Array.isArray(bgNotice.notices)
  ? bgNotice.notices.map(n => linkify(n)).join("\n\n")
  : linkify(bgNotice.lastNotice || "-")}
      </pre>

      <p>最終通知: ${bgNotice.lastNoticeTime || "-"}</p>
    </div>

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

// JSON読み込みの安全関数
function safeLoad(filename) {
  try {
    const file = path.join(__dirname, "data", filename);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

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

function linkify(text) {
  if (!text) return "-";

  return text.replace(
    /(https?:\/\/[^\s]+)/g,
    '<a href="$1" target="_blank" style="color:#4ea3ff;">$1</a>'
  );
}

// WebService 起動
app.listen(10000, () => {
  console.log("Web Service started on port 10000");
});
