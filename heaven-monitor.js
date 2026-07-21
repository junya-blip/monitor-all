const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const casts = JSON.parse(fs.readFileSync(path.join(__dirname, "cast.json"), "utf8"));
const TOKEN = process.env.LINE_TOKEN;
const USER_ID = process.env.LINE_USER_ID;

/* ===============================
   JST固定の時刻
=============================== */
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

/* ===============================
   Discord通知
=============================== */
async function sendDiscord(message) {
  try {
    await axios.post(process.env.DISCORD_WEBHOOK_URL, {
      content: message
    });
  } catch (err) {
    console.error("Discord通知エラー:", err.response?.data || err);
  }
}

/* ===============================
   正規化
=============================== */
function normalize(text) {
  return (text || "")
    .replace(/\s+/g, "")
    .replace(/　+/g, "")
    .trim();
}

/* ===============================
   LINE通知（来月復活用）
=============================== */
async function sendLine(message) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: USER_ID,
      messages: [{ type: "text", text: message }]
    },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

/* ===============================
   出勤予定整形
=============================== */
function formatSchedule(schedule) {
  return schedule
    .map(s => `${s.updated ? "★ " : ""}${s.date}  ${s.time}`)
    .join("\n");
}

/* ===============================
   差分判定（完全比較版）
=============================== */
function markUpdatedScheduleByDate(newSchedule, oldSchedule) {
  const oldMap = {};
  oldSchedule.forEach(s => {
    oldMap[normalize(s.date)] = normalize(s.time);
  });

  return newSchedule.map(s => {
    const dateNorm = normalize(s.date);
    const timeNorm = normalize(s.time);

    const oldTime = oldMap[dateNorm];

    // ★ 時間が追加・変更・削除されたら updated = true
    const changed = oldTime !== timeNorm;

    return {
      date: s.date,
      time: s.time,
      updated: changed
    };
  });
}

/* ===============================
   出勤表取得
=============================== */
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

/* ===============================
   メイン処理
=============================== */
module.exports = async function () {
  console.log("heaven-monitor 開始:", getJSTTime());

  for (const cast of casts) {
    console.log(`チェック中: ${cast.name}`);

    const newSchedule = await fetchSchedule(cast.url);

    const saveFile = path.join(__dirname, "data", `heaven-last-${cast.name}.json`);

    let oldSchedule = [];
    if (fs.existsSync(saveFile)) {
      const raw = JSON.parse(fs.readFileSync(saveFile, "utf8"));
      oldSchedule = raw.schedule || raw;
    }

    // ★ 全日付を比較対象にする（trimしない）
    const marked = markUpdatedScheduleByDate(newSchedule, oldSchedule);

    const hasUpdate = marked.some(s => s.updated);

    if (hasUpdate) {
      console.log(`変更あり: ${cast.name}`);

      const saveData = {
        schedule: newSchedule,
        lastNoticeTime: getJSTTime()
      };

      fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));

      const scheduleText = formatSchedule(marked);

      await sendDiscord(`【出勤表更新】${cast.name}\n\n${scheduleText}`);

    } else {
      console.log(`変更なし: ${cast.name}`);
    }
  }

  console.log("heaven-monitor 完了:", getJSTTime());
};
