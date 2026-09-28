'use strict';
// Code.gs の normalizeEmail / normalizeName / normalizeDob を
// 1:1で移植したもの。ロジックを変えないこと（照合結果がGAS版と
// 食い違うと、ブラックリスト判定などが壊れる）。

function normalizeEmail(email) {
  return String(email || '').replace(/^'/, '').trim().toLowerCase();
}

const KANA_MAP = {
  'ｶﾞ': 'ガ', 'ｷﾞ': 'ギ', 'ｸﾞ': 'グ', 'ｹﾞ': 'ゲ', 'ｺﾞ': 'ゴ',
  'ｻﾞ': 'ザ', 'ｼﾞ': 'ジ', 'ｽﾞ': 'ズ', 'ｾﾞ': 'ゼ', 'ｿﾞ': 'ゾ',
  'ﾀﾞ': 'ダ', 'ﾁﾞ': 'ヂ', 'ﾂﾞ': 'ヅ', 'ﾃﾞ': 'デ', 'ﾄﾞ': 'ド',
  'ﾊﾞ': 'バ', 'ﾋﾞ': 'ビ', 'ﾌﾞ': 'ブ', 'ﾍﾞ': 'ベ', 'ﾎﾞ': 'ボ',
  'ﾊﾟ': 'パ', 'ﾋﾟ': 'ピ', 'ﾌﾟ': 'プ', 'ﾍﾟ': 'ペ', 'ﾎﾟ': 'ポ',
  'ｳﾞ': 'ヴ', 'ﾜﾞ': 'ヷ', 'ｦﾞ': 'ヺ',
  'カﾞ': 'ガ', 'キﾞ': 'ギ', 'クﾞ': 'グ', 'ケﾞ': 'ゲ', 'コﾞ': 'ゴ',
  'サﾞ': 'ザ', 'シﾞ': 'ジ', 'スﾞ': 'ズ', 'セﾞ': 'ゼ', 'ソﾞ': 'ゾ',
  'タﾞ': 'ダ', 'チﾞ': 'ヂ', 'ツﾞ': 'ヅ', 'テﾞ': 'デ', 'トﾞ': 'ド',
  'ハﾞ': 'バ', 'ヒﾞ': 'ビ', 'フﾞ': 'ブ', 'ヘﾞ': 'ベ', 'ホﾞ': 'ボ',
  'ハﾟ': 'パ', 'ヒﾟ': 'ピ', 'フﾟ': 'プ', 'ヘﾟ': 'ペ', 'ホﾟ': 'ポ',
  'ｱ': 'ア', 'ｲ': 'イ', 'ｳ': 'ウ', 'ｴ': 'エ', 'ｵ': 'オ',
  'ｶ': 'カ', 'ｷ': 'キ', 'ｸ': 'ク', 'ｹ': 'ケ', 'ｺ': 'コ',
  'ｻ': 'サ', 'ｼ': 'シ', 'ｽ': 'ス', 'ｾ': 'セ', 'ｿ': 'ソ',
  'ﾀ': 'タ', 'ﾁ': 'チ', 'ﾂ': 'ツ', 'ﾃ': 'テ', 'ﾄ': 'ト',
  'ﾅ': 'ナ', 'ﾆ': 'ニ', 'ﾇ': 'ヌ', 'ﾈ': 'ネ', 'ﾉ': 'ノ',
  'ﾊ': 'ハ', 'ﾋ': 'ヒ', 'ﾌ': 'フ', 'ﾍ': 'ヘ', 'ﾎ': 'ホ',
  'ﾏ': 'マ', 'ﾐ': 'ミ', 'ﾑ': 'ム', 'ﾒ': 'メ', 'ﾓ': 'モ',
  'ﾔ': 'ヤ', 'ﾕ': 'ユ', 'ﾖ': 'ヨ',
  'ﾗ': 'ラ', 'ﾘ': 'リ', 'ﾙ': 'ル', 'ﾚ': 'レ', 'ﾛ': 'ロ',
  'ﾜ': 'ワ', 'ｦ': 'ヲ', 'ﾝ': 'ン',
  'ｧ': 'ァ', 'ｨ': 'ィ', 'ｩ': 'ゥ', 'ｪ': 'ェ', 'ｫ': 'ォ',
  'ｯ': 'ッ', 'ｬ': 'ャ', 'ｭ': 'ュ', 'ｮ': 'ョ',
  '｡': '。', '､': '、', 'ｰ': 'ー', '｢': '「', '｣': '」', '･': '・'
};
const SORTED_KANA_KEYS = Object.keys(KANA_MAP).sort((a, b) => b.length - a.length);

function normalizeName(name) {
  if (!name) return '';
  let s = String(name).replace(/\s+/g, '');

  for (const key of SORTED_KANA_KEYS) {
    s = s.split(key).join(KANA_MAP[key]);
  }

  // 全角英数記号 -> 半角 (！-～ の範囲を -0xFEE0)
  s = s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));

  return s.trim();
}

const MONTH_MAP = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

function _formatValidDob(yearValue, monthValue, dayValue) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(year) || year < 1 || year > 9999 ||
    !Number.isInteger(month) || month < 1 || month > 12 ||
    !Number.isInteger(day) || day < 1) return '';

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) return '';

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeDob(dob) {
  if (!dob) return '';

  if (dob instanceof Date) {
    if (!Number.isFinite(dob.getTime())) return '';
    return _formatValidDob(dob.getFullYear(), dob.getMonth() + 1, dob.getDate());
  }

  const s = String(dob).trim();
  if (!s) return '';

  const m1 = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:$|[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)$/);
  if (m1) return _formatValidDob(m1[1], m1[2], m1[3]);

  const m2 = s.match(/^(?:[A-Za-z]{3}\s+)?([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})(?:\s+\d{2}:\d{2}:\d{2}(?:\s+GMT[+-]\d{4}(?:\s+\([^)]*\))?)?)?$/);
  if (m2) {
    const month = MONTH_MAP[m2[1]];
    if (!month) return '';
    return _formatValidDob(m2[3], month, m2[2]);
  }

  return '';
}

module.exports = { normalizeEmail, normalizeName, normalizeDob };
