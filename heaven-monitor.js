const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const {
  notify
} = require("./common/notifier");

const {
  getJSTDate,
  getJSTTime
} = require("./common/time");

const casts = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "cast.json"),
    "utf8"
  )
);

/* ===============================
   正規化（不可視文字完全除去）
=============================== */
function normalizeTime(t) {
  if (!t) {
    return "-";
  }

  return String(t)
    .replace(/&nbsp;/g, "")
    .replace(/\u00A0/g, "")
    .replace(/[\u2000-\u200F]/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, "")
    .replace(/〜|～/g, "-")
    .trim();
}

function normalizeDate(d) {
  return String(d || "")
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
  if (!d) {
    return "";
  }

  return String(d)
    .replace(/\u00A0/g, "")
    .replace(/[\u2000-\u200F]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/* ===============================
   M/D形式の日付を比較用タイムスタンプへ変換
=============================== */
function scheduleDateToTimestamp(dateText) {
  const normalized =
    normalizeDate(dateText);

  const match = normalized.match(
    /^(\d{1,2})\/(\d{1,2})$/
  );

  if (!match) {
    return null;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);

  const jst = getJSTDate();

  let year =
    jst.getUTCFullYear();

  const currentMonth =
    jst.getUTCMonth() + 1;

  /*
   * 年末に翌年1月・2月が掲載された場合
   */
  if (
    currentMonth >= 11 &&
    month <= 2
  ) {
    year += 1;
  }

  /*
   * 年始に前年12月が残っている場合
   */
  if (
    currentMonth <= 2 &&
    month >= 11
  ) {
    year -= 1;
  }

  return Date.UTC(
    year,
    month - 1,
    day
  );
}

/* ===============================
   出勤予定整形
   差分がある日付の行頭に「★」を付ける
=============================== */
function formatSchedule(
  schedule,
  diffs = [],
  oldSchedule = []
) {
  /*
   * 追加・時間変更された日付
   */
  const changedDates = new Set(
    diffs
      .filter(diff =>
        diff.type === "added" ||
        diff.type === "changed"
      )
      .map(diff =>
        normalizeDate(diff.date)
      )
  );

  const lines = schedule.map(item => {
    const dateKey =
      normalizeDate(item.date);

    const mark =
      changedDates.has(dateKey)
        ? "★"
        : "";

    return (
      `${mark}${item.date} ${item.time}`
    );
  });

  /*
   * 今回表示されている最後の日付
   */
  const latestNewDate =
    schedule.reduce(
      (latest, item) => {
        const value =
          scheduleDateToTimestamp(
            item.date
          );

        if (value === null) {
          return latest;
        }

        return (
          latest === null ||
          value > latest
        )
          ? value
          : latest;
      },
      null
    );

  /*
   * 削除表示は、今回の最終日以前だけ
   */
  const removedLines = diffs
    .filter(
      diff =>
        diff.type === "removed"
    )
    .map(diff => {
      const oldItem =
        oldSchedule.find(
          item =>
            normalizeDate(item.date) ===
            normalizeDate(diff.date)
        );

      const displayDate =
        oldItem?.date ||
        diff.date;

      const removedDate =
        scheduleDateToTimestamp(
          displayDate
        );

      if (
        removedDate === null ||
        latestNewDate === null ||
        removedDate > latestNewDate
      ) {
        return null;
      }

      return (
        `★${displayDate} 削除`
      );
    })
    .filter(Boolean);

  return [
    ...lines,
    ...removedLines
  ].join("\n");
}

/* ===============================
   差分判定（未来日だけ比較）
=============================== */
function diffSchedule(
  newList,
  oldList
) {
  const oldMap = new Map(
    oldList.map(s => [
      normalizeDate(s.date),
      normalizeTime(s.time)
    ])
  );

  const newMap = new Map(
    newList.map(s => [
      normalizeDate(s.date),
      normalizeTime(s.time)
    ])
  );

  const diffs = [];

  for (
    const [date, time]
    of newMap.entries()
  ) {
    if (!oldMap.has(date)) {
      diffs.push({
        date,
        time,
        type: "added"
      });
    } else if (
      oldMap.get(date) !== time
    ) {
      diffs.push({
        date,
        time,
        type: "changed"
      });
    }
  }

  for (
    const [date, time]
    of oldMap.entries()
  ) {
    if (!newMap.has(date)) {
      diffs.push({
        date,
        time,
        type: "removed"
      });
    }
  }

  return diffs;
}

/* ===============================
   最後の出勤日 index
   time が "-" 以外
=============================== */
function getLastWorkingIndex(schedule) {
  let lastIndex = -1;

  schedule.forEach((s, i) => {
    const t =
      normalizeTime(s.time);

    if (
      t !== "-" &&
      t !== ""
    ) {
      lastIndex = i;
    }
  });

  return lastIndex;
}

/* ===============================
   過去日を除外
   JST基準で今日以降だけ残す
=============================== */
function filterFuture(schedule) {
  const jst =
    getJSTDate();

  const todayY =
    jst.getUTCFullYear();

  const todayM =
    jst.getUTCMonth() + 1;

  const todayD =
    jst.getUTCDate();

  const todayValue =
    todayY * 10000 +
    todayM * 100 +
    todayD;

  return schedule.filter(s => {
    if (!s || !s.date) {
      return false;
    }

    const dateStr =
      normalizeDate(s.date);

    const [m, d] =
      dateStr
        .split("/")
        .map(Number);

    if (
      !Number.isFinite(m) ||
      !Number.isFinite(d)
    ) {
      console.log(
        `日付解析失敗: ${s.date}`
      );

      return false;
    }

    let scheduleY =
      todayY;

    /*
     * 12月に表示される1月分は翌年
     */
    if (
      todayM === 12 &&
      m === 1
    ) {
      scheduleY =
        todayY + 1;
    }

    /*
     * 1月に残っている12月分は前年
     */
    if (
      todayM === 1 &&
      m === 12
    ) {
      scheduleY =
        todayY - 1;
    }

    const scheduleValue =
      scheduleY * 10000 +
      m * 100 +
      d;

    return (
      scheduleValue >=
      todayValue
    );
  });
}

/* ===============================
   出勤表取得
=============================== */
async function fetchSchedule(url) {
  const res = await axios.get(
    url,
    {
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
          "Version/14.0 Mobile/15A372 Safari/604.1"
      }
    }
  );

  const $ =
    cheerio.load(res.data);

  const schedule = [];

  $(
    "#syukin_month .girlitem_waku"
  ).each((_, el) => {
    const date = $(el)
      .find(".girlitem_waku_left")
      .text()
      .trim();

    const rawTime =
      $(el)
        .find(".girlitem_waku_right")
        .html() || "";

    const time = normalizeTime(
      rawTime
        .replace(/<[^>]+>/g, "")
        .trim()
    );

    schedule.push({
      date,
      time
    });
  });

  return schedule;
}

/* ===============================
   保存データ読み込み
=============================== */
function loadCastData(saveFile) {
  try {
    const raw = JSON.parse(
      fs.readFileSync(
        saveFile,
        "utf8"
      )
    );

    return {
      schedule:
        Array.isArray(raw.schedule)
          ? raw.schedule
          : [],
      noSchedule:
        raw.noSchedule || false,
      lastNoticeTime:
        raw.lastNoticeTime || null
    };
  } catch {
    return {
      schedule: [],
      noSchedule: false,
      lastNoticeTime: null
    };
  }
}

/* ===============================
   保存データ書き込み
=============================== */
function saveCastData(
  saveFile,
  data
) {
  fs.writeFileSync(
    saveFile,
    JSON.stringify(
      data,
      null,
      2
    )
  );
}

/* ===============================
   キャスト単位の監視
=============================== */
async function checkCast(cast) {
  console.log(
    `チェック中: ${cast.name}`
  );

  const newSchedule =
    await fetchSchedule(
      cast.url
    );

  /*
   * HTML変更や取得異常により
   * 日付行自体が0件だった場合は、
   * 状態を上書きしない。
   */
  if (newSchedule.length === 0) {
    console.log(
      `出勤表を取得できないため更新を中止: ${cast.name}`
    );

    return;
  }

  const saveFile = path.join(
    __dirname,
    "data",
    `heaven-last-${cast.name}.json`
  );

  const previous =
    loadCastData(saveFile);

  const oldSchedule =
    previous.schedule;

  const oldNoSchedule =
    previous.noSchedule;

  /* ===============================
     出勤予定なし判定
  =============================== */
  const allDash =
    newSchedule.every(
      s =>
        normalizeTime(s.time) === "-"
    );

  const oldAllDash =
    oldNoSchedule ||
    oldSchedule.length === 0 ||
    oldSchedule.every(
      s =>
        normalizeTime(s.time) === "-"
    );

  if (
    allDash &&
    oldAllDash
  ) {
    console.log(
      `変更なし（出勤予定なし継続）: ${cast.name}`
    );

    return;
  }

  if (
    allDash &&
    !oldAllDash
  ) {
    console.log(
      `変更あり（出勤予定なしに変化）: ${cast.name}`
    );

    const message =
      `【出勤表更新】${cast.name}\n\n` +
      "出勤予定なし";

    /*
     * 通知成功後に保存する。
     * 通知失敗時はnotify()が例外を投げるため、
     * 保存されず次回再試行される。
     */
    await notify(message);

    saveCastData(
      saveFile,
      {
        schedule: [],
        noSchedule: true,
        lastNoticeTime:
          getJSTTime()
      }
    );

    return;
  }

  /* ===============================
     最後の出勤時間が入っている日まで抽出
  =============================== */
  const lastIndex =
    getLastWorkingIndex(
      newSchedule
    );

  const newRange =
    lastIndex >= 0
      ? newSchedule.slice(
          0,
          lastIndex + 1
        )
      : [];

  /* ===============================
     過去日を除外
     未来日だけ比較
  =============================== */
  const oldFuture =
    filterFuture(oldSchedule);

  const newFuture =
    filterFuture(newRange);

  const diffs =
    diffSchedule(
      newFuture,
      oldFuture
    );

  if (diffs.length === 0) {
    console.log(
      `変更なし（未来分に変化なし）: ${cast.name}`
    );

    /*
     * 通知対象の変更はないが、
     * 曜日などの表示情報は最新状態で保存する。
     * lastNoticeTimeは変更しない。
     */
    const refreshedSchedule =
      newFuture.map(s => ({
        date:
          normalizeDisplayDate(
            s.date
          ),
        time:
          normalizeTime(s.time)
      }));

    saveCastData(
      saveFile,
      {
        schedule:
          refreshedSchedule,
        noSchedule: false,
        lastNoticeTime:
          previous.lastNoticeTime
      }
    );

    return;
  }

  console.log(
    `変更あり（未来分に変化）: ${cast.name}`
  );

  const normalizedFuture =
    newFuture.map(s => ({
      date:
        normalizeDisplayDate(
          s.date
        ),
      time:
        normalizeTime(s.time)
    }));

  const notifyText =
    formatSchedule(
      normalizedFuture,
      diffs,
      oldFuture
    );

  const message =
    `【出勤表更新】${cast.name}\n\n` +
    notifyText;

  /*
   * NOTIFY_MODE=line
   *   → LINE通知
   *
   * NOTIFY_MODE=discord
   *   → Discord通知
   */
  await notify(message);

  /*
   * 通知成功後に保存する。
   */
  saveCastData(
    saveFile,
    {
      schedule:
        normalizedFuture,
      noSchedule: false,
      lastNoticeTime:
        getJSTTime()
    }
  );
}

/* ===============================
   メイン処理
=============================== */
async function runHeavenMonitor() {
  console.log(
    "heaven-monitor 開始:",
    getJSTTime()
  );

  /*
   * 1人が失敗しても、
   * 残りのキャスト監視を続行する。
   */
  for (const cast of casts) {
    try {
      await checkCast(cast);
    } catch (err) {
      console.error(
        `heaven-monitor エラー（${cast.name}）:`,
        err.response?.data ||
          err.message ||
          err
      );
    }
  }

  console.log(
    "heaven-monitor 完了:",
    getJSTTime()
  );
}

module.exports =
  runHeavenMonitor;

/* ===============================
   単体実行用
   node heaven-monitor.js
=============================== */
if (require.main === module) {
  runHeavenMonitor().catch(err => {
    console.error(
      "heaven-monitor 実行エラー:",
      err.response?.data ||
        err.message ||
        err
    );

    process.exitCode = 1;
  });
}