const axios = require('axios');
const fs = require('fs');
const path = require('path');

/* ★★★★★ JST固定の時刻を返す関数 ★★★★★ */
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

/* ============================================================
   ★★★ LINE通知 ★★★
============================================================ */
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

/* ============================================================
   ★★★ last.json 読み込み（壊れた形式にも対応） ★★★
============================================================ */
function loadLast(saveFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(saveFile, 'utf8'));

    // ★ 配列形式（正しい形式）
    if (Array.isArray(raw)) {
      return { period: '', names: raw, lastNoticeTime: null };
    }

    // ★ オブジェクト形式（壊れた形式）
    return {
      period: raw.period || '',
      names: Array.isArray(raw.names) ? raw.names : [],
      lastNoticeTime: raw.lastNoticeTime || null
    };

  } catch {
    return { period: '', names: [], lastNoticeTime: null };
  }
}

/* ============================================================
   ★★★ last.json 保存（常に配列形式で保存） ★★★
============================================================ */
function saveLast(saveFile, period, names, lastNoticeTime) {
  const data = {
    period,
    names,
    lastNoticeTime
  };
  fs.writeFileSync(saveFile, JSON.stringify(data, null, 2));
}

/* ============================================================
   ★★★ メイン処理 ★★★
============================================================ */
async function run() {
  const data = await fetchPickup();

  const saveFile = path.join(__dirname, "data", "pickup-last.json");
  const last = loadLast(saveFile);

  if (data.names.length === 0) {
    console.log("対象なし → 通知しない");
    saveLast(saveFile, data.period, [], getJSTTime());
    return;
  }

  const isPeriodChanged = last.period !== data.period;
  const isNamesChanged =
    data.names.length !== last.names.length ||
    data.names.some(n => !last.names.includes(n));

	if (isPeriodChanged || isNamesChanged) {
	  console.log("change detected, sending LINE...");

	  const msg =
	    `【ピックアップ奥様更新】\n` +
	    `${data.period}\n` +
	    `${data.names.join('\n')}`;

	  await sendLine(msg);

	  const saveData = {
	    period: data.period,
	    names: data.names,
	    lastNoticeTime: getJSTTime()
	  };

	  console.log("【DEBUG】pickup-last.json に書き込みます:", saveFile, saveData);
	  fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));
	  console.log("【DEBUG】pickup-last.json 書き込み完了");
	} else {
	  console.log("no change");

	  const saveData = {
	    period: data.period,
	    names: data.names,
	    lastNoticeTime: last.lastNoticeTime
	  };

	  console.log("【DEBUG】pickup-last.json に書き込みます(no change):", saveFile, saveData);
	  fs.writeFileSync(saveFile, JSON.stringify(saveData, null, 2));
	  console.log("【DEBUG】pickup-last.json 書き込み完了(no change)");
	}

  return 'done';
}

module.exports = run;
