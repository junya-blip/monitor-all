// server.js
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
  const bgNotice = safeLoad("bg-lastNotice.json");
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
      }
    </style>
  </head>
  <body>
    <h1>📊 Monitor Dashboard</h1>
    <p>最終更新: ${getJSTTime()}</p>

    <div class="box">
      <h2>アバンチュール-ピックアップ奥様</h2>
      <p>期間: ${pickup.period || "-"}</p>
      <p>奥様: ${pickup.names?.join(", ") || "-"}</p>
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
		  flex: none;        /* ← これが重要 */
		  width: auto;       /* ← 中身に合わせる */
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
	      const schedule = h.data.schedule || h.data;

	      // 出勤が入っている最後の日を探す
	      let lastWorkIndex = -1;
	      if (Array.isArray(schedule)) {
	        schedule.forEach((item, idx) => {
	          if (item.time && item.time !== "_" && item.time !== "-") {
	            lastWorkIndex = idx;
	          }
	        });
	      }

	      // 表示する範囲を決定（出勤がある日まで）
	      const visibleSchedule =
	        lastWorkIndex >= 0 ? schedule.slice(0, lastWorkIndex + 1) : schedule;

			const rows = Array.isArray(visibleSchedule)
			  ? visibleSchedule.map(item => {
			      const time = (item.time === "_" || item.time === "-") ? "-" : item.time;
			      return `<div class="heaven-row">${item.date} ${time}</div>`;
			    }).join("")
			  : "<div>データなし</div>";

	      return `
	        <div class="heaven-col">
	          <h3>${h.name}</h3>
	          ${rows}
	          <p>最終通知: ${h.data.lastNoticeTime || "-"}</p>
	        </div>
	      `;
	    }).join("")}
	  </div>
	</div>

    <div class="box">
      <h2>ビギナーズ出勤アラート</h2>
      <p>最新ヒット数: ${bg.length}</p>
      <p>最終通知: ${bgNotice.lastNoticeTime || "-"}</p>
      <pre>${bgNotice.lastNotice || "-"}</pre>
    </div>

    <div class="box">
      <h2>ゆうりちゃんの日記</h2>
      <p>タイトル: ${yuuri.title || "-"}</p>
      <p>URL: ${yuuri.link || "-"}</p>
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
  const jst = new Date();

  const yyyy = jst.getFullYear();
  const mm = String(jst.getMonth() + 1).padStart(2, "0");
  const dd = String(jst.getDate()).padStart(2, "0");

  const hh = String(jst.getHours()).padStart(2, "0");
  const mi = String(jst.getMinutes()).padStart(2, "0");
  const ss = String(jst.getSeconds()).padStart(2, "0");

  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

// WebService 起動
app.listen(10000, () => {
  console.log("Web Service started on port 10000");
});
