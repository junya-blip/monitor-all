const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.LINE_TOKEN;
const USER_ID = process.env.LINE_USER_ID;

const KEYWORDS = ["キャンセル発生", "急遽出勤", "出勤延長"];

/* ===============================
   JST固定の時刻を返す関数
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
   config.json 読み込み（統合版）
=============================== */
function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "config.json"), "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("config.json の読み込みに失敗:", err);
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
  return text
    .replace(/\s+/g, "")
    .replace(/　+/g, "")
    .trim();
}

function uniqueHits(hits) {
  const map = new Map();
  for (const h of hits) {
    const key = `${h.title}-${h.keyword}-${h.shift}-${h.date}-${h.url}`;
    if (!map.has(key)) {
      map.set(key, h);
    }
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
   ページ解析（完全修正版）
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

    const img = $(td).find("img.thum").attr("src") || "";
    const imgUrl = img.startsWith("/")
      ? `https://www.kobe-b1.com${img}`
      : img;

    const parts = url.split("/");
    const year = parts.at(-3);
    const month = parts.at(-2);
    const day = parts.at(-1);
    const date = `${year}/${month}/${day}`;

    hits.push({ title, keyword, shift, date, url, imgUrl });
  });

  return hits;
}

/* ===============================
   last.json 読み書き（統合フォルダ用）
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
   lastNotice.json（統合フォルダ用）
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
   メイン処理（Cron Job 用）
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

  const diff = allHits.filter(
    hit => !lastHits.some(
      last =>
        last.title === hit.title &&
        last.keyword === hit.keyword &&
        last.shift === hit.shift &&
        last.date === hit.date &&
        last.url === hit.url
    )
  );

	if (diff.length === 0) {
	  console.log("差分なし → 通知なし");
	} else {
	  // 差分あり
	  let notified = false;

	  for (const hit of diff) {
	    if (config.castFilterEnabled) {
	      if (containsCastName(hit.title)) {
	        console.log("差分あり → 通知開始（キャスト一致）");
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
	      } else {
	        console.log(`差分あり → キャスト不一致（${hit.title}）`);
	        // 通知しない
	        // bg-last.json も更新しない
	      }
	    } else {
	      console.log("差分あり → 通知開始（フィルターOFF）");
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

	  // LINE通知が実際に送られた場合のみ last を更新
	  if (notified) {
	    saveLast(allHits);
	  } else {
	    console.log("通知対象キャストが存在しないため、last.json は更新しません");
	  }
	}

  console.log("bg-monitor 完了:", getJSTTime());
}

module.exports = main;
