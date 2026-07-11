console.log("=== 統合監視開始 ===");

const fs = require("fs");
const path = require("path");

function logPickupLast(label) {
  try {
    const file = path.join(__dirname, "data", "pickup-last.json");
    const content = fs.readFileSync(file, "utf-8");
    console.log(`[DEBUG] pickup-last.json の内容 (${label}):`, content);
  } catch (e) {
    console.log(`[DEBUG] pickup-last.json 読み込み失敗 (${label}):`, e.message);
  }
}

logPickupLast("before");

async function main() {
  const heaven = require("./heaven-monitor.js");
  const pickup = require("./pickup-monitor.js");
  const bg = require("./bg-monitor.js");
  const yuuri = require("./yuuri-monitor.js");

  await runTask("heaven-monitor", heaven);
  await runTask("pickup-monitor", pickup);

  // ★ ここで再度確認
  logPickupLast("after pickup-monitor");

  await runTask("bg-monitor", bg);
  await runTask("yuuri-monitor", yuuri);

  console.log("=== 全監視処理完了 ===");
}
