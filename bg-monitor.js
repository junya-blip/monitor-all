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

const KEYWORDS = [
  "キャンセル発生",
  "急遽出勤",
  "出勤延長"
];

const REQUEST_TIMEOUT = 20000;

/* ===============================
   config.json 読み込み
=============================== */
function loadConfig() {
  try {
    const file = path.join(
      __dirname,
      "config.json"
    );

    const raw = fs.readFileSync(
      file,
      "utf-8"
    );

    const parsed = JSON.parse(raw);

    return {
      castFilterEnabled:
        parsed.castFilterEnabled === true,

      castNames:
        Array.isArray(parsed.castNames)
          ? parsed.castNames
              .map(name => String(name).trim())
              .filter(Boolean)
          : []
    };
  } catch (err) {
    console.error(
      "config.json 読み込みエラー:",
      err.message || err
    );

    return {
      castFilterEnabled: false,
      castNames: []
    };
  }
}

/* ===============================
   キャスト名フィルター
=============================== */
function containsCastName(
  title,
  config
) {
  return config.castNames.some(
    name =>
      String(title || "").includes(name)
  );
}

/* ===============================
   正規化
=============================== */
function normalize(text) {
  return String(text || "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2000-\u200F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ===============================
   ヒットの正規化
=============================== */
function normalizeHit(hit) {
  return {
    title: normalize(hit?.title),
    keyword: normalize(hit?.keyword),
    shift: normalize(hit?.shift),
    date: normalize(hit?.date),
    url: normalize(hit?.url)
  };
}

/* ===============================
   ヒット比較用キー
=============================== */
function createHitKey(hit) {
  return JSON.stringify(
    normalizeHit(hit)
  );
}

/* ===============================
   重複排除
=============================== */
function uniqueHits(hits) {
  const map = new Map();

  for (const hit of hits) {
    const key =
      createHitKey(hit);

    if (!map.has(key)) {
      map.set(
        key,
        normalizeHit(hit)
      );
    }
  }

  return Array.from(
    map.values()
  );
}

/* ===============================
   今日～7日後までのURL生成
   JST基準
=============================== */
function buildUrls() {
  const urls = [];

  const jst = getJSTDate();

  /*
   * getJSTDate()はJSTをUTC系メソッドで
   * 取り出すためのDateオブジェクト。
   */
  const today = new Date(
    Date.UTC(
      jst.getUTCFullYear(),
      jst.getUTCMonth(),
      jst.getUTCDate()
    )
  );

  for (let i = 0; i <= 7; i++) {
    const date = new Date(today);

    date.setUTCDate(
      today.getUTCDate() + i
    );

    const year =
      date.getUTCFullYear();

    const month =
      date.getUTCMonth() + 1;

    const day =
      date.getUTCDate();

    urls.push(
      `https://www.kobe-b1.com/schedule/${year}/${month}/${day}`
    );
  }

  return urls;
}

/* ===============================
   URLから日付を取得
=============================== */
function extractDateFromUrl(url) {
  try {
    const parsedUrl =
      new URL(url);

    const parts =
      parsedUrl.pathname
        .split("/")
        .filter(Boolean);

    const year =
      parts.at(-3);

    const month =
      parts.at(-2);

    const day =
      parts.at(-1);

    if (
      !year ||
      !month ||
      !day
    ) {
      return "";
    }

    return (
      `${year}/${month}/${day}`
    );
  } catch {
    return "";
  }
}

/* ===============================
   ページ解析
=============================== */
async function checkPage(url) {
  const res = await axios.get(
    url,
    {
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 Chrome/120 Safari/537.36"
      }
    }
  );

  const $ =
    cheerio.load(res.data);

  const hits = [];

  $("td").each((_, td) => {
    const rawText =
      $(td).text();

    const tdText =
      normalize(rawText);

    let keyword =
      KEYWORDS.find(k =>
        rawText.includes(k) ||
        tdText.includes(k)
      );

    /*
     * テキストに見つからない場合は
     * imgのalt属性も確認する。
     */
    if (!keyword) {
      $(td)
        .find("img")
        .each((_, img) => {
          if (keyword) {
            return;
          }

          const alt =
            normalize(
              $(img).attr("alt")
            );

          keyword =
            KEYWORDS.find(k =>
              alt.includes(k)
            );
        });
    }

    if (!keyword) {
      return;
    }

    const title =
      normalize(
        $(td)
          .find("h4")
          .first()
          .text()
      ) ||
      normalize(
        $(td)
          .find(".castname")
          .first()
          .text()
      ) ||
      normalize(
        $(td)
          .find("strong")
          .first()
          .text()
      );

    if (!title) {
      return;
    }

    const shift =
      normalize(
        $(td)
          .find("p.shifttime")
          .first()
          .text()
      ) ||
      normalize(
        $(td)
          .find(".time")
          .first()
          .text()
      ) ||
      normalize(
        $(td)
          .find("span")
          .first()
          .text()
      );

    const date =
      extractDateFromUrl(url);

    hits.push({
      title,
      keyword,
      shift,
      date,
      url
    });
  });

  return hits;
}

/* ===============================
   bg-last.json 読み書き
=============================== */
function loadLast() {
  const file = path.join(
    __dirname,
    "data",
    "bg-last.json"
  );

  try {
    const parsed = JSON.parse(
      fs.readFileSync(
        file,
        "utf-8"
      )
    );

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function saveLast(data) {
  const file = path.join(
    __dirname,
    "data",
    "bg-last.json"
  );

  fs.writeFileSync(
    file,
    JSON.stringify(
      data,
      null,
      2
    )
  );
}

/* ===============================
   bg-lastNotice.json 読み書き
=============================== */
function loadLastNotice() {
  const file = path.join(
    __dirname,
    "data",
    "bg-lastNotice.json"
  );

  try {
    const parsed = JSON.parse(
      fs.readFileSync(
        file,
        "utf-8"
      )
    );

    return {
      notices:
        Array.isArray(parsed.notices)
          ? parsed.notices
          : [],

      lastNoticeTime:
        parsed.lastNoticeTime || "-"
    };
  } catch {
    return {
      notices: [],
      lastNoticeTime: "-"
    };
  }
}

/*
 * 通知が行われた場合に使用する。
 */
function saveLastNotice(
  notices,
  lastNoticeTime = getJSTTime()
) {
  const file = path.join(
    __dirname,
    "data",
    "bg-lastNotice.json"
  );

  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        notices,
        lastNoticeTime
      },
      null,
      2
    )
  );
}

