console.log("=== 統合監視開始 ===");

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
  const heaven = require("./heaven-monitor.js");
  const pickup = require("./pickup-monitor.js");
  const bg = require("./bg-monitor.js");
  const yuuri = require("./yuuri-monitor.js");

  await runTask("heaven-monitor", heaven);
  await runTask("pickup-monitor", pickup);
  await runTask("bg-monitor", bg);
  await runTask("yuuri-monitor", yuuri);

  console.log("=== 全監視処理完了 ===");
}

main();
