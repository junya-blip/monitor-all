const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const {
  notify
} = require("./common/notifier");

const {
  getJSTTime
} = require("./common/time");

const DIARY_URL =
  "https://fukuharaso-pu.com/beginnerskobe/yuuri4/photodiary/";

const BASE_URL =
  "https://fukuharaso-pu.com";

/* ===============================
   正規化（揺れ対策）
=============================== */
function normalize(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/　+/g, "")
    .trim();
}

/* ===============================
   最新投稿を取得
=============================== */
async function getLatestPost() {
  try {
    const res = await axios.get(
      DIARY_URL,
      {
        timeout: 20000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 Chrome/120 Safari/537.36"
        }
      }
    );

    const $ = cheerio.load(res.data);

    const post =
      $(".diary_cont").first();

    if (post.length === 0) {
      console.log(
        "最新投稿の要素が取得できませんでした"
      );

      return null;
    }

    const titleElem =
      post.find(".tit a").first();

    const title =
      titleElem.text().trim();

    const link =
      titleElem.attr("href");

    if (!title || !link) {
      console.log(
        "最新投稿のタイトルまたはURLを取得できませんでした"
      );

      return null;
    }

    return {
      title,
      link
    };
  } catch (err) {
    console.error(
      "最新投稿取得エラー:",
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
function loadLast() {
  const file = path.join(
    __dirname,
    "data",
    "yuuri-last.json"
  );

  try {
    const raw = fs.readFileSync(
      file,
      "utf-8"
    );

    const data =
      JSON.parse(raw);

    return {
      title:
        data.title || null,
      link:
        data.link || null,
      lastNoticeTime:
        data.lastNoticeTime || null
    };
  } catch {
    return {
      title: null,
      link: null,
      lastNoticeTime: null
    };
  }
}

/* ===============================
   last.json 保存
=============================== */
function saveLast(data) {
  const file = path.join(
    __dirname,
    "data",
    "yuuri-last.json"
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
   差分判定
=============================== */
function isDifferent(a, b) {
  const aNorm = {
    title: normalize(a.title),
    link: normalize(a.link)
  };

  const bNorm = {
    title: normalize(b.title),
    link: normalize(b.link)
  };

  return (
    JSON.stringify(aNorm) !==
    JSON.stringify(bNorm)
  );
}

/* ===============================
   URL生成
=============================== */
function buildFullUrl(link) {
  if (!link) {
    return null;
  }

  try {
    return new URL(
      link,
      BASE_URL
    ).href;
  } catch {
    return null;
  }
}

/* ===============================
   通知本文
=============================== */
function buildMessage(post) {
  const fullUrl =
    buildFullUrl(post.link);

  if (!fullUrl) {
    throw new Error(
      `日記URLの生成に失敗しました: ${post.link}`
    );
  }

  return (
    "ゆうりちゃんの日記が更新されました！\n\n" +
    `タイトル: ${post.title}\n\n` +
    `URL: ${fullUrl}`
  );
}

/* ===============================
   メイン処理
=============================== */
async function runYuuriMonitor() {
  console.log(
    "yuuri-monitor 開始:",
    getJSTTime()
  );

  const latest =
    await getLatestPost();

  if (!latest) {
    console.log(
      "最新投稿を正常に取得できなかったため、通知・保存を行いません"
    );

    console.log(
      "yuuri-monitor 完了:",
      getJSTTime()
    );

    return;
  }

  const last =
    loadLast();

  if (
    isDifferent(
      latest,
      last
    )
  ) {
    console.log(
      "差分あり → 通知します"
    );

    const message =
      buildMessage(latest);

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

    saveLast({
      title: latest.title,
      link: latest.link,
      lastNoticeTime:
        getJSTTime()
    });
  } else {
    console.log(
      "差分なし → 通知なし"
    );
  }

  console.log(
    "yuuri-monitor 完了:",
    getJSTTime()
  );
}

module.exports =
  runYuuriMonitor;

/* ===============================
   単体実行用
   node yuuri-monitor.js
=============================== */
if (require.main === module) {
  runYuuriMonitor().catch(err => {
    console.error(
      "yuuri-monitor 実行エラー:",
      err.response?.data ||
        err.message ||
        err
    );

    process.exitCode = 1;
  });
}