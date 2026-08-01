const JST_OFFSET_MS =
  9 * 60 * 60 * 1000;

/* ===============================
   現在時刻をJSTとして取得
=============================== */
function getJSTDate() {
  return new Date(
    Date.now() + JST_OFFSET_MS
  );
}

/* ===============================
   JST固定の日時文字列
   例：2026/08/01 15:30:45
=============================== */
function getJSTTime() {
  const jst = getJSTDate();

  const yyyy =
    jst.getUTCFullYear();

  const mm = String(
    jst.getUTCMonth() + 1
  ).padStart(2, "0");

  const dd = String(
    jst.getUTCDate()
  ).padStart(2, "0");

  const hh = String(
    jst.getUTCHours()
  ).padStart(2, "0");

  const mi = String(
    jst.getUTCMinutes()
  ).padStart(2, "0");

  const ss = String(
    jst.getUTCSeconds()
  ).padStart(2, "0");

  return (
    `${yyyy}/${mm}/${dd} ` +
    `${hh}:${mi}:${ss}`
  );
}

/* ===============================
   JSTの日付情報を取得
=============================== */
function getJSTDateParts() {
  const jst = getJSTDate();

  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    weekday: jst.getUTCDay(),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
    second: jst.getUTCSeconds()
  };
}

/* ===============================
   M/D(曜日)形式へ整形
=============================== */
function formatMonthDay(date) {
  if (!(date instanceof Date)) {
    throw new TypeError(
      "formatMonthDayにはDateオブジェクトを渡してください"
    );
  }

  const weekdays = [
    "日",
    "月",
    "火",
    "水",
    "木",
    "金",
    "土"
  ];

  const month =
    date.getUTCMonth() + 1;

  const day =
    date.getUTCDate();

  const weekday =
    weekdays[date.getUTCDay()];

  return `${month}/${day}(${weekday})`;
}

module.exports = {
  JST_OFFSET_MS,
  getJSTDate,
  getJSTTime,
  getJSTDateParts,
  formatMonthDay
};