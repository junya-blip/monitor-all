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
   正規化（不可視文字完全除去）
=============================== */
function normalizeTime(t) {
  if (!t) return "-";
  return t
    .replace(/&nbsp;/g, "")
    .replace(/\u00A0/g, "")
    .replace(/[\u2000-\u200F]/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, "")
    .replace(/〜|～/g, "-")
    .trim();
}

function normalizeDate(d) {
  return d
    .replace(/\u00A0/g, "")
    .replace(/[\u2000-\u200F]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/*
 * 表示・保存用の日付正規化
 * 曜日は残し、余計な空白や不可視文字だけ除去する
 */
function normalizeDisplayDate(d) {
  if (!d) return "";

  return String(d)
    .replace(/\u00A0/g, "")
    .replace(/[\u2000-\u200F]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/* ===============================
   出勤予定整形
   差分がある日付の行頭に「★」を付ける
=============================== */
function formatSchedule(schedule, diffs = [], oldSchedule = []) {
  /*
   * 追加・時間変更された日付
   */
  const changedDates = new Set(
    diffs
      .filter(diff =>
        diff.type === "added" ||
        diff.type === "changed"
      )
      .map(diff => normalizeDate(diff.date))
  );

  const lines = schedule.map(item => {
    const dateKey = normalizeDate(item.date);
    const mark = changedDates.has(dateKey) ? "★" : "";

    return `${mark}${item.date} ${item.time}`;
  });

  /*
   * 新しい出勤表から日付自体が消えた場合は、
   * 現在の一覧に行が存在しないため末尾へ「削除」と表示する。
   */
  const removedLines = diffs
    .filter(diff => diff.type === "removed")
    .map(diff => {
      const oldItem = oldSchedule.find(
        item =>
          normalizeDate(item.date) ===
          normalizeDate(diff.date)
      );

      const displayDate = oldItem?.date || diff.date;

      return `★${displayDate} 削除`;
    });

  return [...lines, ...removedLines].join("\n");
}

/* ===============================
   差分判定（未来日だけ比較）
=============================== */
function diffSchedule(newList, oldList) {
  const oldMap = new Map(
    oldList.map(s => [normalizeDate(s.date), normalizeTime(s.time)])
  );
  const newMap = new Map(
    newList.map(s => [normalizeDate(s.date), normalizeTime(s.time)])
  );

  const diffs = [];

  for (const [date, time] of newMap.entries()) {
    if (!oldMap.has(date)) {
      diffs.push({ date, time, type: "added" });
    } else if (oldMap.get(date) !== time) {
      diffs.push({ date, time, type: "changed" });
    }
  }

  for (const [date, time] of oldMap.entries()) {
    if (!newMap.has(date)) {
      diffs.push({ date, time, type: "removed" });
    }
  }

  return diffs;
}

/* ===============================
   最後の出勤日 index（time が "-" 以外）
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
   過去日を除外（JST基準で今日以降だけ残す）
=============================== */
function filterFuture(schedule) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const todayY = jst.getUTCFullYear();
  const todayM = jst.getUTCMonth() + 1;
  const todayD = jst.getUTCDate();

  const todayValue = todayY * 10000 + todayM * 100 + todayD;

  return schedule.filter(s => {
    if (!s || !s.date) {
      return false;
    }

    const dateStr = String(s.date)
      .replace(/\u00A0/g, "")
      .replace(/[\u2000-\u200F]/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, "")
      .trim();

    const [m, d] = dateStr.split("/").map(Number);

    if (!Number.isFinite(m) || !Number.isFinite(d)) {
      console.log(`日付解析失敗: ${s.date}`);
      return false;
    }

    let scheduleY = todayY;

    // 12月に表示される1月分は翌年
    if (todayM === 12 && m === 1) {
      scheduleY = todayY + 1;
    }

    // 1月に残っている12月分は前年
    if (todayM === 1 && m === 12) {
      scheduleY = todayY - 1;
    }

    const scheduleValue = scheduleY * 10000 + m * 100 + d;

    return scheduleValue >= todayValue;
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
       出勤予定なし判定
=============================== */
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
       ★ 仕様どおり：最後の出勤時間が入っている日まで抽出
=============================== */
    const lastIndex = getLastWorkingIndex(newSchedule);
    const newRange =
      lastIndex >= 0 ? newSchedule.slice(0, lastIndex + 1) : [];

    /* ===============================
       過去日を除外（未来日だけ比較）
=============================== */
    const oldFuture = filterFuture(oldSchedule);
    const newFuture = filterFuture(newRange);

    const diffs = diffSchedule(newFuture, oldFuture);

	if (diffs.length === 0) {
	  console.log(`変更なし（未来分に変化なし）: ${cast.name}`);

	  /*
	   * 通知対象の変更はないが、曜日などの表示情報は最新状態で保存する。
	   * lastNoticeTimeは変更しない。
	   */
	  const refreshedSchedule = newFuture.map(s => ({
	    date: normalizeDisplayDate(s.date),
	    time: normalizeTime(s.time)
	  }));

	  let previousLastNoticeTime = null;

	  if (fs.existsSync(saveFile)) {
	    try {
	      const previousData = JSON.parse(fs.readFileSync(saveFile, "utf8"));
	      previousLastNoticeTime = previousData.lastNoticeTime || null;
	    } catch (e) {
	      console.log(`既存データ読み込み失敗: ${cast.name}`, e.message);
	    }
	  }

	  const saveData = {
	    schedule: refreshedSchedule,
	    noSchedule: false,
	    lastNoticeTime: previousLastNoticeTime
	  };

	  fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));
	  continue;
	}

    console.log(`変更あり（未来分に変化）: ${cast.name}`);

    const normalizedFuture = newFuture.map(s => ({
      date: normalizeDisplayDate(s.date),
      time: normalizeTime(s.time)
    }));

	const notifyText = formatSchedule(
	  normalizedFuture,
	  diffs,
	  oldFuture
	);

    await sendDiscord(`【出勤表更新】${cast.name}\n\n${notifyText}`);

    const saveData = {
      schedule: normalizedFuture,
      noSchedule: false,
      lastNoticeTime: getJSTTime()
    };
    fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));
  }

  console.log("heaven-monitor 完了:", getJSTTime());
};
