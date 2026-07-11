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
  const date = new Date();
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);

  const yyyy = jst.getFullYear();
  const mm = String(jst.getMonth() + 1).padStart(2, "0");
  const dd = String(jst.getDate()).padStart(2, "0");

  const hh = String(jst.getHours()).padStart(2, "0");
  const mi = String(jst.getMinutes()).padStart(2, "0");
  const ss = String(jst.getSeconds()).padStart(2, "0");

  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
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
   正規化（強化版）
=============================== */
function normalize(text) {
  return (text || "")
    .replace(/\s+/g, "")
    .replace(/　+/g, "")
    .trim();
}

/* ===============================
   ヒットの正規化（差分判定強化）
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
   LINE通知
=============================== */
async function sendLine(hit) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: USER_ID,
      messages: [
        {
          type: "text",
          text:
            `${hit.date}\n` +
            `${hit.title}\n` +
            `${hit.keyword}\n` +
            `${hit.shift}\n` +
            `${hit.url}`
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
   lastNotice.json
=============================== */
function saveLastNotice(text) {
  const file = path.join(__dirname, "data", "bg-lastNotice.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      lastNotice: text,
      lastNoticeTime: getJSTTime()
    })
  );
}

/* ===============================
   メイン処理（WebService用）
=============================== */
async function main() {
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

  // 差分判定（正規化して比較）
  const diff = allHits.filter(
    hit => !lastHits.some(
      last =>
        JSON.stringify(normalizeHit(last)) === JSON.stringify(normalizeHit(hit))
    )
  );

  if (diff.length === 0) {
    console.log("差分なし → 通知なし");
  } else {
    let notified = false;

    for (const hit of diff) {
      if (config.castFilterEnabled) {
        if (containsCastName(hit.title)) {
          await sendLine(hit);

          const noticeText = [
            hit.date,
            hit.title,
            hit.keyword,
            hit.shift,
            hit.url
          ].join("\n");

          saveLastNotice(noticeText);
          notified = true;
        }
      } else {
        await sendLine(hit);

        const noticeText = [
          hit.date,
          hit.title,
          hit.keyword,
          hit.shift,
          hit.url
        ].join("\n");

        saveLastNotice(noticeText);
        notified = true;
      }
    }

    if (notified) {
      saveLast(allHits);
    }
  }

  console.log("bg-monitor 完了:", getJSTTime());
}

module.exports = main;
