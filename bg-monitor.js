const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.LINE_TOKEN;
const USER_ID = process.env.LINE_USER_ID;

const KEYWORDS = ["キャンセル発生", "急遽出勤", "出勤延長"];

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
   Discord通知（送るだけ）
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
   config.json 読み込み
=============================== */
function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "config.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { castFilterEnabled: false, castNames: [] };
  }
}

let config = loadConfig();

/* ===============================
   キャスト名フィルター
=============================== */
function containsCastName(title) {
  return config.castNames.some(name => title.includes(name));
}

/* ===============================
   正規化（軽め）
=============================== */
function normalize(text) {
  return (text || "").trim();
}

/* ===============================
   ヒットの正規化（差分判定を弱める）
=============================== */
function normalizeHit(hit) {
  return {
    title: normalize(hit.title),
    keyword: normalize(hit.keyword),
    shift: normalize(hit.shift),
    date: normalize(hit.date),
    url: normalize(hit.url)
  };
}

/* ===============================
   重複排除
=============================== */
function uniqueHits(hits) {
  const map = new Map();
  for (const h of hits) {
    const key = JSON.stringify(normalizeHit(h));
    if (!map.has(key)) map.set(key, h);
  }
  return Array.from(map.values());
}

/* ===============================
   LINE通知（来月復活用）
=============================== */
async function sendLine(hit) {
  const noticeText = [
    hit.date,
    hit.title,
    hit.keyword,
    hit.shift,
    hit.url
  ].join("\n");

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: USER_ID,
      messages: [
        {
          type: "text",
          text: noticeText
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

/* ===============================
   今日〜7日後までのURL生成
=============================== */
function buildUrls() {
  const urls = [];
  const today = new Date();

  for (let i = 0; i <= 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);

    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();

    urls.push(`https://www.kobe-b1.com/schedule/${year}/${month}/${day}`);
  }

  return urls;
}

/* ===============================
   ページ解析
=============================== */
async function checkPage(url) {
  const res = await axios.get(url);
  const $ = cheerio.load(res.data);

  const hits = [];

  $("td").each((i, td) => {
    const rawText = $(td).text();
    const tdText = normalize(rawText);

    let keyword = KEYWORDS.find(k =>
      rawText.includes(k) || tdText.includes(k)
    );

    if (!keyword) {
      $(td).find("img").each((j, img) => {
        const alt = normalize($(img).attr("alt") || "");
        if (KEYWORDS.some(k => alt.includes(k))) {
          keyword = KEYWORDS.find(k => alt.includes(k));
        }
      });
    }

    if (!keyword) return;

    const title =
      $(td).find("h4").text().trim() ||
      $(td).find(".castname").text().trim() ||
      $(td).find("strong").text().trim();

    if (!title) return;

    const shift =
      $(td).find("p.shifttime").text().trim() ||
      $(td).find(".time").text().trim() ||
      $(td).find("span").text().trim();

    const parts = url.split("/");
    const year = parts.at(-3);
    const month = parts.at(-2);
    const day = parts.at(-1);
    const date = `${year}/${month}/${day}`;

    hits.push({ title, keyword, shift, date, url });
  });

  return hits;
}

/* ===============================
   last.json 読み書き
=============================== */
function loadLast() {
  const file = path.join(__dirname, "data", "bg-last.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

function saveLast(data) {
  const file = path.join(__dirname, "data", "bg-last.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* ===============================
   lastNotice.json（複数件対応版）
=============================== */
function loadLastNotice() {
  const file = path.join(__dirname, "data", "bg-lastNotice.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { notices: [], lastNoticeTime: "-" };
  }
}

function saveLastNotice(notices) {
  const file = path.join(__dirname, "data", "bg-lastNotice.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        notices,
        lastNoticeTime: getJSTTime()
      },
      null,
      2
    )
  );
}

/* ===============================
   メイン処理（WebService用）
=============================== */
module.exports = async function () {
  console.log("bg-monitor 開始:", getJSTTime());

  const urls = buildUrls();
  let allHits = [];

  for (const url of urls) {
    try {
      const hits = await checkPage(url);
      allHits = allHits.concat(hits);
    } catch (e) {
      console.error("ページ取得エラー:", url, e.message);
    }
  }

  allHits = uniqueHits(allHits);

  const lastHits = loadLast();
  const lastNotice = loadLastNotice();

  const diff = allHits.filter(
    hit => !lastHits.some(
      last =>
        JSON.stringify(normalizeHit(last)) === JSON.stringify(normalizeHit(hit))
    )
  );

  /* ===============================
     差分なしでも return しない
  ================================ */
  if (diff.length === 0) {
    console.log("差分なし → 通知なし");

    const activeHits = allHits.filter(hit =>
      KEYWORDS.some(k => hit.keyword.includes(k))
    );
    saveLast(activeHits);

  } else {
    console.log(`差分あり → ${diff.length} 件`);

    let notified = false;
    const noticeList = [];

    for (const hit of diff) {
      const noticeText = [
        hit.date,
        hit.title,
        hit.keyword,
        hit.shift,
        hit.url
      ].join("\n");

      console.log("通知内容:\n" + noticeText);

      noticeList.push(noticeText);

      if (config.castFilterEnabled) {
        console.log("キャストフィルター ON");

        if (containsCastName(hit.title)) {
          console.log(`キャスト一致 → 通知: ${hit.title}`);
          await sendDiscord(noticeText);
          notified = true;
        } else {
          console.log(`キャスト不一致 → 通知しない: ${hit.title}`);
        }

      } else {
        console.log("キャストフィルター OFF → 通知");
        await sendDiscord(noticeText);
        notified = true;
      }
    }

    if (notified) {
      const activeHits = allHits.filter(hit =>
        KEYWORDS.some(k => hit.keyword.includes(k))
      );

      saveLast(activeHits);

      const mergedList = [...(lastNotice.notices || []), ...noticeList];

      // ★ noticeList が空でも保存する（lastNoticeTime を更新する）
      saveLastNotice(mergedList.length > 0 ? mergedList : lastNotice.notices);
    }
  }

  /* ===============================
     ★ 完了ログを必ず出す
  ================================ */
  console.log("bg-monitor 完了:", getJSTTime());
};