/*
 * 現在のヒットが0件になった場合、
 * ダッシュボード表示をクリアする。
 */
function clearLastNotice() {
  saveLastNotice(
    [],
    getJSTTime()
  );
}

/* ===============================
   通知対象か判定
=============================== */
function shouldNotifyHit(
  hit,
  config
) {
  if (!config.castFilterEnabled) {
    return true;
  }

  return containsCastName(
    hit.title,
    config
  );
}

/* ===============================
   通知本文作成
=============================== */
function buildNoticeText(hit) {
  return [
    hit.date,
    hit.title,
    hit.keyword,
    hit.shift,
    hit.url
  ].join("\n");
}

/* ===============================
   メイン処理
=============================== */
async function runBgMonitor() {
  console.log(
    "bg-monitor 開始:",
    getJSTTime()
  );

  /*
   * 実行ごとにconfig.jsonを読み直す。
   * Render再起動なしで設定変更を反映できる。
   */
  const config =
    loadConfig();

  const urls =
    buildUrls();

  let allHits = [];
  let fetchErrorCount = 0;

  for (const url of urls) {
    try {
      const hits =
        await checkPage(url);

      allHits =
        allHits.concat(hits);
    } catch (err) {
      fetchErrorCount += 1;

      console.error(
        "ページ取得エラー:",
        url,
        err.response?.status ||
          err.message ||
          err
      );
    }
  }

  allHits =
    uniqueHits(allHits);

  /*
   * 一部ページを取得できなかった状態で
   * 保存すると、取得不能分が「消えた」と判断される。
   * そのため今回は通知・保存を中止する。
   */
  if (fetchErrorCount > 0) {
    console.log(
      `${fetchErrorCount}ページの取得に失敗したため、通知・保存を中止します`
    );

    console.log(
      "bg-monitor 完了:",
      getJSTTime()
    );

    return;
  }

  const lastHits =
    loadLast();

  const lastNotice =
    loadLastNotice();

  const lastKeys = new Set(
    lastHits.map(
      createHitKey
    )
  );

  const diff =
    allHits.filter(
      hit =>
        !lastKeys.has(
          createHitKey(hit)
        )
    );

  /* ===============================
     差分なし
  =============================== */
  if (diff.length === 0) {
    console.log(
      "差分なし → 通知なし"
    );

    /*
     * 現在サイトに残っているヒットだけ保存。
     * 掲載終了した古いデータは消える。
     */
    saveLast(allHits);

    if (allHits.length === 0) {
      console.log(
        "ヒットなし → ダッシュボードをクリア"
      );

      clearLastNotice();
    }

    console.log(
      "bg-monitor 完了:",
      getJSTTime()
    );

    return;
  }

  console.log(
    `差分あり → ${diff.length} 件`
  );

  const notifiedNoticeList = [];

  for (const hit of diff) {
    const noticeText =
      buildNoticeText(hit);

    console.log(
      "検出内容:\n" +
      noticeText
    );

    if (
      !shouldNotifyHit(
        hit,
        config
      )
    ) {
      console.log(
        `キャストフィルター不一致 → 通知しない: ${hit.title}`
      );

      continue;
    }

    if (
      config.castFilterEnabled
    ) {
      console.log(
        `キャストフィルター一致 → 通知: ${hit.title}`
      );
    } else {
      console.log(
        "キャストフィルター OFF → 通知"
      );
    }

    /*
     * NOTIFY_MODE=line
     *   → LINE通知
     *
     * NOTIFY_MODE=discord
     *   → Discord通知
     *
     * 失敗時は例外になるため、
     * 下の状態保存には進まない。
     */
    await notify(noticeText);

    notifiedNoticeList.push(
      noticeText
    );
  }

  /*
   * 通知対象外も含め、取得済みの全ヒットを保存する。
   *
   * これを保存しないと、キャストフィルター対象外の
   * ヒットが5分ごとに新規差分として検出され続ける。
   */
  saveLast(allHits);

  /*
   * 実際に通知した内容だけを
   * ダッシュボード履歴へ追加する。
   */
  if (
    notifiedNoticeList.length > 0
  ) {
    const mergedList = [
      ...(lastNotice.notices || []),
      ...notifiedNoticeList
    ];

    saveLastNotice(
      mergedList,
      getJSTTime()
    );
  } else {
    console.log(
      "差分はあったが通知対象はなし"
    );
  }

  console.log(
    "bg-monitor 完了:",
    getJSTTime()
  );
}

module.exports =
  runBgMonitor;

/* ===============================
   単体実行用
   node bg-monitor.js
=============================== */
if (require.main === module) {
  runBgMonitor().catch(err => {
    console.error(
      "bg-monitor 実行エラー:",
      err.response?.data ||
        err.message ||
        err
    );

    process.exitCode = 1;
  });
}