const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.LINE_TOKEN;
const USER_ID = process.env.LINE_USER_ID;

/* ===============================
   JST固定の時刻
=============================== */
function getJSTTime() {
  const jst = new Date(); 

  const yyyy = jst.getFullYear();
  const mm = String(jst.getMonth() + 1).padStart(2, "0");
  const dd = String(jst.getDate()).padStart(2, "0");

  const hh = String(jst.getHours()).padStart(2, "0");
  const mi = String(jst.getMinutes()).padStart(2, "0");
  const ss = String(jst.getSeconds()).padStart(2, "0");

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
   正規化（揺れ対策）
=============================== */
function normalize(text) {
  return (text || "")
    .replace(/\s+/g, "")
    .replace(/　+/g, "")
    .trim();
}

/* ===============================
   最新投稿を取得
=============================== */
async function getLatestPost() {
  const url = "https://fukuharaso-pu.com/beginnerskobe/yuuri4/photodiary/";
  const res = await axios.get(url);
  const $ = cheerio.load(res.data);

  const post = $(".diary_cont").first();
  if (!post || post.length === 0) {
    console.log("最新投稿が取得できませんでした");
    return { title: null, link: null };
  }

  const titleElem = post.find(".tit a");
  const title = titleElem.length ? titleElem.text().trim() : null;
  const link = titleElem.length ? titleElem.attr("href") : null;

  return { title, link };
}

/* ===============================
   last.json 読み書き
=============================== */
function loadLast() {
  const file = path.join(__dirname, "data", "yuuri-last.json");
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const data = JSON.parse(raw);

    return {
      title: data.title || null,
      link: data.link || null,
      lastNoticeTime: data.lastNoticeTime || null
    };
  } catch {
    return { title: null, link: null, lastNoticeTime: null };
  }
}

function saveLast(data) {
  const file = path.join(__dirname, "data", "yuuri-last.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* ===============================
   差分判定（強化版）
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

  return JSON.stringify(aNorm) !== JSON.stringify(bNorm);
}

/* ===============================
   LINE通知（来月復活用）
=============================== */
async function sendLine(post) {
  const fullUrl = post.link
    ? "https://fukuharaso-pu.com" + post.link
    : "URL取得失敗";

  const titleText = post.title || "タイトル取得失敗";

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: USER_ID,
      messages: [
        {
          type: "text",
          text:
            `ゆうりちゃんの日記が更新されました！\n\n` +
            `タイトル: ${titleText}\n\n` +
            `URL: ${fullUrl}`
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
   メイン処理（WebService用）
=============================== */
module.exports = async function () {
  console.log("yuuri-monitor 開始:", getJSTTime());

  const latest = await getLatestPost();
  const last = loadLast();

  if (!last || isDifferent(latest, last)) {
    console.log("差分あり → 通知します");

    // ===== 整形（LINEと同じ構造） =====
    const fullUrl = latest.link
      ? "https://fukuharaso-pu.com" + latest.link
      : "URL取得失敗";

    const titleText = latest.title || "タイトル取得失敗";

    const message =
      `ゆうりちゃんの日記が更新されました！\n\n` +
      `タイトル: ${titleText}\n\n` +
      `URL: ${fullUrl}`;

    // ===== 今月は Discord に通知 =====
    await sendDiscord(message);

    // ===== 来月はこれに戻すだけ =====
    // await sendLine(latest);

    saveLast({
      title: latest.title,
      link: latest.link,
      lastNoticeTime: getJSTTime()
    });

  } else {
    console.log("差分なし → 通知なし");

    saveLast({
      title: last.title,
      link: last.link,
      lastNoticeTime: last.lastNoticeTime
    });
  }

  console.log("yuuri-monitor 完了:", getJSTTime());
};
