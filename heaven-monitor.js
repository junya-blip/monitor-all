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
   正規化（表記ゆれ吸収）
=============================== */
function normalizeTime(t) {
  if (!t) return "-";
  return t
    .replace(/&nbsp;/g, "")
    .replace(/\s+/g, "")
    .replace(/〜|～/g, "-")
    .trim();
}

function normalizeDate(d) {
  return d
    .replace(/\(.+\)/, "")  // "(木)" "(金)" "(土)" を除去
    .replace(/\s+/g, "")
    .trim();
}

/* ===============================
   出勤予定整形（★マークは廃止）
=============================== */
function formatSchedule(schedule) {
  return schedule.map(s => `${s.date} ${s.time}`).join("\n");
}

/* ===============================
   差分判定（集合比較）
=============================== */
function diffSchedule(newList, oldList) {
  const oldMap = new Map(oldList.map(s => [normalizeDate(s.date), normalizeTime(s.time)]));
  const newMap = new Map(newList.map(s => [normalizeDate(s.date), normalizeTime(s.time)]));

  const diffs = [];

  // new にある日付 → 追加 or 時間変更
  for (const [date, time] of newMap.entries()) {
    if (!oldMap.has(date)) {
      diffs.push({ date, time, type: "added" });
    } else if (oldMap.get(date) !== time) {
      diffs.push({ date, time, type: "changed" });
    }
  }

  // old にあるが new にない日付 → 削除
  for (const [date, time] of oldMap.entries()) {
    if (!newMap.has(date)) {
      diffs.push({ date, time, type: "removed" });
    }
  }

  return diffs;
}

/* ===============================
   最後の出勤日 index
=============================== */
function getLastWorkingIndex(schedule) {
  let lastIndex = -1;
  schedule.forEach((s, i) => {
    const t = normalizeTime(s.time);
    if (t !== "-" && t !== "") {
      lastIndex = i;
    }
  });
  return lastIndex;
}

/* ===============================
   過去日を除外
=============================== */
function filterFuture(schedule) {
  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth() + 1;
  const todayD = today.getDate();

  return schedule.filter(s => {
    // "7/23(木)" → "7/23"
    const dateStr = s.date.replace(/\(.+\)/, "");
    const [m, d] = dateStr.split("/").map(Number);

    const sDate = new Date(todayY, m - 1, d);
    const todayDate = new Date(todayY, todayM - 1, todayD);

    return sDate >= todayDate;
  });
}

/* ===============================
   出勤表取得（1か月分）
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

    const rawTime = $(el).find(".girlitem_waku_right").html() || "";
    const time = normalizeTime(rawTime.replace(/<[^>]+>/g, "").trim());

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
    let oldNoSchedule = false;

    if (fs.existsSync(saveFile)) {
      const raw = JSON.parse(fs.readFileSync(saveFile, "utf8"));
      oldSchedule = raw.schedule || [];
      oldNoSchedule = raw.noSchedule || false;
    }

    /* ===============================
       ★ 全日 "-" の特別判定（出勤予定なし）
    ================================ */
    const allDash = newSchedule.every(s => normalizeTime(s.time) === "-");
    const oldAllDash =
      oldNoSchedule ||
      oldSchedule.length === 0 ||
      oldSchedule.every(s => normalizeTime(s.time) === "-");

    if (allDash && oldAllDash) {
      console.log(`変更なし（出勤予定なし継続）: ${cast.name}`);
      continue;
    }

    if (allDash && !oldAllDash) {
      console.log(`変更あり（出勤予定なしに変化）: ${cast.name}`);

      const saveData = {
        schedule: [],
        noSchedule: true,
        lastNoticeTime: getJSTTime()
      };
      fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));

      await sendDiscord(`【出勤表更新】${cast.name}\n\n出勤予定なし`);
      continue;
    }

    /* ===============================
       ★ ヘブン側の「出勤予定が入っている最後の日」まで抽出
    ================================ */
    const lastIndex = getLastWorkingIndex(newSchedule);
    const newRange = lastIndex >= 0 ? newSchedule.slice(0, lastIndex + 1) : newSchedule;

    /* ===============================
       ★ 過去日を除外して差分判定
    ================================ */
    const oldFuture = filterFuture(oldSchedule);
    const newFuture = filterFuture(newRange);

    const diffs = diffSchedule(newFuture, oldFuture);

    if (diffs.length === 0) {
      console.log(`変更なし（未来分に変化なし）: ${cast.name}`);
      continue;
    }

    console.log(`変更あり（未来分に変化）: ${cast.name}`);

    /* ===============================
       ★ 通知内容は newRange（最後の日まで）
    ================================ */
    const notifyText = formatSchedule(newRange);

    await sendDiscord(`【出勤表更新】${cast.name}\n\n${notifyText}`);

    /* ===============================
       ★ 保存（newSchedule 全体）
    ================================ */
	const saveData = {
	  schedule: newRange,   // ★ newSchedule → newRange に変更
	  noSchedule: false,
	  lastNoticeTime: getJSTTime()
	};
	fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));
  }

  console.log("heaven-monitor 完了:", getJSTTime());
};
