const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const casts = JSON.parse(fs.readFileSync(path.join(__dirname, "cast.json"), "utf8"));
const TOKEN = process.env.LINE_TOKEN;
const USER_ID = process.env.LINE_USER_ID;

/* ★★★★★ JST固定の時刻を返す関数（ズレない） ★★★★★ */
function getJSTTime() {
  const date = new Date();
  const jst = new Date(date.getTime() + (9 * 60 * 60 * 1000)); // UTC → JST

  const yyyy = jst.getFullYear();
  const mm = String(jst.getMonth() + 1).padStart(2, '0');
  const dd = String(jst.getDate()).padStart(2, '0');

  const hh = String(jst.getHours()).padStart(2, '0');
  const mi = String(jst.getMinutes()).padStart(2, '0');
  const ss = String(jst.getSeconds()).padStart(2, '0');

  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}
/* ★★★★★ ここまで ★★★★★ */

// LINE Messaging API
async function sendLine(message) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: USER_ID,
      messages: [
        {
          type: "text",
          text: message
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ★ 出勤予定を整形する関数（行頭★対応）
function formatSchedule(schedule) {
  return schedule
    .map(s => `${s.updated ? "★ " : ""}${s.date}  ${s.time}`)
    .join("\n");
}

// ★ 日付キーで差分判定する新ロジック
function markUpdatedScheduleByDate(newSchedule, oldSchedule) {
  const oldMap = {};
  oldSchedule.forEach(s => {
    oldMap[s.date] = s.time;
  });

  return newSchedule.map(s => {
    const oldTime = oldMap[s.date];
    const changed = !oldTime || oldTime !== s.time; // 新規 or 時間変更

    return {
      date: s.date,
      time: s.time,
      updated: changed
    };
  });
}

// ★ 出勤時間が入っている最後の index を取得
function getLastWorkingIndex(schedule) {
  let lastIndex = -1;
  schedule.forEach((s, i) => {
    if (s.time && s.time !== "-" && s.time !== "") {
      lastIndex = i;
    }
  });
  return lastIndex;
}

// 出勤表取得
async function fetchSchedule(url) {
  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15A372 Safari/604.1"
    }
  });

  const $ = cheerio.load(res.data);
  const schedule = [];

  $("#syukin_month .girlitem_waku").each((i, el) => {
    const date = $(el).find(".girlitem_waku_left").text().trim();
    const time = $(el).find(".girlitem_waku_right").text().trim();

    schedule.push({ date, time });
  });

  return schedule;
}

// メイン処理
async function main() {
  for (const cast of casts) {
    console.log(`チェック中: ${cast.name}`);

    const newSchedule = await fetchSchedule(cast.url);

    // ★ 統合フォルダ用の保存先
    const saveFile = path.join(__dirname, "data", `heaven-last-${cast.name}.json`);

    // ★ 新旧形式どちらにも対応して読み込む
    let oldSchedule = [];
    if (fs.existsSync(saveFile)) {
      const raw = JSON.parse(fs.readFileSync(saveFile, "utf8"));
      oldSchedule = raw.schedule || raw;
    }

    // ★ 出勤時間が入っている最後の日付までに切り取る
    const lastIndex = getLastWorkingIndex(newSchedule);
    const trimmedNew = lastIndex >= 0 ? newSchedule.slice(0, lastIndex + 1) : [];

    // ★ 差分判定
    const marked = markUpdatedScheduleByDate(trimmedNew, oldSchedule);
    const hasUpdate = marked.some(s => s.updated);

    if (hasUpdate) {
      console.log(`変更あり: ${cast.name}`);

      const lastNoticeTime = getJSTTime();

      const saveData = {
        schedule: newSchedule,
        lastNoticeTime
      };

      fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));

      const scheduleText = formatSchedule(marked);

      await sendLine(
        `【出勤表更新】${cast.name}\n\n${scheduleText}`
      );

    } else {
      console.log(`変更なし: ${cast.name}`);
    }
  }
}

module.exports = main;
