const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const {
  notify
} = require("./common/notifier");

const {
  getJSTDate,
  getJSTTime,
  formatMonthDay
} = require("./common/time");

const CURRENT_URL =
  "https://www.aventure-uh.jp/umeda/girls/?data[pickup]=Y";

const NEXT_URL =
  "https://www.aventure-uh.jp/umeda/top/";

/* ===============================
   今週（月曜～日曜）の期間
=============================== */
function getCurrentWeekPeriod() {
  const jst = getJSTDate();

  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth();
  const day = jst.getUTCDate();

  const today = new Date(
    Date.UTC(year, month, day)
  );

  // 日曜=0、月曜=1
  const weekday = today.getUTCDay();

  // 今週月曜まで戻す
  const daysFromMonday =
    weekday === 0 ? 6 : weekday - 1;

  const monday = new Date(today);
  monday.setUTCDate(
    today.getUTCDate() - daysFromMonday
  );

  const sunday = new Date(monday);
  sunday.setUTCDate(
    monday.getUTCDate() + 6
  );

  return (
    `${formatMonthDay(monday)}` +
    `～` +
    `${formatMonthDay(sunday)}`
  );
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
  ].sort((a, b) =>
    a.localeCompare(b, "ja")
  );
}

/* ===============================
   年齢を除いた名前を比較用に整形
   例：さつき(40) → さつき
=============================== */
function normalizePickupName(name) {
  return normalizeText(name)
    .replace(
      /[（(]\s*\d+\s*[）)]$/,
      ""
    )
    .trim();
}

/* ===============================
   今週のピックアップ取得
=============================== */
async function fetchCurrentPickup() {
  const res = await axios.get(
    CURRENT_URL,
    {
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 pickup-monitor"
      }
    }
  );

  const $ = cheerio.load(res.data);

  const names = [];

  $("span.name a").each(
    (_, element) => {
      const name = normalizeText(
        $(element).text()
      );

      if (name) {
        names.push(name);
      }
    }
  );

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
  $("div, p, span, strong").each(
    (_, element) => {
      const text = normalizeText(
        $(element).text()
      ).replace(/\s+/g, "");

      const periodMatch = text.match(
        /(\d{1,2}\/\d{1,2}\([日月火水木金土]\)[～〜-]\d{1,2}\/\d{1,2}\([日月火水木金土]\))までの対象奥様はこちら/
      );

      if (!periodMatch) {
        return;
      }

      const names = [
        ...text.matchAll(
          /『([^』]+)』奥様/g
        )
      ].map(match => match[1]);

      if (names.length > 0) {
        candidates.push({
          period: periodMatch[1]
            .replace(/[〜]/g, "～"),
          names: uniqueNames(names),
          textLength: text.length
        });
      }
    }
  );

  /*
   * 同じ内容が親要素にも含まれるため、
   * 最も短い＝対象部分に近い要素を優先する。
   */
  candidates.sort(
    (a, b) =>
      a.textLength - b.textLength
  );

  if (candidates.length > 0) {
    return {
      period: candidates[0].period,
      names: candidates[0].names
    };
  }

  /*
   * HTML構造が多少変わった場合の
   * フォールバック。
   */
  const bodyText = normalizeText(
    $("body").text()
  ).replace(/\s+/g, "");

  const periodMatch = bodyText.match(
    /(\d{1,2}\/\d{1,2}\([日月火水木金土]\)[～〜-]\d{1,2}\/\d{1,2}\([日月火水木金土]\))までの対象奥様はこちら/
  );

  if (!periodMatch) {
    return {
      period: "",
      names: []
    };
  }

  const startIndex =
    periodMatch.index || 0;

  // 対象箇所の後ろだけを切り出す
  const targetText = bodyText.slice(
    startIndex,
    startIndex + 2000
  );

  const names = [
    ...targetText.matchAll(
      /『([^』]+)』奥様/g
    )
  ].map(match => match[1]);

  return {
    period: periodMatch[1]
      .replace(/[〜]/g, "～"),
    names: uniqueNames(names)
  };
}

