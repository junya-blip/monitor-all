const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const CURRENT_URL =
  "https://www.aventure-uh.jp/umeda/girls/?data[pickup]=Y";

const NEXT_URL =
  "https://www.aventure-uh.jp/umeda/top/";

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
   JSTの現在日時
=============================== */
function getJSTDate() {
  const now = new Date();

  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

/* ===============================
   日付表示
=============================== */
function formatMonthDay(date) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const weekday = weekdays[date.getUTCDay()];

  return `${month}/${day}(${weekday})`;
}

/* ===============================
   今週（月曜～日曜）の期間
=============================== */
function getCurrentWeekPeriod() {
  const jst = getJSTDate();

  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth();
  const day = jst.getUTCDate();

  const today = new Date(Date.UTC(year, month, day));

  // 日曜=0、月曜=1
  const weekday = today.getUTCDay();

  // 今週月曜まで戻す
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;

  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - daysFromMonday);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return `${formatMonthDay(monday)}～${formatMonthDay(sunday)}`;
}

/* ===============================
   Discord通知
=============================== */
async function sendDiscord(message) {
  try {
    await axios.post(process.env.DISCORD_WEBHOOK_URL, {
      content: message
    });

    return true;
  } catch (err) {
    console.error(
      "Discord通知エラー:",
      err.response?.data || err.message || err
    );

    return false;
  }
}

/* ===============================
   文字列整形
=============================== */
function normalizeText(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2000-\u200F]/g, "")
    .replace(/\r/g, "")
    .trim();
}

/* ===============================
   重複除去
=============================== */
function uniqueNames(names) {
  return [
    ...new Set(
      names
        .map(name => normalizeText(name))
        .filter(Boolean)
    )
  ].sort((a, b) => a.localeCompare(b, "ja"));
}

/* ===============================
   今週のピックアップ取得
=============================== */
async function fetchCurrentPickup() {
  const res = await axios.get(CURRENT_URL, {
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0 pickup-monitor"
    }
  });

  const $ = cheerio.load(res.data);

  const names = [];

  $("span.name a").each((_, element) => {
    const name = normalizeText($(element).text());

    if (name) {
      names.push(name);
    }
  });

  return {
    period: getCurrentWeekPeriod(),
    names: uniqueNames(names)
  };
}

/* ===============================
   次週情報の抽出
=============================== */
function extractNextPickup(html) {
  const $ = cheerio.load(html);

  const candidates = [];

  /*
   * 「7/27(月)～8/2(日)までの対象奥様はこちら」
   * を含む要素から、期間と『名前』奥様を取得する。
   */
  $("div, p, span, strong").each((_, element) => {
    const text = normalizeText($(element).text())
      .replace(/\s+/g, "");

    const periodMatch = text.match(
      /(\d{1,2}\/\d{1,2}\([日月火水木金土]\)[～〜～-]\d{1,2}\/\d{1,2}\([日月火水木金土]\))までの対象奥様はこちら/
    );

    if (!periodMatch) {
      return;
    }

    const names = [
      ...text.matchAll(/『([^』]+)』奥様/g)
    ].map(match => match[1]);

    if (names.length > 0) {
      candidates.push({
        period: periodMatch[1]
          .replace(/[〜～]/g, "～"),
        names: uniqueNames(names),
        textLength: text.length
      });
    }
  });

  /*
   * 同じ内容が親要素にも含まれるため、
   * 最も短い＝対象部分に近い要素を優先する。
   */
  candidates.sort((a, b) => a.textLength - b.textLength);

  if (candidates.length > 0) {
    return {
      period: candidates[0].period,
      names: candidates[0].names
    };
  }

  /*
   * HTML構造が多少変わった場合のフォールバック。
   */
  const bodyText = normalizeText($("body").text())
    .replace(/\s+/g, "");

  const periodMatch = bodyText.match(
    /(\d{1,2}\/\d{1,2}\([日月火水木金土]\)[～〜～-]\d{1,2}\/\d{1,2}\([日月火水木金土]\))までの対象奥様はこちら/
  );

  if (!periodMatch) {
    return {
      period: "",
      names: []
    };
  }

  const startIndex = periodMatch.index || 0;

  // 対象箇所の後ろだけを切り出す
  const targetText = bodyText.slice(
    startIndex,
    startIndex + 2000
  );

  const names = [
    ...targetText.matchAll(/『([^』]+)』奥様/g)
  ].map(match => match[1]);

  return {
    period: periodMatch[1].replace(/[〜～]/g, "～"),
    names: uniqueNames(names)
  };
}

/* ===============================
   次週のピックアップ取得
=============================== */
async function fetchNextPickup() {
  try {
    const res = await axios.get(NEXT_URL, {
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0 pickup-monitor"
      }
    });

    const result = extractNextPickup(res.data);

    if (result.names.length === 0) {
      console.log("次週ピックアップ情報なし");
    } else {
      console.log(
        `次週ピックアップ取得: ${result.period} / ${result.names.join(", ")}`
      );
    }

    return result;
  } catch (err) {
    /*
     * 次週ページだけの取得失敗で、今週分まで止めない。
     * ただし取得失敗時は null を返し、既存の次週情報を消さない。
     */
    console.error(
      "次週ピックアップ取得エラー:",
      err.response?.status || err.message || err
    );

    return null;
  }
}

