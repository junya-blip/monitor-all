// server.js
const express = require("express");
const app = express();

const pickupMonitor = require("./pickup-monitor.js");
const bgMonitor = require("./bg-monitor.js");   // ★ 追加

app.get("/run-pickup", async (req, res) => {
  try {
    await pickupMonitor();
    res.send("pickup-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

// ★★★ bg-monitor 用 API ★★★
app.get("/run-bg", async (req, res) => {
  try {
    await bgMonitor();
    res.send("bg-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

app.listen(10000, () => {
  console.log("Web Service started on port 10000");
});