/* ===============================
   次週のピックアップ取得
=============================== */
async function fetchNextPickup() {
  try {
    const res = await axios.get(
      NEXT_URL,
      {
        timeout: 20000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 pickup-monitor"
        }
      }
    );

    const result =
      extractNextPickup(res.data);

    if (result.names.length === 0) {
      console.log(
        "次週ピックアップ情報なし"
      );
    } else {
      console.log(
        `次週ピックアップ取得: ` +
        `${result.period} / ` +
        `${result.names.join(", ")}`
      );
    }

    return result;
  } catch (err) {
    /*
     * 次週ページだけの取得失敗で、
     * 今週分まで止めない。
     *
     * nullを返して、前回保存済みの
     * 次週情報を維持する。
     */
    console.error(
      "次週ピックアップ取得エラー:",
      err.response?.status ||
        err.message ||
        err
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
      fs.readFileSync(
        saveFile,
        "utf8"
      )
    );

    /*
     * 新形式
     */
    if (raw.current || raw.next) {
      return {
        current: {
          period:
            raw.current?.period || "",
          names:
            Array.isArray(
              raw.current?.names
            )
              ? raw.current.names
              : []
        },
        next: {
          period:
            raw.next?.period || "",
          names:
            Array.isArray(
              raw.next?.names
            )
              ? raw.next.names
              : []
        },
        lastNoticeTime:
          raw.lastNoticeTime || null,
        legacy: false
      };
    }

    /*
     * 旧形式との互換性
     */
    return {
      current: {
        period: raw.period || "",
        names:
          Array.isArray(raw.names)
            ? raw.names
            : []
      },
      next: {
        period: "",
        names: []
      },
      lastNoticeTime:
        raw.lastNoticeTime || null,
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
    JSON.stringify(
      data,
      null,
      2
    )
  );
}

/* ===============================
   差分比較用
=============================== */
function normalizeSection(section) {
  return {
    period: normalizeText(
      section?.period
    ),
    names: uniqueNames(
      section?.names || []
    )
  };
}

function normalizeData(data) {
  return {
    current: normalizeSection(
      data.current
    ),
    next: normalizeSection(
      data.next
    )
  };
}

/* ===============================
   通知本文
=============================== */
function buildMessage(
  current,
  next
) {
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
async function runPickupMonitor() {
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

  let current =
    await fetchCurrentPickup();

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

  const fetchedNext =
    await fetchNextPickup();

  let next =
    fetchedNext === null
      ? last.next
      : fetchedNext;

  /*
   * 一覧ページがすでに次週分へ更新されていて、
   * トップページにも同じ対象者が掲載されている場合。
   *
   * 一覧ページ：
   *   さつき(40)
   *
   * トップページ：
   *   さつき
   *
   * のような組み合わせでも
   * 同一人物として判定する。
   */
  if (
    fetchedNext !== null &&
    current.names.length > 0 &&
    next.names.length > 0
  ) {
    const currentNameSet =
      new Set(
        current.names.map(
          normalizePickupName
        )
      );

    const duplicateNames =
      next.names.filter(name =>
        currentNameSet.has(
          normalizePickupName(name)
        )
      );

    /*
     * トップページ側の全員が
     * 一覧ページ側に含まれている場合、
     * 一覧ページが次週分へ切り替わったと判断。
     */
    const isSameNextWeek =
      duplicateNames.length ===
      next.names.length;

    if (isSameNextWeek) {
      console.log(
        "一覧ページとトップページの対象者が重複 → 一覧ページを次週分として採用"
      );

      /*
       * 一覧ページでは期間を取得できないため、
       * トップページから取得した期間を使用。
       */
      current = {
        period: next.period,
        names: current.names
      };

      /*
       * 二重表示を防ぐため、
       * トップページ側を空にする。
       */
      next = {
        period: "",
        names: []
      };
    }
  }

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

  const newNorm =
    normalizeData(newData);

  const lastNorm =
    normalizeData(last);

  const isChanged =
    JSON.stringify(newNorm) !==
    JSON.stringify(lastNorm);

  /*
   * 旧JSONから新JSONへの移行時、
   * 次週情報がまだなければ
   * 通知せず移行する。
   */
  if (
    last.legacy &&
    next.names.length === 0 &&
    JSON.stringify(
      normalizeSection(current).names
    ) ===
      JSON.stringify(
        normalizeSection(
          last.current
        ).names
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

    const message =
      buildMessage(
        current,
        next
      );

    /*
     * NOTIFY_MODE=line
     *   → LINE通知
     *
     * NOTIFY_MODE=discord
     *   → Discord通知
     *
     * 通知失敗時はnotify()が例外を投げるため、
     * 下のsaveLast()には到達しない。
     */
    await notify(message);

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
}

module.exports = runPickupMonitor;

/* ===============================
   単体実行用
   node pickup-monitor.js
=============================== */
if (require.main === module) {
  runPickupMonitor().catch(err => {
    console.error(
      "pickup-monitor 実行エラー:",
      err.response?.data ||
        err.message ||
        err
    );

    process.exitCode = 1;
  });
}