// server.js
const express = require("express");
const app = express();

const pickupMonitor = require("./pickup-monitor.js");

app.get("/run-pickup", async (req, res) => {
  try {
    await pickupMonitor();
    res.send("pickup-monitor done");
  } catch (e) {
    console.error(e);
    res.status(500).send(e.toString());
  }
});

app.listen(10000, () => {
  console.log("Web Service started on port 10000");
});
