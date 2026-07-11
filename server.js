// server.js
const express = require("express");
const app = express();

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

// WebService 起動
app.listen(10000, () => {
  console.log("Web Service started on port 10000");
});