/* ===============================
   last.json 読み込み
=============================== */
function loadLast(saveFile) {
  try {
    const raw = JSON.parse(
      fs.readFileSync(saveFile, "utf8")
    );

    /*
     * 新形式
     */
    if (raw.current || raw.next) {
      return {
        current: {
          period: raw.current?.period || "",
          names: Array.isArray(raw.current?.names)
            ? raw.current.names
            : []
        },
        next: {
          period: raw.next?.period || "",
          names: Array.isArray(raw.next?.names)
            ? raw.next.names
            : []
        },
        lastNoticeTime: raw.lastNoticeTime || null,
        legacy: false
      };
    }

    /*
     * 旧形式との互換性
     */
    return {
      current: {
        period: raw.period || "",
        names: Array.isArray(raw.names)
          ? raw.names
          : []
      },
      next: {
        period: "",
        names: []
      },
      lastNoticeTime: raw.lastNoticeTime || null,
      legacy: true
    };
  } catch {
    return {
      current: {
        period: "",
        names: []
      },
      next: {
        period: "",
        names: []
      },
      lastNoticeTime: null,
      legacy: false
    };
  }
}

/* ===============================
   last.json 保存
=============================== */
function saveLast(
  saveFile,
  current,
  next,
  lastNoticeTime
) {
  const data = {
    current,
    next,
    lastNoticeTime
  };

  fs.writeFileSync(
    saveFile,
    JSON.stringify(data, null, 2)
  );
}

/* ===============================
   差分比較用
=============================== */
function normalizeSection(section) {
  return {
    period: normalizeText(section?.period),
    names: uniqueNames(section?.names || [])
  };
}

function normalizeData(data) {
  return {
    current: normalizeSection(data.current),
    next: normalizeSection(data.next)
  };
}

/* ===============================
   通知本文
=============================== */
function buildMessage(current, next) {
  const sections = [];

  sections.push(
    `${current.period || "今週"}\n` +
    `${current.names.join("\n")}`
  );

  if (next.names.length > 0) {
    sections.push(
      `${next.period || "次週"}\n` +
      `${next.names.join("\n")}`
    );
  }

  return (
    "【ピックアップ奥様更新】\n\n" +
    sections.join("\n\n")
  );
}

/* ===============================
   メイン処理
=============================== */
module.exports = async function () {
  console.log(
    "pickup-monitor 開始:",
    getJSTTime()
  );

  const saveFile = path.join(
    __dirname,
    "data",
    "pickup-last.json"
  );

  const last = loadLast(saveFile);

  const current = await fetchCurrentPickup();

  /*
   * 今週ページが一時的に空だった場合、
   * 保存データを消さず、通知もしない。
   */
  if (current.names.length === 0) {
    console.log(
      "今週の対象奥様を取得できないため、更新を中止"
    );

    console.log(
      "pickup-monitor 完了:",
      getJSTTime()
    );

    return;
  }

  const fetchedNext = await fetchNextPickup();

  /*
   * 次週ページの通信失敗時は、
   * 前回保存した次週情報を維持する。
   *
   * 正常に取得できて「情報なし」だった場合は
   * 空データに更新する。
   */
  const next =
    fetchedNext === null
      ? last.next
      : fetchedNext;

  const newData = {
    current,
    next
  };

  const isFirstRun =
    last.current.names.length === 0 &&
    last.next.names.length === 0;

  if (isFirstRun) {
    console.log(
      "初回実行 → 通知せず保存"
    );

    saveLast(
      saveFile,
      current,
      next,
      last.lastNoticeTime
    );

    console.log(
      "pickup-monitor 完了:",
      getJSTTime()
    );

    return;
  }

  const newNorm = normalizeData(newData);
  const lastNorm = normalizeData(last);

  const isChanged =
    JSON.stringify(newNorm) !==
    JSON.stringify(lastNorm);

  /*
   * 旧JSONから新JSONへの移行時、
   * 次週情報がまだなければ通知せず移行する。
   */
  if (
    last.legacy &&
    next.names.length === 0 &&
    JSON.stringify(
      normalizeSection(current).names
    ) ===
      JSON.stringify(
        normalizeSection(last.current).names
      )
  ) {
    console.log(
      "旧形式から新形式へ通知なしで移行"
    );

    saveLast(
      saveFile,
      current,
      next,
      last.lastNoticeTime
    );

    console.log(
      "pickup-monitor 完了:",
      getJSTTime()
    );

    return;
  }

  if (isChanged) {
    console.log(
      "変更あり → 通知します"
    );

    const message = buildMessage(
      current,
      next
    );

    const sent = await sendDiscord(message);

    /*
     * Discord送信に失敗した場合は、
     * 通知済みとして保存しない。
     */
    if (!sent) {
      console.log(
        "Discord送信失敗のため保存を見送ります"
      );

      return;
    }

    saveLast(
      saveFile,
      current,
      next,
      getJSTTime()
    );
  } else {
    console.log(
      "変更なし → 通知なし"
    );

    saveLast(
      saveFile,
      current,
      next,
      last.lastNoticeTime
    );
  }

  console.log(
    "pickup-monitor 完了:",
    getJSTTime()
  );
};