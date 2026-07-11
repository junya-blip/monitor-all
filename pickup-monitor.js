const axios = require('axios');
const fs = require('fs');
const path = require('path');

/* ★★★★★ JST固定の時刻を返す関数（ズレない） ★★★★★ */
function getJSTTime() {
  const date = new Date();
  const jst = new Date(date.getTime() + (9 * 60 * 60 * 1000)); // UTC → JST

  const yyyy = jst.getFullYear();
  const mm = String(jst.getMonth() + 1).padStart(2, '0');
  const dd = String(jst.getDate()).padStart(2, '0');

  const hh = String(jst.getHours()).padStart(2, '0');
  const mi = String(jst.getMinutes()).padStart(2, '0');
  const ss = String(jst.getSeconds()).padStart(2, '0');

  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}
/* ★★★★★ ここまで ★★★★★ */

async function fetchPickup() {
  const url = 'https://www.aventure-uh.jp/umeda/top/';
  const html = await axios.get(url);
  let text = html.data;

  // ★ HTMLタグを完全除去
  text = text.replace(/<[^>]*>/g, '');

  // ★ ピックアップ奥様ブロック抽出
  const blockMatch = text.match(/対象奥様はこちら♪([\s\S]*?)※出勤状況により/);
  const block = blockMatch ? blockMatch[1] : '';

  // ★ 『◯◯』奥様 のみ抽出
  const rawMatches = block.match(/『([^』]+)』奥様/g) || [];

  let names = [];

  for (const m of rawMatches) {
    const inside = m.replace(/『|』奥様/g, '');
    const parts = inside.split('・');
    names.push(...parts);
  }

  // ★ 正規化
  names = names.map(n => n.trim().replace(/\s+/g, ''));
  names = [...new Set(names)];
  names.sort();

  // ★ 期間抽出
  const periodMatch = text.match(/\d+\/\d+\(.+?\)～\d+\/\d+\(.+?\)/);
  const period = periodMatch ? periodMatch[0].replace(/\s+/g, '') : '';

  return { period, names };
}

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

async function run() {
  const data = await fetchPickup();

  // ★ 統合フォルダ用の保存先
  const saveFile = path.join(__dirname, "data", "pickup-last.json");

  // ★ 新旧形式どちらにも対応して読み込む
  let last = { period: '', names: [], lastNoticeTime: null };
  if (fs.existsSync(saveFile)) {
    const raw = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    last = {
      period: raw.period || '',
      names: raw.names || [],
      lastNoticeTime: raw.lastNoticeTime || null
    };
  }

  /* ============================================================
     ★★★ ① ピックアップ対象が 0 件なら通知しない（重要） ★★★
     ============================================================ */
  if (data.names.length === 0) {
    console.log("対象なし → 通知しない");

    const saveData = {
      period: data.period,
      names: [],
      lastNoticeTime: getJSTTime()
    };

    fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));
    return;
  }

  /* ============================================================
     ★★★ ② names が 1 件以上のときだけ差分判定する ★★★
     ============================================================ */
  const isPeriodChanged = last.period !== data.period;
  const isNamesChanged =
    data.names.length !== last.names.length ||
    data.names.some(n => !last.names.includes(n));

  if (isPeriodChanged || isNamesChanged) {
    console.log("change detected, sending LINE...");

    const namesText = data.names.join('\n');

    const msg =
      `【ピックアップ奥様更新】\n` +
      `${data.period}\n` +
      `${namesText}`;

    await sendLine(msg);

    const saveData = {
      period: data.period,
      names: data.names,
      lastNoticeTime: getJSTTime()
    };

    fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));

  } else {
    console.log("no change");

    const saveData = {
      period: data.period,
      names: data.names,
      lastNoticeTime: last.lastNoticeTime
    };

    fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));
  }

  return 'done';
}

module.exports = run;
