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

// ★★★ これが絶対に必要（今の run-all.js には無い） ★★★
async function runTask(name, func) {
  console.log(`\n===== ${name} 開始 =====`);
  try {
    await func();
    console.log(`===== ${name} 完了 =====\n`);
  } catch (e) {
    console.log(`===== ${name} エラー発生 =====`);
    console.log(e);
  }
}

async function main() {
  try {
    console.log("=== require 開始 ===");

    const heaven = require("./heaven-monitor.js");
    console.log("heaven-monitor.js 読み込み成功");

    const pickup = require("./pickup-monitor.js");
    console.log("pickup-monitor.js 読み込み成功");

    const bg = require("./bg-monitor.js");
    console.log("bg-monitor.js 読み込み成功");

    const yuuri = require("./yuuri-monitor.js");
    console.log("yuuri-monitor.js 読み込み成功");

    console.log("=== require 完了 ===");

    await runTask("heaven-monitor", heaven);
    await runTask("pickup-monitor", pickup);

    logPickupLast("after pickup-monitor");

    await runTask("bg-monitor", bg);
    await runTask("yuuri-monitor", yuuri);

    console.log("=== 全監視処理完了 ===");
  } catch (e) {
    console.log("【FATAL】run-all.js 内で例外発生:", e);
  }
}

main();
