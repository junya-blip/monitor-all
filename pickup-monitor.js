const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
   Discord通知
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
   ピックアップ奥様取得（新仕様）
=============================== */
async function fetchPickup() {
  const url = 'https://www.aventure-uh.jp/umeda/girls/?data[pickup]=Y';

  const res = await axios.get(url);
  const html = res.data;

  // 改行を除去して扱いやすくする
  const text = html.replace(/\n/g, '');

  // 名前＋年齢抽出：<span class="name"><a>あやか(34)</a></span>
  const nameMatches = [...text.matchAll(/<span class="name">.*?<a[^>]*>(.*?)<\/a>/g)];

  let names = nameMatches.map(m => m[1].trim());  // 「あやか(34)」をそのまま使う

  // 重複除去 & ソート
  names = [...new Set(names)].sort();

  // 期間はこのページに存在しないため空欄
  const period = '';

  return { period, names };
}

/* ===============================
   LINE通知（未使用）
=============================== */
async function sendLine(message) {
  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    {
      to: process.env.LINE_USER_ID,
      messages: [{ type: 'text', text: message }]
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LINE_TOKEN}`
      }
    }
  );
}

/* ===============================
   last.json 読み込み
=============================== */
function loadLast(saveFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    return {
      period: raw.period || '',
      names: Array.isArray(raw.names) ? raw.names : [],
      lastNoticeTime: raw.lastNoticeTime || null
    };
  } catch {
    return { period: '', names: [], lastNoticeTime: null };
  }
}

/* ===============================
   last.json 保存
=============================== */
function saveLast(saveFile, period, names, lastNoticeTime) {
  const data = { period, names, lastNoticeTime };
  fs.writeFileSync(saveFile, JSON.stringify(data, null, 2));
}

/* ===============================
   差分判定（揺れに強い）
=============================== */
function normalize(data) {
  return {
    period: (data.period || '').trim(),
    names: (data.names || []).map(n => n.trim()).sort()
  };
}

/* ===============================
   メイン処理（WebService用）
=============================== */
module.exports = async function () {
  console.log("pickup-monitor 開始:", getJSTTime());

  const data = await fetchPickup();
  const saveFile = path.join(__dirname, "data", "pickup-last.json");
  const last = loadLast(saveFile);

  // 対象なし
  if (data.names.length === 0) {
    console.log("対象なし → 通知しない");
    saveLast(saveFile, data.period, [], getJSTTime());
    console.log("pickup-monitor 完了:", getJSTTime());
    return;
  }

  const newNorm = normalize(data);
  const lastNorm = normalize(last);

  const isFirstRun = !last.period && last.names.length === 0;

  if (isFirstRun) {
    console.log("初回実行 → 通知せず last.json を更新");
    saveLast(saveFile, data.period, data.names, getJSTTime());
    console.log("pickup-monitor 完了:", getJSTTime());
    return;
  }

  const isChanged = JSON.stringify(newNorm) !== JSON.stringify(lastNorm);

  if (isChanged) {
    console.log("変更あり → 通知します");

    const msg =
      `【ピックアップ奥様更新】\n` +
      `${data.names.join('\n')}`;

    await sendDiscord(msg);

    saveLast(saveFile, data.period, data.names, getJSTTime());
  } else {
    console.log("変更なし → 通知なし");
    saveLast(saveFile, last.period, last.names, last.lastNoticeTime);
  }

  console.log("pickup-monitor 完了:", getJSTTime());
};
