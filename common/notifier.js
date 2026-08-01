const axios = require("axios");

const LINE_API_URL =
  "https://api.line.me/v2/bot/message/push";

const REQUEST_TIMEOUT = 20000;

/* ===============================
   Discord通知
=============================== */
async function sendDiscord(message) {
  const webhookUrl =
    process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error(
      "環境変数 DISCORD_WEBHOOK_URL が設定されていません"
    );
  }

  if (!message || !String(message).trim()) {
    throw new Error(
      "Discord通知メッセージが空です"
    );
  }

  try {
    await axios.post(
      webhookUrl,
      {
        content: String(message)
      },
      {
        timeout: REQUEST_TIMEOUT
      }
    );

    console.log("Discord通知成功");
  } catch (err) {
    console.error(
      "Discord通知エラー:",
      err.response?.status || "",
      err.response?.data ||
        err.message ||
        err
    );

    /*
     * 呼び出し側で保存処理を止められるように、
     * エラーを握りつぶさず再度投げる。
     */
    throw err;
  }
}

/* ===============================
   LINE通知
=============================== */
async function sendLine(message) {
  const token = process.env.LINE_TOKEN;
  const userId = process.env.LINE_USER_ID;

  if (!token) {
    throw new Error(
      "環境変数 LINE_TOKEN が設定されていません"
    );
  }

  if (!userId) {
    throw new Error(
      "環境変数 LINE_USER_ID が設定されていません"
    );
  }

  if (!message || !String(message).trim()) {
    throw new Error(
      "LINE通知メッセージが空です"
    );
  }

  try {
    await axios.post(
      LINE_API_URL,
      {
        to: userId,
        messages: [
          {
            type: "text",
            text: String(message)
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        timeout: REQUEST_TIMEOUT
      }
    );

    console.log("LINE通知成功");
  } catch (err) {
    console.error(
      "LINE通知エラー:",
      err.response?.status || "",
      err.response?.data ||
        err.message ||
        err
    );

    /*
     * 通知失敗時にlast.jsonを更新させないため、
     * 呼び出し側へエラーを返す。
     */
    throw err;
  }
}

/* ===============================
   通知先を環境変数で切り替える
=============================== */
async function notify(message) {
  const mode = String(
    process.env.NOTIFY_MODE || "line"
  )
    .toLowerCase()
    .trim();

  if (mode === "line") {
    await sendLine(message);
    return;
  }

  if (mode === "discord") {
    await sendDiscord(message);
    return;
  }

  throw new Error(
    `NOTIFY_MODEの値が不正です: ${mode} ` +
    "（line または discord を指定してください）"
  );
}

module.exports = {
  sendLine,
  sendDiscord,
  notify
};