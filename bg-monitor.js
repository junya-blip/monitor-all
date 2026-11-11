const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { readState, writeState, getStateStore } = require("./common/state-store");
const { fetchBgPages, validateBgPages } = require("./common/bg-source");

const {
  notify
} = require("./common/notifier");

const {
  getJSTTime
} = require("./common/time");

const KEYWORDS = [
  "キャンセル発生",
  "急遽出勤",
  "出勤延長"
];

const RUN_TIMEOUT = 50_000;
let running = false;

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
function parsePage(url, html, strict) {
  const $ = cheerio.load(html);
  if (!$("table").length || (strict && !$("title").text().includes("出勤情報"))) {
    throw Object.assign(new Error("出勤表を確認できないため、通知・保存を中止します"), {
      code: "BG_UPSTREAM"
    });
  }

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
async function monitor(signal, deadline, suppliedPages) {
  /*
   * 実行ごとにconfig.jsonを読み直す。
   * Render再起動なしで設定変更を反映できる。
   */
  const config =
    loadConfig();

  // Verify and parse all eight pages before comparing or writing any state.
  const pages = suppliedPages ?? await fetchBgPages(signal);
  validateBgPages(pages);
  const allHits = uniqueHits(pages.flatMap(({ url, html }) => parsePage(url, html, suppliedPages !== undefined)));
  signal.throwIfAborted();

  const store = getStateStore();
  const localMode = store.mode === "local";
  const localStateFile = path.join(__dirname, "data", "bg-state.json");
  const stored = localMode
    ? null
    : await readState("bg-monitor.json", localStateFile);
  const stateInitialized = localMode || stored.initialized;
  const stateData = localMode
    ? null
    : (stored.data || {});
  if (!localMode && (!stateData || typeof stateData !== "object" || Array.isArray(stateData) ||
      (stored.initialized && (!Array.isArray(stateData.hits) || !stateData.hits.every(hit => hit && typeof hit === "object" &&
        ["title", "keyword", "shift", "date", "url"].every(field => typeof hit[field] === "string")) ||
        !Array.isArray(stateData.notices) || !stateData.notices.every(item => typeof item === "string") || typeof stateData.lastNoticeTime !== "string")))) {
    const error = new Error("BG state schema is invalid");
    error.code = "STATE_STORE_CORRUPT";
    error.stateStoreError = true;
    throw error;
  }
  const lastHits = localMode
    ? loadLast()
    : (Array.isArray(stateData.hits) ? stateData.hits : []);
  const lastNotice = localMode
    ? loadLastNotice()
    : {
        notices: Array.isArray(stateData.notices) ? stateData.notices : [],
        lastNoticeTime: stateData.lastNoticeTime || "-"
      };

  const persist = async (hits, noticeState, initialize = false) => {
    if (localMode) {
      saveLast(hits);
      saveLastNotice(noticeState.notices, noticeState.lastNoticeTime);
      return;
    }
    await writeState("bg-monitor.json", localStateFile, {
      hits,
      notices: noticeState.notices,
      lastNoticeTime: noticeState.lastNoticeTime
    }, { initialize });
  };

  if (!stateInitialized) {
    console.log("R2初回基準登録 → 通知せず保存");
    await persist(allHits, { notices: [], lastNoticeTime: "-" }, true);
    return;
  }

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
    if (allHits.length === 0) {
      console.log(
        "ヒットなし → ダッシュボードをクリア"
      );

      await persist(allHits, { notices: [], lastNoticeTime: getJSTTime() });
    } else {
      await persist(allHits, lastNotice);
    }

    return;
  }

  console.log(
    `差分あり → ${diff.length} 件`
  );

  const notifiedNoticeList = [];
  const notifiedHits = [];

  async function saveNotices(hits = lastHits) {
    await persist(hits, {
      notices: [...lastNotice.notices, ...notifiedNoticeList],
      lastNoticeTime: getJSTTime()
    });
  }

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
     * 通知済みの差分だけを記録し、未送信分は次回に回す。
     */
    try {
      signal.throwIfAborted();
      // Let an already started delivery settle after a client disconnect,
      // while still enforcing the run deadline on the notification request.
      await notify(noticeText, { signal: deadline });
    } catch (err) {
      if (notifiedHits.length > 0) {
        await saveNotices(uniqueHits([...lastHits, ...notifiedHits]));
      }
      throw err;
    }

    notifiedHits.push(hit);
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
  /*
   * 実際に通知した内容だけを
   * ダッシュボード履歴へ追加する。
   */
  if (
    notifiedNoticeList.length > 0
  ) {
    await saveNotices(allHits);
  } else {
    await persist(allHits, lastNotice);
    console.log(
      "差分はあったが通知対象はなし"
    );
  }
}

async function runBgMonitor({ signal, pages } = {}) {
  if (running) {
    throw Object.assign(new Error("BG監視は実行中です"), { code: "BG_BUSY" });
  }

  running = true;
  const started = Date.now();
  const deadline = AbortSignal.timeout(RUN_TIMEOUT);
  const runSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    console.log("bg-monitor 開始:", getJSTTime());
    await monitor(runSignal, deadline, pages);
    console.log(`bg-monitor 完了: ${getJSTTime()} ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`bg-monitor 失敗: ${Date.now() - started}ms ${err.message}`);
    if (deadline.aborted) {
      throw Object.assign(new Error("BG監視の実行時間が上限に達しました"), {
        code: "BG_DEADLINE"
      });
    }
    throw err;
  } finally {
    running = false;
  }
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
