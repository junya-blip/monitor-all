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
      <h2>pickup-monitor</h2>
      <p>期間: ${pickup.period || "-"}</p>
      <p>奥様: ${pickup.names?.join(", ") || "-"}</p>
      <p>最終通知: ${pickup.lastNoticeTime || "-"}</p>
    </div>

    <div class="box">
      <h2>bg-monitor</h2>
      <p>最新ヒット数: ${bg.length}</p>
      <p>最終通知: ${bgNotice.lastNoticeTime || "-"}</p>
      <pre>${bgNotice.lastNotice || "-"}</pre>
    </div>

    <div class="box">
      <h2>heaven-monitor</h2>
      ${heavenData.map(h => `
        <div class="cast-box">
          <h3>${h.name}</h3>
          <pre>${JSON.stringify(h.data.schedule || h.data, null, 2)}</pre>
          <p>最終通知: ${h.data.lastNoticeTime || "-"}</p>
        </div>
      `).join("")}
    </div>

    <div class="box">
      <h2>yuuri-monitor</h2>
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

// WebService 起動
app.listen(10000, () => {
  console.log("Web Service started on port 10000");
});
