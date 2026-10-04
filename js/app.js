'use strict';

let _backInProgress = false;
let _processing = false;
// _navLocked は js/config.js で一元宣言している（詳細はそちらのコメント参照）。
// ui.js が app.js より先に読み込まれる構成でも参照できるようにするため。

async function _retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); } catch (e) {
      if (i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
    }
  }
}

const RETURN_QUEUE_KEY = 'pending_returns';
const RETURN_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const RETURN_QUEUE_MAX_ATTEMPTS = 30;
const PENDING_RETURN_PERMANENT_RE = /記録が見つかりません|対象の行が見つかりません|履歴の更新に失敗|返却受付が停止|貸出が停止|メンテナンス|緊急停止|本人確認|不正な|必要な情報/;
let _pendingReturnRetryRunning = false;
function _readPendingReturns() {
  try {
    const value = JSON.parse(localStorage.getItem(RETURN_QUEUE_KEY) || '[]');
    return Array.isArray(value) ? value.filter(r => r && typeof r.id === 'string') : [];
  } catch (e) {
    console.warn('保留中の返却キューを読み込めません:', e);
    return [];
  }
}
function _writePendingReturns(queue) {
  try {
    localStorage.setItem(RETURN_QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.error('保留中の返却キューを保存できません:', e);
  }
}
function _getPendingReturns() {
  const now = Date.now();
  const queue = _readPendingReturns().filter(r =>
    now - Number(r.queuedAt || 0) <= RETURN_QUEUE_TTL_MS
    && Number(r.attempts || 0) < RETURN_QUEUE_MAX_ATTEMPTS
  );
  _writePendingReturns(queue);
  return queue;
}
function _enqueuePendingReturn(loan) {
  if (!loan || typeof loan.id !== 'string' || !loan.id) return;
  const current = _getPendingReturns();
  const queue = current.filter(r => r.id !== loan.id);
  const previous = current.find(r => r.id === loan.id);
  queue.push({
    ...loan,
    queuedAt: previous ? previous.queuedAt : Date.now(),
    attempts: previous ? Number(previous.attempts || 0) : Number(loan.attempts || 0),
  });
  _writePendingReturns(queue);
}
function _clearPendingReturn(loanId) {
  _writePendingReturns(_getPendingReturns().filter(r => r.id !== loanId));
}
async function _retryPendingReturns() {
  if (_pendingReturnRetryRunning) return;
  const queue = _getPendingReturns();
  if (queue.length === 0) return;
  _pendingReturnRetryRunning = true;
  try {
    for (const loan of [...queue]) {
      try {
        const r = await gasCall('returnComplete', { loanId: loan.id, isDamaged: loan.isDamaged || false });
        if (r && r.success) {
          _clearPendingReturn(loan.id);
        } else if (r && PENDING_RETURN_PERMANENT_RE.test(r.message || '')) {
          _clearPendingReturn(loan.id);
        } else {
          loan.attempts = Number(loan.attempts || 0) + 1;
          _writePendingReturns(_getPendingReturns().map(item =>
            item.id === loan.id ? { ...item, attempts: loan.attempts } : item
          ));
        }
      } catch (e) {
        loan.attempts = Number(loan.attempts || 0) + 1;
        _writePendingReturns(_getPendingReturns().map(item =>
          item.id === loan.id ? { ...item, attempts: loan.attempts } : item
        ));
        console.warn('返却の再送に失敗しました:', e);
      }
    }
  } finally {
    _pendingReturnRetryRunning = false;
  }
}

const BTN_HTML = {
  checkout: `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white"
         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
    </svg>
    空き端末を割り当てて貸出
  `,
  checkoutNext: `
    次へ
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white"
         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12h14M13 5l7 7-7 7"/>
    </svg>
  `,
  returnConfirm: `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white"
         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
    はい、返却します
  `,
  returnDone: `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white"
         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
    Chromebookを入れました。返却完了
  `,
};

// 共有キオスクの画面上で、他人のメールアドレスがそのまま見えないよう
// マスクして表示するためのヘルパー。例: 6043_2024_12345@g.miyazaki-c.ed.jp
// → 60***@g.miyazaki-c.ed.jp。あくまで画面表示専用で、API送信や録画
// メタデータなど内部で使う完全なメールアドレスには影響させないこと。
function maskEmail(email) {
  const s = String(email || '').trim();
  if (!s) return '';
  const at = s.indexOf('@');
  if (at <= 0) return s;
  const local = s.slice(0, at);
  const domain = s.slice(at);
  const shown = local.length >= 2 ? local.slice(0, 2) : local;
  return shown + '***' + domain;
}

function toFullWidth(str) {
  if (!str) return '';
  let res = str.replace(/[!-~]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0))
    .replace(/ /g, '　');

  const kanaMap = {
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

  const sortedKeys = Object.keys(kanaMap).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    res = res.replace(new RegExp(key, 'g'), kanaMap[key]);
  }
  return res;
}

let _activeNameInputId = 'co-family-name';

function _getActiveNameInput() {
  return document.getElementById(_activeNameInputId) || document.getElementById('co-family-name');
}

function _getCheckoutNameParts() {
  return {
    family: document.getElementById('co-family-name')?.value?.trim() || '',
    given: document.getElementById('co-given-name')?.value?.trim() || '',
  };
}

function _getCheckoutFullName() {
  const { family, given } = _getCheckoutNameParts();
  return [family, given].filter(Boolean).join(' ');
}

function initNameInput() {
  const inputs = ['co-family-name', 'co-given-name']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  if (!inputs.length) return;

  inputs.forEach(el => {
    el.setAttribute('lang', 'ja');
    el.setAttribute('autocomplete', 'off');
    el.addEventListener('focus', () => {
      _activeNameInputId = el.id;
      inputs.forEach(input => input.closest('.name-input-field')?.classList.toggle('is-active', input === el));
    });

    // 外部から値が設定された場合も全角化を維持する。
    el.addEventListener('input', () => {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const converted = toFullWidth(el.value);
      if (converted !== el.value) {
        el.value = converted;
        try { el.setSelectionRange(start, end); } catch (_) { }
      }
    });
  });
}

/* ==========================================================================
   名前用オンスクリーンキーパッド
   （OS標準の画面キーボードを一切使わず、ひらがな／カタカナ／ローマ字の
   3種類のタブを切り替えながらタップだけで名前を入力する）
   ========================================================================== */

// 五十音表（あ段〜お段 × あ行〜わ行）。null は該当する音が存在しないマス。
// わ行の空きマス（い段・う段の2マス）には、専用の機能キー行を
// 別途設けず、この五十音表の中に埋め込む形で ん／ー を配置し、
// 行数を1段減らして縦の高さを抑えている（詳細は KANA_EXTRA_KEYS 参照）。
// 濁点(゛゜)は、五十音表のどこに埋め込んでも文字キーの間に紛れて
// 位置が分かりにくく押し間違いの元になるため、他の一般的なかな入力
// キーボードと同様に、常に同じ場所にある機能キー行（小／スペース／
// 削除／全消去の並び）の先頭に固定で配置する（KANA_LAST_ROW_EXTRA参照）。
const KANA_GOJUON = {
  hiragana: [
    ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ'],
    ['い', 'き', 'し', 'ち', 'に', 'ひ', 'み', null, 'り', null],
    ['う', 'く', 'す', 'つ', 'ぬ', 'ふ', 'む', 'ゆ', 'る', null],
    ['え', 'け', 'せ', 'て', 'ね', 'へ', 'め', null, 'れ', null],
    ['お', 'こ', 'そ', 'と', 'の', 'ほ', 'も', 'よ', 'ろ', 'を'],
  ],
  katakana: [
    ['ア', 'カ', 'サ', 'タ', 'ナ', 'ハ', 'マ', 'ヤ', 'ラ', 'ワ'],
    ['イ', 'キ', 'シ', 'チ', 'ニ', 'ヒ', 'ミ', null, 'リ', null],
    ['ウ', 'ク', 'ス', 'ツ', 'ヌ', 'フ', 'ム', 'ユ', 'ル', null],
    ['エ', 'ケ', 'セ', 'テ', 'ネ', 'ヘ', 'メ', null, 'レ', null],
    ['オ', 'コ', 'ソ', 'ト', 'ノ', 'ホ', 'モ', 'ヨ', 'ロ', 'ヲ'],
  ],
};

// 五十音表の null マス（わ行の空き2マス）に埋め込む機能キー。
// 行1（い段）に「ん」、行2（う段）に「ー」を配置する。
const KANA_EXTRA_KEYS = {
  hiragana: [
    { row: 1, ch: 'ん', label: 'ん' },
    { row: 2, ch: 'ー', label: 'ー' },
  ],
  katakana: [
    { row: 1, ch: 'ン', label: 'ン' },
    { row: 2, ch: 'ー', label: 'ー' },
  ],
};

// 濁点／半濁点を「゛」キーで巡回させるためのグループ（例：は→ば→ぱ→は）
const KANA_DAKUTEN_CYCLES = {
  hiragana: [
    ['か', 'が'], ['き', 'ぎ'], ['く', 'ぐ'], ['け', 'げ'], ['こ', 'ご'],
    ['さ', 'ざ'], ['し', 'じ'], ['す', 'ず'], ['せ', 'ぜ'], ['そ', 'ぞ'],
    ['た', 'だ'], ['ち', 'ぢ'], ['つ', 'づ'], ['て', 'で'], ['と', 'ど'],
    ['は', 'ば', 'ぱ'], ['ひ', 'び', 'ぴ'], ['ふ', 'ぶ', 'ぷ'], ['へ', 'べ', 'ぺ'], ['ほ', 'ぼ', 'ぽ'],
    ['う', 'ゔ'],
  ],
  katakana: [
    ['カ', 'ガ'], ['キ', 'ギ'], ['ク', 'グ'], ['ケ', 'ゲ'], ['コ', 'ゴ'],
    ['サ', 'ザ'], ['シ', 'ジ'], ['ス', 'ズ'], ['セ', 'ゼ'], ['ソ', 'ゾ'],
    ['タ', 'ダ'], ['チ', 'ヂ'], ['ツ', 'ヅ'], ['テ', 'デ'], ['ト', 'ド'],
    ['ハ', 'バ', 'パ'], ['ヒ', 'ビ', 'ピ'], ['フ', 'ブ', 'プ'], ['ヘ', 'ベ', 'ペ'], ['ホ', 'ボ', 'ポ'],
    ['ウ', 'ヴ'],
  ],
};

// 「小」キーで小文字（拗音・促音）と通常文字を切り替えるための対応表
const KANA_SMALL_TOGGLE = {
  hiragana: {
    'あ': 'ぁ', 'ぁ': 'あ', 'い': 'ぃ', 'ぃ': 'い', 'う': 'ぅ', 'ぅ': 'う',
    'え': 'ぇ', 'ぇ': 'え', 'お': 'ぉ', 'ぉ': 'お', 'つ': 'っ', 'っ': 'つ',
    'や': 'ゃ', 'ゃ': 'や', 'ゆ': 'ゅ', 'ゅ': 'ゆ', 'よ': 'ょ', 'ょ': 'よ',
    'わ': 'ゎ', 'ゎ': 'わ', 'か': 'ゕ', 'ゕ': 'か', 'け': 'ゖ', 'ゖ': 'け',
  },
  katakana: {
    'ア': 'ァ', 'ァ': 'ア', 'イ': 'ィ', 'ィ': 'イ', 'ウ': 'ゥ', 'ゥ': 'ウ',
    'エ': 'ェ', 'ェ': 'エ', 'オ': 'ォ', 'ォ': 'オ', 'ツ': 'ッ', 'ッ': 'ツ',
    'ヤ': 'ャ', 'ャ': 'ヤ', 'ユ': 'ュ', 'ュ': 'ユ', 'ヨ': 'ョ', 'ョ': 'ヨ',
    'ワ': 'ヮ', 'ヮ': 'ワ', 'カ': 'ヵ', 'ヵ': 'カ', 'ケ': 'ヶ', 'ヶ': 'ケ',
  },
};

const NAME_KEYPAD_ROMAJI_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

const NAME_MAX_LENGTH = 20;

let _nameKeyboardMode = 'hiragana';

function _delSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/>
    </svg>`;
}

function renderNameKeypad() {
  const pad = document.getElementById('co-name-keypad');
  if (!pad) return;

  document.querySelectorAll('#co-name-kbd-tabs .name-kbd-tab').forEach(tab => {
    const active = tab.dataset.mode === _nameKeyboardMode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (_nameKeyboardMode === 'romaji') {
    pad.className = 'onkey-pad onkey-pad--kana onkey-pad--romaji';
    pad.innerHTML = NAME_KEYPAD_ROMAJI_ROWS.map(row => `
      <div class="onkey-row">
        ${row.map(ch => `<button type="button" class="onkey-key" data-ch="${ch}">${ch}</button>`).join('')}
      </div>
    `).join('') + `
      <div class="onkey-row onkey-row--actions">
        <button type="button" class="onkey-key onkey-key--space" data-ch=" ">スペース</button>
        <button type="button" class="onkey-key onkey-key--del" id="co-name-key-del">${_delSvg()}</button>
      </div>
      <div class="onkey-row">
        <button type="button" class="onkey-key onkey-key--ghost onkey-key--func" id="co-name-key-clear">全消去</button>
      </div>
    `;
    return;
  }

  // ひらがな／カタカナ：五十音表に ん／ー／濁点(゛゜) を埋め込み、
  // 「小文字」／スペース／削除／全消去だけを最終行にまとめることで、
  // 専用の機能キー行を1段削減し、キーパッド全体の縦幅を抑えている。
  const table = KANA_GOJUON[_nameKeyboardMode];
  const extras = KANA_EXTRA_KEYS[_nameKeyboardMode] || [];

  pad.className = 'onkey-pad onkey-pad--kana';
  pad.innerHTML = table.map((row, rowIndex) => {
    const extra = extras.find(x => x.row === rowIndex);
    return `
    <div class="onkey-row">
      ${row.map((ch, colIndex) => {
      // このマスが null（わ行の空き）かつ、ここに埋め込む機能キーが
      // 指定されている場合は、その機能キーをここに描画する。
      if (!ch && extra && colIndex === row.length - 1) {
        const cls = extra.func ? 'onkey-key onkey-key--func onkey-key--inline-func' : 'onkey-key onkey-key--inline-extra';
        const attr = extra.id ? `id="${extra.id}"` : `data-ch="${extra.ch}"`;
        return `<button type="button" class="${cls}" ${attr}>${extra.label}</button>`;
      }
      return ch
        ? `<button type="button" class="onkey-key" data-ch="${ch}">${ch}</button>`
        : `<span class="onkey-key onkey-key--spacer"></span>`;
    }).join('')}
    </div>
  `;
  }).join('') + `
    <div class="onkey-row">
      <button type="button" class="onkey-key onkey-key--func" id="co-name-key-dakuten">゛゜</button>
      <button type="button" class="onkey-key onkey-key--func" id="co-name-key-small">小文字</button>
      <button type="button" class="onkey-key onkey-key--space" data-ch=" ">スペース</button>
      <button type="button" class="onkey-key onkey-key--del" id="co-name-key-del">${_delSvg()}</button>
      <button type="button" class="onkey-key onkey-key--ghost onkey-key--func" id="co-name-key-clear">全消去</button>
    </div>
  `;
}

function appendNameChar(ch) {
  const el = _getActiveNameInput();
  if (!el) return;
  if (el.value.length >= NAME_MAX_LENGTH) {
    vibrate(15);
    return;
  }
  el.value = el.value + ch;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  vibrate(8);
}

function deleteNameChar() {
  const el = _getActiveNameInput();
  if (!el || !el.value) return;
  el.value = el.value.slice(0, -1);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  vibrate(8);
}

function clearNameInput() {
  const el = _getActiveNameInput();
  if (!el || !el.value) return;
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  vibrate([10, 20, 10]);
  _shakeElement(el);
}

// 「゛゜」「小文字」キーは、ひらがな／カタカナのどちらでも
//「直前の1文字を取り出し、濁点を巡回させる／大小を入れ替える」という
//同じ規則で動く。昔はこの2つで重複した実装だったが、判定条件が微妙に
//ずれていたため、共通パイプライン1本にまとめる。
//
// 分解済みかな（NFD: 「は」+濁点のように2コードポイントで入る状態）が
//渡ってきても末尾1文字の判定が壊れないよう、毎回 NFC に合成してから扱う。
function _composeKanaText(text) {
  if (typeof text !== 'string' || !text) return '';
  return typeof text.normalize === 'function' ? text.normalize('NFC') : text;
}

// 直前の文字に濁点/半濁点を次の段階へ進める。対象の文字でなければ null。
function _nextDakutenChar(last) {
  const cycles = KANA_DAKUTEN_CYCLES[_nameKeyboardMode];
  if (!cycles) return null;
  for (const cycle of cycles) {
    const i = cycle.indexOf(last);
    if (i !== -1) return cycle[(i + 1) % cycle.length];
  }
  return null;
}

// 直前の文字を小文字化、または小文字を通常文字に戻す。対象外なら null。
function _nextSmallChar(last) {
  const map = KANA_SMALL_TOGGLE[_nameKeyboardMode];
  if (!map) return null;
  return map[last] || null;
}

function _applyNameModifier(nextCharOf) {
  const el = _getActiveNameInput();
  if (!el || !el.value) return;
  const text = _composeKanaText(el.value);
  const next = nextCharOf(text.slice(-1));
  if (!next) { vibrate(15); return; }
  el.value = text.slice(0, -1) + next;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  vibrate(8);
}

function toggleNameDakuten() { _applyNameModifier(_nextDakutenChar); }

function toggleNameSmall() { _applyNameModifier(_nextSmallChar); }

function setNameKeyboardMode(mode) {
  if (!KANA_GOJUON[mode] && mode !== 'romaji') return;
  if (_nameKeyboardMode === mode) return;
  _nameKeyboardMode = mode;
  vibrate(15);
  renderNameKeypad();
}

function resetNameKeyboardMode() {
  _nameKeyboardMode = 'hiragana';
  renderNameKeypad();
}

function initNameKeypad() {
  const tabs = document.getElementById('co-name-kbd-tabs');
  if (tabs) {
    tabs.addEventListener('click', e => {
      const btn = e.target.closest('.name-kbd-tab');
      if (!btn) return;
      setNameKeyboardMode(btn.dataset.mode);
    });
  }

  const pad = document.getElementById('co-name-keypad');
  if (!pad) return;

  pad.addEventListener('click', e => {
    const keyBtn = e.target.closest('.onkey-key');
    if (!keyBtn || keyBtn.classList.contains('onkey-key--spacer')) return;

    if (keyBtn.id === 'co-name-key-del') { deleteNameChar(); return; }
    if (keyBtn.id === 'co-name-key-clear') { clearNameInput(); return; }
    if (keyBtn.id === 'co-name-key-dakuten') { toggleNameDakuten(); return; }
    if (keyBtn.id === 'co-name-key-small') { toggleNameSmall(); return; }

    const ch = keyBtn.dataset.ch;
    if (ch !== undefined) appendNameChar(ch);
  });

  renderNameKeypad();
}

function initEmailPartInput() {
  // 学籍番号部分はOS標準の画面キーボードを一切使わず、専用のオンスクリーン
  // キーパッド（renderEmailKeypad/appendEmailChar/deleteEmailChar）だけで
  // 入力させる。この関数はキーパッドが値を書き換えるたびに発火する
  // 'input' イベントを受けて、全角数字の正規化や許可文字以外の除去を行う
  // 正規化レイヤーとして残す（キーパッド側で既に正しい文字だけを積んでいる
  // ため実質的には保険だが、念のため二重チェックする）。
  const el = document.getElementById('co-email-part');
  if (!el) return;

  el.addEventListener('input', () => {
    let val = el.value;

    val = val.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));

    const inputType = _selectedEmailPattern ? _selectedEmailPattern.inputType : 'digits';
    let filtered = val;
    if (inputType === 'digits') {
      filtered = val.replace(/[^0-9]/g, '');
    } else if (inputType === 'alnum') {
      filtered = val.replace(/[^0-9a-zA-Z]/g, '');
    }

    if (filtered !== el.value) {
      el.value = filtered;
    }
    _updateEmailKeypadCaret();
  });
}

/* ==========================================================================
   学籍番号用オンスクリーンキーパッド
   （OS標準の画面キーボードを一切使わず、タップだけで学籍番号を入力する）
   ========================================================================== */

const EMAIL_KEYPAD_ALNUM_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

function renderEmailKeypad(pattern) {
  const pad = document.getElementById('co-email-keypad');
  if (!pad) return;

  const inputType = pattern ? pattern.inputType : 'digits';

  if (inputType === 'alnum') {
    pad.className = 'onkey-pad onkey-pad--alnum';
    pad.innerHTML = EMAIL_KEYPAD_ALNUM_ROWS.map(row => `
      <div class="onkey-row">
        ${row.map(ch => `<button type="button" class="onkey-key" data-ch="${ch}">${ch}</button>`).join('')}
      </div>
    `).join('') + `
      <div class="onkey-row onkey-row--actions">
        <button type="button" class="onkey-key onkey-key--wide onkey-key--del" id="co-email-key-del">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/>
          </svg>
          削除
        </button>
      </div>
    `;
  } else {
    // 数字専用（学籍番号の多くはこちら）：電話番号入力のような3列テンキー
    pad.className = 'onkey-pad onkey-pad--numeric';
    pad.innerHTML = `
      <div class="onkey-row">
        <button type="button" class="onkey-key" data-ch="1">1</button>
        <button type="button" class="onkey-key" data-ch="2">2</button>
        <button type="button" class="onkey-key" data-ch="3">3</button>
      </div>
      <div class="onkey-row">
        <button type="button" class="onkey-key" data-ch="4">4</button>
        <button type="button" class="onkey-key" data-ch="5">5</button>
        <button type="button" class="onkey-key" data-ch="6">6</button>
      </div>
      <div class="onkey-row">
        <button type="button" class="onkey-key" data-ch="7">7</button>
        <button type="button" class="onkey-key" data-ch="8">8</button>
        <button type="button" class="onkey-key" data-ch="9">9</button>
      </div>
      <div class="onkey-row">
        <button type="button" class="onkey-key onkey-key--ghost" id="co-email-key-clear">全消去</button>
        <button type="button" class="onkey-key" data-ch="0">0</button>
        <button type="button" class="onkey-key onkey-key--del" id="co-email-key-del">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/>
          </svg>
        </button>
      </div>
    `;
  }
}

function _emailMaxLength() {
  return _selectedEmailPattern ? (_selectedEmailPattern.length || 4) : 4;
}

function appendEmailChar(ch) {
  const el = document.getElementById('co-email-part');
  if (!el) return;
  const max = _emailMaxLength();
  if (el.value.length >= max) {
    vibrate(15);
    return;
  }
  el.value = el.value + ch;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  vibrate(8);
}

function deleteEmailChar() {
  const el = document.getElementById('co-email-part');
  if (!el || !el.value) return;
  el.value = el.value.slice(0, -1);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  vibrate(8);
}

function clearEmailInput() {
  const el = document.getElementById('co-email-part');
  if (!el || !el.value) return;
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  vibrate([10, 20, 10]);
  // 入力欄自体を軽くシェイクして、クリア操作が視覚的にも伝わるようにする。
  _shakeElement(document.querySelector('.email-input-group') || el);
}

// キーパッドで入力中であることが見た目でも分かるよう、入力欄に
// 「アクティブ」状態のスタイルを付ける（フォーカスリングの代わり）。
function _updateEmailKeypadCaret() {
  const el = document.getElementById('co-email-part');
  const group = document.querySelector('.email-input-group');
  if (!el || !group) return;
  const max = _emailMaxLength();
  group.classList.toggle('email-input-group--full', el.value.length >= max);
}

function initEmailKeypad() {
  const pad = document.getElementById('co-email-keypad');
  if (!pad) return;

  pad.addEventListener('click', e => {
    const keyBtn = e.target.closest('.onkey-key');
    if (!keyBtn) return;

    if (keyBtn.id === 'co-email-key-del') {
      deleteEmailChar();
      return;
    }
    if (keyBtn.id === 'co-email-key-clear') {
      clearEmailInput();
      return;
    }
    const ch = keyBtn.dataset.ch;
    if (ch !== undefined) appendEmailChar(ch);
  });

}

let _selectedEmailPattern = null;

function normalizeEmailPattern(p) {
  if (!p) return p;
  if (typeof p.template === 'string' && p.template.includes('{{input}}')) {
    return {
      label: p.label || '',
      template: p.template,
      length: p.length || p.digits || 4,
      inputType: p.inputType || 'digits',
    };
  }
  return {
    label: p.label || '',
    template: `${p.prefix || ''}{{input}}${p.suffix || ''}`,
    length: p.length || p.digits || 4,
    inputType: p.inputType || 'digits',
  };
}

function _splitEmailTemplate(template) {
  const marker = '{{input}}';
  const idx = (template || '').indexOf(marker);
  if (idx === -1) return { prefix: template || '', suffix: '' };
  return {
    prefix: template.slice(0, idx),
    suffix: template.slice(idx + marker.length),
  };
}

function renderEmailPatterns() {
  const container = document.getElementById('co-email-patterns');
  if (!container || !_sysSettings.emailPatterns) return;

  _sysSettings.emailPatterns = _sysSettings.emailPatterns.map(normalizeEmailPattern);

  const prevLabel = _selectedEmailPattern ? _selectedEmailPattern.label : null;

  container.innerHTML = _sysSettings.emailPatterns.map((p, i) => `
    <div class="email-chip" data-index="${i}" onclick="selectEmailPattern(${i}, true)">
      ${escHtml(p.label)}
    </div>
  `).join('');

  let idx = _sysSettings.emailPatterns.findIndex(p => p.label === prevLabel);
  if (idx === -1 && _sysSettings.emailPatterns.length > 0) idx = 0;

  if (idx !== -1) {
    selectEmailPattern(idx);
  }
}

// パターンを比較するための識別子。ラベル/テンプレート/桁数/文字種の
// いずれかが違えば別のパターンとして扱う。
function _emailPatternSignature(p) {
  if (!p) return '';
  return `${p.label || ''}|${p.template || ''}|${p.length}|${p.inputType || ''}`;
}

function selectEmailPattern(index, fromUserTap) {
  const patterns = _sysSettings.emailPatterns || [];
  const p = patterns[index];
  if (!p) return;

  if (fromUserTap) vibrate(15);

  // 実際に別のパターン（学年）に変わったときだけ入力済みの学籍番号を消す。
  // goTo() から applySettingsToUI() → renderEmailPatterns() が毎回同じ
  // インデックスを再適用する経路では前後に差がないため、入力内容は保持される。
  const prevSignature = _emailPatternSignature(_selectedEmailPattern);
  const patternChanged = !!prevSignature && prevSignature !== _emailPatternSignature(p);

  _selectedEmailPattern = p;

  document.querySelectorAll('.email-chip').forEach((chip, i) => {
    chip.classList.toggle('active', i === index);
  });

  const prefixEl = document.getElementById('co-email-prefix');
  const suffixEl = document.getElementById('co-email-suffix');
  const partEl = document.getElementById('co-email-part');

  const { prefix, suffix } = _splitEmailTemplate(p.template);
  if (prefixEl) prefixEl.textContent = prefix;
  if (suffixEl) suffixEl.textContent = suffix;
  if (partEl) {
    partEl.maxLength = p.length;
    partEl.placeholder = '○'.repeat(p.length);

    // OS標準の画面キーボードは一切使わない設計のため、inputmodeは常に
    // "none"（＋readonly属性はHTML側で固定）にし、文字種の区別は
    // renderEmailKeypad() が出し分けるオンスクリーンキーパッドの方で行う。
    partEl.inputMode = 'none';
    if (p.inputType === 'digits') {
      partEl.setAttribute('pattern', '[0-9]*');
    } else if (p.inputType === 'alnum') {
      partEl.setAttribute('pattern', '[0-9a-zA-Z]*');
    } else {
      partEl.removeAttribute('pattern');
    }

    if (patternChanged) {
      // 学年を変えたのに前の学年の学籍番号が残っていると、次の学年と桁数が
      // 違うときに「N桁で入力してください」エラーになるだけなので、新しく入力
      // し直させる。先頭（1年生）へのリセット時は前パターン無しなので消さない
      // （その場合は resetCheckoutForm 側で入力欄ごと空になる）。
      partEl.value = '';
    } else if (partEl.value.length > p.length) {
      partEl.value = partEl.value.slice(0, p.length);
    }
  }

  renderEmailKeypad(p);
  _updateEmailKeypadCaret();
}

async function fetchSettings() {
  try {
    const res = await fetch(`${ARDUINO_SERVER}/settings?_t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (typeof _setConnState === 'function') _setConnState('server', true);
    if (typeof _sysSettings !== 'undefined') {
      Object.assign(_sysSettings, data);
      if (Array.isArray(_sysSettings.emailPatterns)) {
        _sysSettings.emailPatterns = _sysSettings.emailPatterns.map(normalizeEmailPattern);
      }
    }


    if (typeof stopIdleTimer === 'function' && typeof startIdleTimer === 'function') {
      if (_sysSettings.idleTimeoutEnabled !== true) {
        stopIdleTimer();
      } else {
        startIdleTimer();
      }
    }
  } catch (e) {
    if (typeof _setConnState === 'function') _setConnState('server', false);
    console.warn('設定の取得に失敗しました:', e);
  }
}

function applySettingsToUI() {
  renderEmailPatterns();

  // 貸出フォームはステップ入力（1画面1項目）になっているため、行の表示/非表示は
  // ウィザード側（renderCheckoutStep）でステップに応じて制御する。ここでは設定変更に
  // 合わせてステップの構成（どの項目が必要か）だけを更新し、入力途中の場合は
  // 現在のステップ位置はできるだけ保持する。
  updateCheckoutSteps(false);

  const selectedLoan = window._selectedLoan;
  const returnVerifyRequired = isReturnVerificationRequiredForLoan(selectedLoan);
  const returnLayout = document.querySelector('#page-return-confirm .return-confirm-layout');
  if (returnLayout) returnLayout.style.display = returnVerifyRequired ? '' : 'none';
  const rcQuestion = document.querySelector('#page-return-confirm .confirm-question');
  if (rcQuestion) {
    rcQuestion.style.display = returnVerifyRequired ? '' : 'none';
  }

  const maintenanceOverlay = document.getElementById('maintenance-overlay');
  if (maintenanceOverlay) {
    maintenanceOverlay.style.display = (_sysSettings.maintenanceMode) ? 'flex' : 'none';
    document.getElementById('maintenance-title').textContent = 'システムメンテナンス中';
    document.getElementById('maintenance-msg').innerHTML = '現在、システムの保守点検を行っております。<br>しばらくお待ちください。';
  }

  const deadlineEl = document.getElementById('warn-deadline-time');
  if (deadlineEl) {
    const h = (typeof _sysSettings.returnDeadlineHour === 'number') ? _sysSettings.returnDeadlineHour : 16;
    const m = (typeof _sysSettings.returnDeadlineMinute === 'number') ? _sysSettings.returnDeadlineMinute : 0;
    deadlineEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  if (typeof _updateActionCards === 'function') _updateActionCards();

  _applyLogoutCheckMode();
}

function isReturnVerificationRequiredForLoan(loan) {
  return _sysSettings.returnVerify === true && !!loan && loan.returnVerifyRequired === true;
}

window.addEventListener('load', async () => {
  startClock();
  initNameInput();
  initNameKeypad();
  initEmailPartInput();
  initEmailKeypad();
  initDobPicker('co-dob');
  initDobKeypad('co-dob');
  initDobPicker('rc-dob');
  initDobKeypad('rc-dob');
  _initDoorGrid();

  // 貸出ステップ入力：名前欄・学籍番号欄でEnterキーを押したら次のステップへ進む
  ['co-family-name', 'co-given-name', 'co-email-part'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      document.getElementById('checkout-btn')?.click();
    });
  });

  showLoading('起動準備中...', '設定を読み込んでいます', 'sync', 10);

  // 各段階で「データ読み込み・準備」を確実に行い、それらが完了してから
  // ローディングを終了する。ネットワーク障害時に永遠に待たないよう、
  // 各ステップには合理的なタイムアウトを設ける(タイムアウト時は
  // キャッシュ/既定値で起動し、ローディングは必ず終了させる)。
  const BOOT_STEP_TIMEOUT_MS = 8000;
  const withTimeout = (p, ms = BOOT_STEP_TIMEOUT_MS) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);

  try {
    await withTimeout(fetchSettings());
  } catch (e) {
    console.warn('起動時の設定取得がタイムアウトまたは失敗しました。既定値で起動します:', e.message);
  }

  applySettingsToUI();

  showLoading('データを同期中...', '貸出情報を取得しています', 'sync', 35);
  try {
    await withTimeout(syncLoans());
  } catch (e) {
    console.warn('起動時の同期失敗:', e);
  }

  // 前回、返却処理がネットワーク障害等で送信できずキューに残っている場合、
  // ここで再送を試みる。エラー画面で「ネットワーク復帰後に自動的に再試行
  // します」と案内している内容を実際に実行する処理。
  try {
    await withTimeout(_retryPendingReturns());
  } catch (e) {
    console.warn('保留中の返却の再送に失敗しました:', e);
  }

  showLoading('端末を確認中...', '12台の端末の状態を取得しています', 'sync', 65);
  try {
    await withTimeout(refreshDoorGrid());
  } catch (e) {
    console.warn('起動時の扉状態の取得失敗:', e);
  }

  updateStatusBanner();
  if (typeof _updateActionCards === 'function') _updateActionCards();

  // 貸出・返却の最初の操作はカメラを使うため、準備完了の一部として
  // カメラ初期化も完了させてからローディングを終了する。
  // カメラが無い・失敗した場合もブロックせず、そのまま起動を続ける。
  showLoading('カメラを準備中...', '本人確認の準備をしています', 'sync', 90);
  try {
    await withTimeout(CameraModule.init(), 6000);
  } catch (e) {
    console.warn('カメラの初期化に失敗しました(起動には影響しません):', e);
  }

  goTo('top');

  showLoading('準備完了', '', 'return', 100);
  await new Promise(r => setTimeout(r, 400));
  hideLoading();

  // 画面の初期描画・初回データ取得(設定・貸出状況・扉状態・Arduino接続状態)が
  // すべて完了してから、はじめて演出用アニメーション(接続状態バナー等)を
  // 有効にする。これより前に状態が変化しても、読み込み中の一瞬の切り替わりが
  // 目立たないよう、CSS側でトランジションを無効化してある。
  document.body.classList.add('is-app-ready');

  let _lastSettingsUpdatedAt = null;
  setInterval(async () => {
    try {
      const res = await fetch(`${ARDUINO_SERVER}/settings/meta?_t=${Date.now()}`);
      const meta = await res.json();
      if (meta.ok && meta.updatedAt && meta.updatedAt !== _lastSettingsUpdatedAt) {
        _lastSettingsUpdatedAt = meta.updatedAt;
        await fetchSettings();
        applySettingsToUI();
      }
      if (!_lastSettingsUpdatedAt && meta.updatedAt) {
        _lastSettingsUpdatedAt = meta.updatedAt;
      }
    } catch (_) { }
  }, 30000);

  setInterval(() => {
    const topPage = document.getElementById('page-top');
    if (topPage && topPage.classList.contains('active')) {
      refreshDoorGrid().catch(() => { });
    }
  }, 3000);

  setInterval(() => {
    const topPage = document.getElementById('page-top');
    if (topPage && topPage.classList.contains('active') && typeof _isGasOnCooldown === 'function' && _isGasOnCooldown()) {
      updateStatusBanner();
    }
  }, 1000);

  // キオスク運用ではページ再読み込みがほぼ発生しないため、起動時だけでなく
  // 定期的にも保留中の返却の再送を試みる(ネットワーク瞬断からの自動復旧)。
  setInterval(() => {
    _retryPendingReturns().catch(() => { });
  }, 60000);

  _initTopSse();

});

let _topSse = null;
let _sseRetryDelay = 1000;
let _sseReconnectTimer = null;
const SSE_MAX_RETRY = 30000;

function _initTopSse() {
  if (!window.EventSource) return;
  if (_topSse) _topSse.close();

  _topSse = new EventSource(`${ARDUINO_SERVER}/arduino/stream`);
  _topSse.onmessage = (e) => {
    _sseRetryDelay = 1000;
    if (typeof _setConnState === 'function') _setConnState('server', true);
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'door_change') {
        const topPage = document.getElementById('page-top');
        if (topPage && topPage.classList.contains('active')) {
          dlog(`[TopSSE] Door change: ${data.deviceId} -> ${data.state}`);
          _updateDoorCacheAndRender(data.deviceId, data.state);
        }
      } else if (data.type === 'arduino_status') {
        dlog(`[TopSSE] Arduino status: ${data.connected ? '接続' : '切断'}`);
        // まずSSEイベント自体が持つ最新の接続状態を即座に反映し（切断・再接続を
        // 画面に一切ラグなく出す）、そのうえで扉の詳細状態を取りに行く。
        if (typeof _setConnState === 'function') _setConnState('arduino', !!data.connected);
        if (!data.connected && typeof _handleArduinoDisconnectedDuringCheckout === 'function') {
          _handleArduinoDisconnectedDuringCheckout();
        }
        if (typeof _updateActionCards === 'function') _updateActionCards();
        refreshDoorGrid().catch(() => { });
      }
    } catch (err) { }
  };
  _topSse.onerror = () => {
    _topSse.close();
    const delay = _sseRetryDelay;
    _sseRetryDelay = Math.min(_sseRetryDelay * 1.5, SSE_MAX_RETRY);
    if (_sseReconnectTimer) clearTimeout(_sseReconnectTimer);
    _sseReconnectTimer = setTimeout(_initTopSse, delay);
  };
}

function _updateDoorCacheAndRender(deviceId, state) {
  if (!_doorStatusCache) return;
  try {
    const doors = JSON.parse(_doorStatusCache);
    doors[deviceId] = state;
    _doorStatusCache = JSON.stringify(doors);
    _renderDoorGrid(doors, true);
  } catch (e) {
    _doorStatusCache = null;
    _loanCache = null;
  }
}

let _syncLoansBusy = false;
async function syncLoans() {
  if (_syncLoansBusy) return;
  _syncLoansBusy = true;
  try {
    const [resL, resF] = await Promise.all([
      gasCall('getLoans'),
      gasCall('getFailures')
    ]);
    if (resL.success) store.loans = resL.loans || [];
    if (resF.success) store.failures = resF.failures || [];
    if (typeof _saveCache === 'function') {
      _saveCache(CACHE_KEYS.loans, store.loans);
      _saveCache(CACHE_KEYS.failures, store.failures);
    }
  } catch (e) {
    if (!e._gasCooldown) {
      console.warn('貸出・故障データ読み込み失敗:', e);
    }
    if (typeof _loadCache === 'function' && typeof CACHE_KEYS !== 'undefined') {
      const cachedLoans = _loadCache(CACHE_KEYS.loans);
      const cachedFailures = _loadCache(CACHE_KEYS.failures);
      if (cachedLoans && cachedLoans.data) store.loans = cachedLoans.data;
      if (cachedFailures && cachedFailures.data) store.failures = cachedFailures.data;
    }
  } finally {
    _syncLoansBusy = false;
  }
}

async function goToCheckout() {
  if (_processing) return;
  vibrate(20);
  if (typeof _isFullyConnected === 'function' && !_isFullyConnected()) {
    showCustomAlert('お知らせ', 'サーバーに接続されていないため、貸出は利用できません。');
    return;
  }
  if (typeof _connState !== 'undefined' && _connState.arduino === false) {
    showCustomAlert('お知らせ', 'Arduino（施錠装置）が接続されていないため、現在貸出はご利用いただけません。しばらくお待ちいただくか、係の先生にお知らせください。');
    return;
  }
  if (_sysSettings.maintenanceMode) {
    showCustomAlert('お知らせ', 'ただいまシステムメンテナンス中のため、ご利用いただけません。');
    return;
  }
  if (_sysSettings.lendingSuspended) {
    showCustomAlert('お知らせ', '現在、端末の貸出を休止しています。');
    return;
  }
  // 空き0台なら入力画面・カメラ録画に進まず、他の休止と同じアラートで止める。
  if (typeof _getAvailableDeviceCount === 'function' && _getAvailableDeviceCount() <= 0) {
    showCustomAlert('お知らせ', '現在、貸出できる端末がありません。返却されるまでしばらくお待ちください。');
    return;
  }
  showLoading('カメラ準備中...');
  if (CameraModule.isRecording()) {
    await CameraModule.stopAndDeleteRecording('orphan');
  }
  goTo('checkout');
  initCheckoutSteps();
  try {
    await CameraModule.startRecording({
      action: 'checkout_form',
      kind: 'checkout', // 録画の種別（貸出）を明示する
      startedAt: new Date().toISOString(),
    }, 'checkout');
  } catch (e) {
    console.warn('録画開始失敗:', e);
  } finally {
    hideLoading();
  }
}

// 貸出フォーム入力中（端末をまだ確保していない段階）にArduinoが切断された場合、
// そのまま入力を続けさせても最終的に解錠できず行き詰まるため、その場で
// 貸出手続きを中止してトップ画面へ戻す。
// すでに finalizeCheckout() 側で通信中(_processing)の場合は、途中で横から
// 割り込むと「端末は確保されたのに画面だけトップに戻る」といった不整合が
// 起きうるため、ここでは何もしない（その場合は解錠失敗時の手動完了フローが
// 自然に働き、Arduino切断中である旨は画面上部のバナーで案内され続ける）。
function _handleArduinoDisconnectedDuringCheckout() {
  const abortPageNames = ['checkout', 'checkout-confirm'];
  const activeEl = document.querySelector('.page.active');
  const shortName = activeEl ? activeEl.id.replace('page-', '') : '';
  if (!abortPageNames.includes(shortName)) return;
  if (_processing) return;

  vibrate([80, 40, 80]);
  if (typeof CameraModule !== 'undefined' && CameraModule.isRecording && CameraModule.isRecording()) {
    CameraModule.stopAndDeleteRecording('arduino_disconnected').catch(() => { });
  }
  showCustomAlert(
    '貸出を中止しました',
    'Arduino（施錠装置）との接続が切れたため、安全のため貸出手続きを中止しました。しばらくしてから、もう一度お試しください。'
  ).then(() => {
    goTo('top', true);
  });
}

async function goToReturn() {
  if (_processing) return;
  vibrate(20);
  if (typeof _isFullyConnected === 'function' && !_isFullyConnected()) {
    showCustomAlert('お知らせ', 'サーバーに接続されていないため、返却は利用できません。');
    return;
  }
  if (_sysSettings.maintenanceMode) {
    showCustomAlert('お知らせ', 'ただいまシステムメンテナンス中のため、ご利用いただけません。');
    return;
  }
  if (_sysSettings.lendingSuspended) {
    showCustomAlert('お知らせ', '現在、端末の返却を休止しています。');
    return;
  }
  goTo('return-select');
}

/* ==========================================================================
   貸出フォーム：ステップ入力ウィザード
   （名前 → メールアドレス → 生年月日 を1画面1項目ずつ入力させる）
   ========================================================================== */

const CHECKOUT_STEP_ROW_ID = {
  name: 'row-co-name',
  grade: 'row-co-grade',
  email: 'row-co-email',
  dob: 'row-co-dob',
};

const CHECKOUT_STEP_LABEL = {
  name: 'お名前を入力してください',
  grade: '学年を選択してください',
  email: '学籍番号を入力してください',
  dob: '生年月日を入力してください（本人確認）',
};

let _checkoutSteps = ['name', 'grade', 'email', 'dob'];
let _checkoutStepIndex = 0;

function _computeCheckoutSteps() {
  const steps = [];
  const showName = (_sysSettings.checkoutFields === 'all' || _sysSettings.checkoutFields === 'name');
  const showEmail = (_sysSettings.checkoutFields === 'all' || _sysSettings.checkoutFields === 'email_dob');
  // 学年（メールパターン）選択は、選べる学年が2つ以上ある場合だけ独立したステップにする。
  // 1つしか設定されていない場合はそれを自動選択し、わざわざ聞かない。
  const patternCount = (_sysSettings.emailPatterns || []).length;
  const showGrade = showEmail && patternCount > 1;
  const showDob = !!_sysSettings.returnVerify;
  if (showName) steps.push('name');
  if (showGrade) steps.push('grade');
  if (showEmail) steps.push('email');
  if (showDob) steps.push('dob');
  return steps.length ? steps : ['name'];
}

// checkout画面に入る際に呼び出し、ステップを最初(お名前)からやり直す
function initCheckoutSteps() {
  // 前の生徒が選んだ学年が残らないよう、毎回1年生（先頭のパターン）にリセットしてから開始する
  resetGradeSelection();
  // 名前の文字種タブも前の生徒の状態を引き継がないよう、毎回ひらがなに戻す
  if (typeof resetNameKeyboardMode === 'function') resetNameKeyboardMode();
  _checkoutSteps = _computeCheckoutSteps();
  _checkoutStepIndex = 0;
  renderCheckoutStep();
}

// resetGradeSelection() は先頭パターンを自動選択するため、「学年を
// 選択してください」で止められるよう、ユーザーによる明示選択があったかを
// 別に追跡する。validateCheckoutStep('grade')（＝「次へ」ボタン）で参照する。
let _gradePickedByUser = false;

// 学年選択を初期状態（先頭＝1年生想定）に戻す
function resetGradeSelection() {
  _selectedEmailPattern = null;
  _gradePickedByUser = false;
  const patterns = _sysSettings.emailPatterns || [];
  if (patterns.length > 0) selectEmailPattern(0);
}

// 設定変更などで表示項目が変わったときの再計算。既に入力を始めている場合、
// 極力ステップ位置を保つ（該当ステップが無くなった場合のみ丸める）。
function updateCheckoutSteps(resetIndex) {
  const prevStepId = _checkoutSteps[_checkoutStepIndex];
  _checkoutSteps = _computeCheckoutSteps();

  if (resetIndex) {
    _checkoutStepIndex = 0;
  } else {
    let idx = _checkoutSteps.indexOf(prevStepId);
    if (idx === -1) idx = Math.min(_checkoutStepIndex, _checkoutSteps.length - 1);
    _checkoutStepIndex = Math.max(0, idx);
  }
  renderCheckoutStep();
}

let _lastCheckoutStepIndex = -1;

function renderCheckoutStep() {
  if (!_checkoutSteps.length) return;
  const currentStepId = _checkoutSteps[_checkoutStepIndex];
  const direction = _checkoutStepIndex >= _lastCheckoutStepIndex ? 'next' : 'back';
  _lastCheckoutStepIndex = _checkoutStepIndex;

  Object.keys(CHECKOUT_STEP_ROW_ID).forEach(stepId => {
    const row = document.getElementById(CHECKOUT_STEP_ROW_ID[stepId]);
    if (!row) return;
    const wasHidden = row.style.display === 'none';
    row.style.display = (stepId === currentStepId) ? '' : 'none';
    if (stepId === currentStepId && wasHidden) {
      // 直前まで非表示だった行が表示された = ステップが切り替わった。
      // スライドイン演出を付与する（前方/後方で方向を変える）。
      row.classList.remove('step-anim-next', 'step-anim-back');
      // 再付与時にアニメーションが必ず再生されるよう強制リフロー
      void row.offsetWidth;
      row.classList.add(direction === 'next' ? 'step-anim-next' : 'step-anim-back');
    }
  });

  const labelEl = document.getElementById('checkout-section-label');
  if (labelEl) labelEl.textContent = CHECKOUT_STEP_LABEL[currentStepId] || '利用者情報';

  const backBtn = document.querySelector('#page-checkout .back-btn');
  if (backBtn) {
    backBtn.setAttribute('aria-label', _checkoutStepIndex > 0 ? '前のステップに戻る' : 'トップに戻る');
  }

  const isMultiStep = _checkoutSteps.length > 1;
  const dotsEl = document.getElementById('checkout-step-dots');
  if (dotsEl) {
    dotsEl.style.display = isMultiStep ? '' : 'none';
    dotsEl.innerHTML = _checkoutSteps.map((s, i) => {
      const cls = i === _checkoutStepIndex ? 'active' : (i < _checkoutStepIndex ? 'done' : '');
      return `<span class="step-dot ${cls}"></span>`;
    }).join('');
  }
  const countEl = document.getElementById('checkout-step-count');
  if (countEl) {
    countEl.textContent = isMultiStep ? `${_checkoutStepIndex + 1} / ${_checkoutSteps.length}` : '';
  }

  const isLastStep = _checkoutStepIndex === _checkoutSteps.length - 1;
  const btn = document.getElementById('checkout-btn');
  if (btn) {
    btn.innerHTML = isLastStep ? BTN_HTML.checkout : BTN_HTML.checkoutNext;
    btn.onclick = isLastStep ? doCheckout : checkoutGoNext;
  }

  requestAnimationFrame(() => {
    if (currentStepId === 'name') {
      const { family, given } = _getCheckoutNameParts();
      document.getElementById(family ? 'co-given-name' : 'co-family-name')?.focus({ preventScroll: true });
    } else if (currentStepId === 'email') {
      document.getElementById('co-email-part')?.focus({ preventScroll: true });
    }
  });
}

function validateCheckoutStep(stepId) {
  if (stepId === 'name') {
    const { family, given } = _getCheckoutNameParts();
    if (!family || !given) {
      vibrate(80);
      const missingPart = family ? '名' : '姓';
      document.getElementById(family ? 'co-given-name' : 'co-family-name')?.focus({ preventScroll: true });
      showFlash('checkout', 'error', `${missingPart}を入力してください`);
      return false;
    }
    return true;
  }

  if (stepId === 'grade') {
    // resetGradeSelection() が先頭パターンを自動選択するため、「選択されて
    // いること」だけではチェックを通らない。ユーザーが自分で学年を選んで
    // タップした場合のみ有効とする（学年チップ → 「次へ」ボタン、の2段構え）。
    if (!_selectedEmailPattern || !_gradePickedByUser) {
      vibrate(80);
      showFlash('checkout', 'error', '学年を選択してください');
      return false;
    }
    return true;
  }

  if (stepId === 'email') {
    const emailPart = document.getElementById('co-email-part')?.value?.trim() || '';
    if (!emailPart) {
      vibrate(80);
      showFlash('checkout', 'error', '学籍番号を入力してください');
      return false;
    }
    if (_selectedEmailPattern && emailPart.length !== _selectedEmailPattern.length) {
      vibrate(80);
      showFlash('checkout', 'error', `学籍番号は${_selectedEmailPattern.length}桁で入力してください（${emailPart.length}桁）`);
      return false;
    }
    return true;
  }

  if (stepId === 'dob') {
    const dob = getDobValue('co-dob');
    if (!dob) {
      vibrate(80);
      showFlash('checkout', 'error', '生年月日を選択してください');
      return false;
    }
    return true;
  }

  return true;
}

function checkoutGoNext(opts) {
  if (_processing) return;
  const stepId = _checkoutSteps[_checkoutStepIndex];
  if (!validateCheckoutStep(stepId)) return;

  // 学年選択は選択ボタン自体のタップですでに音・振動が鳴っているため、
  // その直後に自動で呼ばれるこの遷移では重ねて鳴らさない（二重再生防止）。
  const skipFeedback = opts && opts.skipFeedback;
  if (!skipFeedback) vibrate(20);
  _checkoutStepIndex++;
  renderCheckoutStep();
}

// page-header の戻るボタンから呼ばれる。ウィザードの途中なら1つ前のステップへ、
// 最初のステップならこれまで通りトップ画面に戻る（未保存の入力がある場合は確認）。
async function checkoutGoBack() {
  if (_checkoutStepIndex > 0) {
    vibrate(20);
    _checkoutStepIndex--;
    renderCheckoutStep();
    return;
  }
  await backFromCheckout();
}

let _checkoutData = { name: '', email: '', dob: '' };

async function doCheckout() {
  if (_processing) return;
  _processing = true;
  document.activeElement?.blur();

  const nameParts = _getCheckoutNameParts();
  const emailPartEl = document.getElementById('co-email-part');
  const name = _getCheckoutFullName();
  const emailPart = emailPartEl ? emailPartEl.value.trim() : '';
  const dob = getDobValue('co-dob');

  let fullEmail = '';
  if (_selectedEmailPattern && emailPart) {
    fullEmail = _selectedEmailPattern.template.replace('{{input}}', emailPart);
  }

  if (_sysSettings.checkoutFields === 'all' || _sysSettings.checkoutFields === 'name') {
    if (!nameParts.family || !nameParts.given) {
      const missingPart = nameParts.family ? '名' : '姓';
      document.getElementById(nameParts.family ? 'co-given-name' : 'co-family-name')?.focus({ preventScroll: true });
      vibrate(80);
      showFlash('checkout', 'error', `${missingPart}を入力してください`);
      _processing = false;
      return;
    }
  }
  if (_sysSettings.checkoutFields === 'all' || _sysSettings.checkoutFields === 'email_dob') {
    if (!emailPart) { vibrate(80); showFlash('checkout', 'error', '学籍番号を入力してください'); _processing = false; return; }
    if (_selectedEmailPattern && emailPart.length !== _selectedEmailPattern.length) {
      vibrate(80); showFlash('checkout', 'error', `学籍番号は${_selectedEmailPattern.length}桁で入力してください（${emailPart.length}桁）`); _processing = false; return;
    }
  }

  if (_sysSettings.returnVerify && !dob) {
    vibrate(80);
    showFlash('checkout', 'error', '生年月日を選択してください');
    _processing = false;
    return;
  }

  _checkoutData = { name, email: fullEmail, dob: _sysSettings.returnVerify ? dob : '' };

  const btn = document.getElementById('checkout-btn');
  setBtnLoading(btn, '照会中...');
  showLoading('照会中...', '名簿データを確認しています', 'default', 40);

  try {
    if (fullEmail) {
      const res = await fetch(`${ARDUINO_SERVER}/students/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: fullEmail })
      });
      const data = await res.json();
      if (data.ok) {
        _checkoutData.name = data.name;
      } else if (_sysSettings.checkoutFields === 'email_dob') {
        vibrate([80, 40, 80]);
        const errMsg = data.error || '学生が見つかりませんでした';
        // showLoading は body 全体を pointer-events:none にする。ダイアログの
        // 操作を有効にするため、確認ダイアログを出す前に必ず解除しておく。
        hideLoading();
        const retry = await showCustomConfirm(
          '入力エラー',
          `${errMsg}\n\n学籍番号を確認してやり直しますか？`
        );
        _processing = false;
        resetBtn(btn, BTN_HTML.checkout);
        if (retry) {
          const partEl = document.getElementById('co-email-part');
          if (partEl) { partEl.value = ''; partEl.focus(); }
        }
        return;
      }
    }

    const confirmName = document.getElementById('co-confirm-name');
    const confirmEmail = document.getElementById('co-confirm-email');
    const confirmDob = document.getElementById('co-confirm-dob');

    if (confirmName) confirmName.textContent = (_checkoutData.name || '---') + ' さん';
    if (confirmEmail) confirmEmail.textContent = fullEmail ? 'メールアドレス：' + fullEmail : '';
    if (confirmDob) confirmDob.textContent = dob ? '生年月日：' + dob.replace(/-/g, '/') : '';

    vibrate(30);
    hideLoading();
    goTo('checkout-confirm');
  } catch (e) {
    vibrate([80, 40, 80]);
    showFlash('checkout', 'error', '通信エラーが発生しました。もう一度お試しください');
    hideLoading();
  } finally {
    _processing = false;
    resetBtn(btn, BTN_HTML.checkout);
  }
}

async function finalizeCheckout() {
  const { name, email, dob } = _checkoutData;

  const isConfirmPage = isPageActive('checkout-confirm');
  const btnId = isConfirmPage ? 'checkout-confirm-btn' : 'checkout-btn';
  const btn = document.getElementById(btnId);

  if (_processing) return;
  _processing = true;

  if (btn) setBtnLoading(btn, '処理中...');

  showLoading('貸出処理中...', 'GASサーバーに接続しています', 'checkout', 30);

  try {
    const sessionId = CameraModule.sessionId();
    const r = await gasCall('checkoutPrepare', { name, email, dob, sessionId });

    if (r.success) {
      const assignedDevice = r.deviceId;
      const loanId = r.loanId;
      window._pendingCheckoutLoanId = loanId;
      window._pendingCheckoutSessionId = sessionId;
      showLoading('完了しています...', 'まもなく終了します', 'checkout', 90);
      vibrate(30);

      flipDeviceNum(document.getElementById('door-checkout-num'), assignedDevice);
      document.getElementById('done-checkout-detail').textContent =
        `${name}さん / 端末 ${assignedDevice}`;
      highlightDoorTile(assignedDevice);

      resetCheckoutForm({
        resetDobPickerInput,
        resetGradeSelection,
        resetNameKeyboardMode,
      });

      await syncLoans();
      updateStatusBanner();
      refreshDoorGrid().catch(() => { });

      await CameraModule.stopAndSaveRecording({
        reason: 'checkout_success',
        kind: 'checkout', // 録画の種別（貸出）を明示する
        name, email, deviceId: assignedDevice,
      });

      hideLoading();
      goTo('checkout-door');

      const cmdResult = await sendArduinoCommand('open', assignedDevice, loanId);

      // 解錠コマンドが成功しなかった場合（Arduino未接続はもちろん、認証失敗や
      // シリアル通信エラーなど「接続はしているが解錠できなかった」場合も含む）は、
      // 扉は実際には解錠されていないため、閉扉を待つポーリングには進まず、
      // 手動完了ボタンをその場で表示する。
      // ※以前は `!cmdResult.arduinoConnected` も条件に含めていたため、
      //   「Arduinoには接続できているが解錠許可の取得や解錠自体に失敗した」場合に
      //   誤ってポーリング処理に進んでしまい、実際には開いていない扉が
      //   閉まるのをタイムアウト(2分)まで待ち続けるバグがあった。
      if (cmdResult && !cmdResult.ok) {
        const waitEl = document.getElementById('checkout-door-wait');
        const btnEl = document.getElementById('checkout-manual-btn-area');
        const hintEl = document.getElementById('checkout-manual-hint');
        if (hintEl && cmdResult.error) {
          hintEl.textContent = `解錠できませんでした（${cmdResult.error}）。端末を実際に取り出せたことを確認した場合のみ、手動で記録してください。`;
        }
        if (waitEl) waitEl.style.display = 'none';
        if (btnEl) btnEl.style.display = '';
        window._pendingCheckoutLoanId = loanId;
        startManualCompleteAutoReturn('checkout');
      } else {
        _navLocked = true;
        startDoorPolling(
          async () => {
            let committed = false;
            try {
              const commitResult = await _retryWithBackoff(() => gasCall('checkoutCommit', {
                loanId, sessionId: window._pendingCheckoutSessionId
              }));
              // gasCall は HTTP 200 でも { success: false, error: ... } を返すことがある
              // （例: 貸出予約が掃除済み/既に確定済み）。この場合も再試行を
              // リトライ対象に出来ないため、明示的に success を確認する。
              committed = !!(commitResult && commitResult.success !== false);
            } catch (e) {
              console.error('貸出確定エラー（リトライ上限到達）:', e);
            }

            if (!committed) {
              // 確定に失敗したのに成功画面へ進むと、貸出が未記録のまま終わる。
              // この場合は手動完了ボタンを表示して再試行させる。
              const waitEl = document.getElementById('checkout-door-wait');
              const btnEl = document.getElementById('checkout-manual-btn-area');
              if (waitEl) waitEl.style.display = 'none';
              if (btnEl) btnEl.style.display = '';
              window._pendingCheckoutLoanId = loanId;
              startManualCompleteAutoReturn('checkout');
              return;
            }

            window._pendingCheckoutLoanId = null;
            window._pendingCheckoutSessionId = null;
            const s3 = document.getElementById('checkout-door-step3-num');
            _markStepDone(s3);
            vibrate([20, 50, 20]);
            setTimeout(() => { applySettingsToUI(); goTo('checkout-warning', true); }, 600);
          },
          () => {
            console.warn('[DoorPoll] タイムアウト。手動完了ボタンを表示します。');
            const waitEl = document.getElementById('checkout-door-wait');
            const btnEl = document.getElementById('checkout-manual-btn-area');
            if (waitEl) waitEl.style.display = 'none';
            if (btnEl) btnEl.style.display = '';
            window._pendingCheckoutLoanId = loanId;
            startManualCompleteAutoReturn('checkout');
          },
          assignedDevice,
          () => _startDoorHelpEscalation(true)
        );
      }

    } else {
      vibrate([80, 40, 80]);
      const activeFlashPage = isPageActive('checkout-confirm') ? 'checkout-confirm' : 'checkout';

      const isBlacklisted = r.message && r.message.includes('【貸出制限】');
      const isDuplicate = r.message && r.message.includes('あなたはすでに端末を借りています');
      const isNoDevice = r.message && (r.message.includes('利用可能な端末がありません') || r.message.includes('空き端末がありません') || r.message.includes('すべての端末が貸出中'));

      if (isBlacklisted || isDuplicate || isNoDevice) {
        await CameraModule.stopAndDeleteRecording('cancel');
        hideLoading();
        await showCustomAlert('貸出エラー', isBlacklisted ? '現在この端末をご利用いただけません。担当の先生に確認してください。' : r.message);
        goTo('top', true);
      } else {
        showFlash(activeFlashPage, 'error', r.message || 'エラーが発生しました');
        await CameraModule.stopAndDeleteRecording('cancel');
        hideLoading();
      }
    }
  } catch (e) {
    vibrate([80, 40, 80]);
    const activeFlashPage = isPageActive('checkout-confirm') ? 'checkout-confirm' : 'checkout';
    showFlash(activeFlashPage, 'error', '通信エラーが発生しました。もう一度お試しください');
    await CameraModule.stopAndDeleteRecording('cancel');
    hideLoading();
  } finally {
    _processing = false;
    if (btn) {
      resetBtn(btn, isConfirmPage ?
        `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>はい、間違いありません` :
        BTN_HTML.checkout);
    }
  }
}

async function doCheckoutComplete() {
  if (_processing) return;
  _processing = true;
  cancelManualCompleteAutoReturn();

  const btn = document.getElementById('checkout-done-btn');
  if (btn) setBtnLoading(btn, '記録中...');

  const loanId = window._pendingCheckoutLoanId;
  if (!loanId) {
    await showCustomAlert('エラー', '貸出情報が見つかりません');
    _processing = false;
    goTo('top', true);
    return;
  }

  try {
    const confirmed = await showCustomConfirm(
      '貸出を手動で記録',
      '扉が開かなかった場合は、実際に端末を取り出せていない可能性があります。端末を手元に取り出したことを確認してから記録してください。',
      { okLabel: '端末を確認して記録する' }
    );
    if (!confirmed) {
      startManualCompleteAutoReturn('checkout');
      return;
    }
    showLoading('貸出を記録中...', 'スプレッドシートを更新しています', 'checkout', 50);
    const commitResult = await gasCall('checkoutCommit', {
      loanId, sessionId: window._pendingCheckoutSessionId
    });
    // gasCall は HTTP 200 でも { success: false, error: ... } を返すことがある
    // （例: 貸出予約が掃除済み/既に確定済み）。この場合も成功扱いにせず
    // 手動完了再試行へ戻す（扉閉監視経由の確定処理と同じ判定にする）。
    if (!commitResult || commitResult.success === false) {
      throw new Error((commitResult && commitResult.message) || '貸出の確定に失敗しました');
    }
    hideLoading();
    window._pendingCheckoutLoanId = null;
    window._pendingCheckoutSessionId = null;
    vibrate([20, 50, 20]);
    applySettingsToUI();
    goTo('checkout-warning', true);
  } catch (e) {
    console.error('貸出確定エラー:', e);
    if (CameraModule.isRecording()) {
      await CameraModule.stopAndDeleteRecording('checkout_error').catch(() => { });
    }
    // 確定に失敗しても貸出予約(active_loans)は残っているためここでは画面を離れない。
    // トップへ戻ると該予約を解除する手段がなく、30分の掃除が走るまで
    // その端末が「貸出中」のまま占有されてしまう。同一画面で再試行できるようにする。
    const waitEl = document.getElementById('checkout-door-wait');
    const btnEl = document.getElementById('checkout-manual-btn-area');
    if (waitEl) waitEl.style.display = 'none';
    if (btnEl) btnEl.style.display = '';
    await showCustomAlert('エラー', '貸出の記録に失敗しました。もう一度お試しください');
    startManualCompleteAutoReturn('checkout');
  } finally {
    _processing = false;
    if (btn) resetBtn(btn, '手動で貸出を完了する');
  }
}

async function loadReturnList() {
  const seq = _navSeq;
  const container = document.getElementById('return-loan-list');
  if (!container) return;

  if (store.loans.length === 0) {
    showLoading('読み込み中...', '貸出情報を取得しています', 'sync', null);
    showLoanSkeleton(container, 4);
  } else {
    renderReturnList();
  }

  try {
    await syncLoans();
  } catch (e) {
    console.error('返却一覧の同期エラー:', e);
  } finally {
    if (seq === _navSeq) {
      renderReturnList();
      hideLoading();
    }
  }
}

function renderReturnList() {
  const container = document.getElementById('return-loan-list');
  if (!container) return;
  const committedLoans = store.loans.filter(loan => !loan.isPrepared);

  if (committedLoans.length === 0) {
    container.innerHTML = `
      <div class="loan-empty loan-empty--rich">
        <div class="loan-empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
        </div>
        <div class="loan-empty-title">現在貸出中の端末はありません</div>
        <div class="loan-empty-desc">端末を借りていない場合、返却の必要はありません</div>
        <button type="button" class="loan-empty-action" onclick="goTo('top')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
          トップに戻る
        </button>
      </div>`;
    return;
  }

  // 端末番号順（ロッカーの並びと同じ順）に並べ替えて表示する。
  // 貸出順のままだと、生徒が実物のロッカー番号を頼りに一覧をたどりにくいため、
  // 「扉の開閉状態」グリッドと同じ並びに揃えることで自分の端末番号を探しやすくする。
  const sortedLoans = [...committedLoans].sort((a, b) => {
    const ai = ALL_DEVICES.indexOf(a.deviceId);
    const bi = ALL_DEVICES.indexOf(b.deviceId);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  container.innerHTML = '';
  sortedLoans.forEach((l, i) => {
    const item = document.createElement('div');
    item.className = 'loan-item';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    // 一覧が全部同時に出るのではなく、上から順にふわっと現れるように
    // 少しずつ表示開始を遅らせる（多すぎる場合に待たされないよう上限あり）。
    item.style.setProperty('--loan-item-delay', Math.min(i * 35, 280) + 'ms');
    item.onclick = () => selectLoanForReturn(l.id, item);
    if (l.overdue) item.classList.add('is-overdue');
    item.innerHTML = `
      <div class="loan-device-badge">${escHtml(l.deviceId)}</div>
      <div class="loan-info">
        <div class="loan-name">${escHtml(l.name)}${l.overdue ? '<span class="loan-overdue-chip">延滞</span>' : ''}</div>
        <div class="loan-meta">${escHtml(maskEmail(l.email))}　貸出：${fmtTime(l.checkoutTime)}</div>
      </div>
      <svg class="loan-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18l6-6-6-6"/>
      </svg>
    `;
    container.appendChild(item);
  });
  _setupReturnListScrollHint(container);
}

// 一覧が画面に収まらないとき、下端を薄くフェードさせて「続きがある」ことを示す。
// （スクロールバーを隠した端末UIでは、最後のカードが切れていても気づけないため）
function _setupReturnListScrollHint(container) {
  const update = () => {
    const more = container.scrollHeight - container.scrollTop - container.clientHeight > 8;
    container.classList.toggle('has-more-below', more);
  };
  if (!container.dataset.scrollHintBound) {
    container.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    container.dataset.scrollHintBound = '1';
  }
  container.scrollTop = 0;
  requestAnimationFrame(update);
  setTimeout(update, 400); // 行のふわっと表示アニメーション後に再計算
}

async function selectLoanForReturn(loanId, itemEl) {
  const loan = store.loans.find(l => l.id === loanId);
  if (!loan) return;
  vibrate(15);
  window._selectedLoan = loan;
  // 画面遷移前に一瞬「選ばれた」ことを示すハイライトを入れる。
  // ローディング表示で即座に覆われてしまわないよう、アニメーションが
  // 実際に描画される時間（1フレーム＋わずかな間）だけ確保する。
  if (itemEl) {
    itemEl.classList.add('is-selected');
    await new Promise(requestAnimationFrame);
    await new Promise(r => setTimeout(r, 90));
  }

  await fetchSettings();
  const returnVerifyRequired = isReturnVerificationRequiredForLoan(loan);
  const returnLayout = document.querySelector('#page-return-confirm .return-confirm-layout');
  if (returnLayout) returnLayout.style.display = returnVerifyRequired ? '' : 'none';
  const rcQuestion = document.querySelector('#page-return-confirm .confirm-question');
  if (rcQuestion) rcQuestion.style.display = returnVerifyRequired ? '' : 'none';

  document.getElementById('rc-name').textContent = loan.name + ' さん';
  document.getElementById('rc-email').textContent = maskEmail(loan.email);
  document.getElementById('rc-device').textContent = '貸出端末：' + loan.deviceId;
  resetDobPickerInput('rc-dob');

  showLoading('カメラ準備中...');
  if (CameraModule.isRecording()) {
    await CameraModule.stopAndDeleteRecording('orphan');
  }

  goTo('return-confirm');
  try {
    await CameraModule.startRecording({
      action: 'return_confirm',
      kind: 'return', // 録画の種別（返却）を明示する
      name: loan.name,
      email: loan.email,
      deviceId: loan.deviceId,
      loanId: loan.id,
      startedAt: new Date().toISOString(),
    }, 'return-confirm');
  } catch (e) {
    console.warn('返却録画開始失敗:', e);
  } finally {
    hideLoading();
  }

  if (typeof LogoutCheck !== 'undefined' && _sysSettings.logoutCameraCheckEnabled !== false) LogoutCheck.preload();
}

async function doReturnConfirm() {
  if (_processing) return;
  _processing = true;
  const dob = getDobValue('rc-dob');
  const loan = window._selectedLoan;

  if (!loan) { vibrate(80); showFlash('return-confirm', 'error', '選択情報が失われました'); _processing = false; return; }

  const actualVerifyRequired = isReturnVerificationRequiredForLoan(loan);

  if (actualVerifyRequired) {
    if (!dob) { vibrate(80); showFlash('return-confirm', 'error', '生年月日を選択してください'); _processing = false; return; }
  }

  const btn = document.getElementById('return-confirm-btn');
  setBtnLoading(btn, '確認中...');

  if (actualVerifyRequired) {
    showLoading('本人確認中...', '生年月日を照合しています', 'return', 40);
  } else {
    showLoading('処理中...', '返却準備をしています', 'return', 40);
  }

  try {
    const r = await gasCall('returnVerify', {
      loanId: loan.id,
      dob: actualVerifyRequired ? dob : 'SKIP'
    });
    if (r.success) {
      vibrate(30);

      flipDeviceNum(document.getElementById('door-return-num'), loan.deviceId);
      document.getElementById('done-return-detail').textContent = `${loan.name}さん / 端末 ${loan.deviceId}`;
      highlightDoorTile(loan.deviceId);

      loan.returnSessionId = CameraModule.sessionId();

      hideLoading();
      _initReturnChecklist();
      goTo('return-checklist');


    } else {
      vibrate([80, 40, 80]);
      showFlash('return-confirm', 'error', r.message || '生年月日が一致しません');
    }
  } catch (e) {
    vibrate([80, 40, 80]);
    showFlash('return-confirm', 'error', '通信エラーが発生しました。もう一度お試しください');
  } finally {
    _processing = false;
    resetBtn(btn, BTN_HTML.returnConfirm);
    if (!isPageActive('return-door')) {
      hideLoading();
    }
  }
}

const _chkState = { 1: false, 2: false, 3: false };
let _damageReported = false; // 破損を報告済みかどうか

let _logoutCheckMethod = null; // 'camera' | 'manual'（監査用に録画メタデータへ含める）
let _logoutCamEnabled = true; // ログアウト確認をカメラで行う設定かどうか（_applyLogoutCheckMode で設定）
let _logoutManualTimer = null; // 一定時間で「手動確認」ボタンを出すためのタイマー
let _logoutWaitTick = null; // 経過時間バー更新用のインターバル
let _logoutPollTimer = null; // 画面認識モデルの読み込み待ちポーリング（ページ離脱時に必ず解除する）
let _logoutWaitStart = null; // 待機開始時刻
const LOGOUT_MANUAL_FALLBACK_MS = 120000; // この時間カメラでの自動判定が成功しなければ手動ボタンを表示（2分）
// 注意: 本人確認なしで自動的に次へ進める「ハードタイムアウト」は意図的に廃止している。
// ログアウト確認は確認が取れるまで先に進ませない方針のため、時間切れによる自動通過は行わない。

// ラベルと確信度から、初心者にも「次に何をすればいいか」が分かる具体的な文言を作る。
// confidence: 最も確信度が高かったラベルの確信度 / logoutConfidence: Logout_Screenの確信度
function _logoutStatusText(label, confidence, logoutConfidence) {
  if (label === 'Empty') {
    return '画面が映っていません。Chromebookを持ち上げてカメラに向けてください';
  }

  if (label === 'Other_Screen') {
    // ログアウト画面に近づきつつある（惜しい）場合は、頑張り待ちだと伝える
    if (logoutConfidence >= 0.4) {
      return 'もう少しで認識できそうです。そのままゆっくり構えてください';
    }
    // 画面自体の写りが悪く判定が安定しない場合
    if (confidence < 0.6) {
      return '画面がぼやけています。手ブレを抑えて、画面全体を枠に収めてください';
    }
    // はっきり「ログイン中の画面」と判定できている場合
    return 'まだログイン中の画面のようです。ログアウトボタンを押しましたか？';
  }

  // Logout_Screen（しきい値未満で連続確認中）
  return '確認中…そのまま少し待ってください';
}

// 経過時間帯ごとの補足ヒント（badgeTextの主表示は上書きしないよう、
// 進捗バー横の待機テキストに段階的なガイダンスとして出す）
const LOGOUT_WAIT_HINTS = [
  { atMs: 0, text: '認識を待っています…' },
  { atMs: 15000, text: '画面がカメラにしっかり映るよう、角度を調整してみてください' },
  { atMs: 35000, text: 'Chromebookの画面が暗い・スリープしていないか確認してください' },
  { atMs: 60000, text: 'カメラとの距離を近づけて、画面全体が枠内に入るようにしてください' },
  { atMs: 90000, text: 'うまくいかない場合、あと少しで手動確認ボタンが表示されます' },
];

function _applyLogoutCheckMode() {
  // 運用設定の logoutCameraCheckEnabled に応じて、返却チェックリストの
  // ログアウト確認の見た目・文言を切り替える。
  //  ・カメラ自動確認がオンのとき: 「確認方法を見る」ボタンからカメラ確認へ進む
  //    （カメラで認識できたら自動でチェックが付く）
  //  ・オフのとき: 専用ボタンを出さず、他の項目と同じ「ただのチェックボックス」にする。
  //    ボックスをタップするだけで確認完了になり、カメラ起動や「確認しました」ボタンを
  //    押す必要はない。ボタンは JS の display:none だけで隠し、再利用できるようにしておく。
  const camEnabled = _sysSettings.logoutCameraCheckEnabled !== false;
  _logoutCamEnabled = camEnabled;
  const desc = document.getElementById('logout-check-desc');
  const launchBtn = document.getElementById('logout-verify-launch-btn');
  const item = document.getElementById('chk-item-1');
  if (desc) {
    desc.textContent = camEnabled
      ? 'ログアウト画面を表示して「確認方法を見る」から進むと、カメラで自動確認します。'
      : 'Chromebookをログアウトできていることを確認したら、チェックを入れてください。';
  }
  if (launchBtn) launchBtn.style.display = camEnabled ? '' : 'none';
  if (item) item.classList.toggle('chk-item-plain', !camEnabled);
}

function goToLogoutVerify() {
  // このチェックリストで既に確認済みの場合は、再撮影せずにチェックリストへ戻す。
  // （「確認済み」ボタンを再タップするとカメラが起動するが、_chkState[1] が
  //   既にtrueのため _setLogoutConfirmed は早期returnし、2分後の手動ボタンも
  //   _chkState[1] で出ず、カメラだけが起動しっぱなしになるデッドロック）
  if (_chkState[1]) {
    goTo('return-checklist');
    return;
  }
  if (_sysSettings.logoutCameraCheckEnabled === false) {
    // カメラ自動確認が無効の場合は、カメラ画面に移らず
    // 「手動で確認しました」方式で即座に確認を確定する（2分待ちも出さない）。
    _logoutCheckMethod = 'manual';
    _setLogoutConfirmed();
    return;
  }
  goTo('logout-guide');
}

function startLogoutCameraCheck() {
  if (_chkState[1]) {
    goTo('return-checklist');
    return;
  }
  goTo('logout-verify');
  _startLogoutCameraCheck();
}

function openLogoutExampleModal() {
  const modal = document.getElementById('logout-example-modal');
  if (modal) modal.style.display = 'flex';
}

function closeLogoutExampleModal(e) {
  if (e) e.stopPropagation();
  const modal = document.getElementById('logout-example-modal');
  if (modal) modal.style.display = 'none';
}

function _startLogoutWaitBar() {
  _stopLogoutWaitBar();
  _logoutWaitStart = Date.now();
  // 待機バー枠は _setLogoutConfirmed() や手動確認待ちのタイムアウトで
  // display:none にされる。確認を取り消してカメラ確認画面へ戻ってきたとき、
  // バー枠が見えないまま進捗だけ進む表示になってしまう。
  // 2回目のカメラ確認ではここを通るため、必ず表示へ戻しておく。
  const waitWrap = document.getElementById('logout-cam-wait-bar-wrap');
  if (waitWrap) waitWrap.style.display = '';
  const bar = document.getElementById('logout-cam-progress-bar');
  const waitText = document.getElementById('logout-cam-wait-text');
  if (bar) {
    bar.style.transition = `width ${LOGOUT_MANUAL_FALLBACK_MS}ms linear`;
    bar.style.width = '0%';
    requestAnimationFrame(() => { bar.style.width = '100%'; });
  }
  if (waitText) waitText.textContent = LOGOUT_WAIT_HINTS[0].text;

  _logoutWaitTick = setInterval(() => {
    const elapsed = Date.now() - _logoutWaitStart;
    let hint = LOGOUT_WAIT_HINTS[0].text;
    for (const h of LOGOUT_WAIT_HINTS) {
      if (elapsed >= h.atMs) hint = h.text;
    }
    if (waitText) waitText.textContent = hint;
  }, 1000);
}

function _stopLogoutWaitBar() {
  if (_logoutWaitTick) { clearInterval(_logoutWaitTick); _logoutWaitTick = null; }
  const bar = document.getElementById('logout-cam-progress-bar');
  if (bar) { bar.style.transition = 'none'; bar.style.width = '0%'; }
  _logoutWaitStart = null;
}

// ログアウト確認のカメラ・タイマー類を一括停止する。ページ遷移のたびに
// ui.js の goTo() から呼ばれる。モデル読み込み待ちのポーリングをそのままに
// すると、ページを離れた後もバックグラウンドでカメラ確認が再開してしまう
// ため、必ずここで止める。
function _cleanupLogoutSession() {
  if (_logoutPollTimer) { clearInterval(_logoutPollTimer); _logoutPollTimer = null; }
  _stopLogoutWaitBar();
  if (_logoutManualTimer) { clearTimeout(_logoutManualTimer); _logoutManualTimer = null; }
  if (typeof LogoutCheck !== 'undefined' && typeof LogoutCheck.stop === 'function') LogoutCheck.stop();
}

function _startLogoutCameraCheck() {
  const preview = document.getElementById('logout-cam-preview');
  const badgeText = document.getElementById('logout-cam-badge-text');
  const manualBtn = document.getElementById('logout-cam-manual-btn');
  if (manualBtn) manualBtn.style.display = 'none';
  if (preview) preview.className = 'logout-cam-preview logout-cam-preview--full logout-cam-preview--pending';

  // 以前のセッションで未解除の読み込み待ちポーリングを確実に解いてから始める
  if (_logoutPollTimer) { clearInterval(_logoutPollTimer); _logoutPollTimer = null; }

  // モデル読み込みの状態に応じて、最初にローディング表示を出す。
  // モデルは前画面（返却確認の取得時）でプリロード済みだが、初回起動直後や
  // モデルサイズによってはまだ読み込み途中のことがある。その間は「モデル読み込み中」
  // であることを明示し、固まったように見えるのを防ぐ。
  // モデル読み込み中は待機バーや2分タイマーを開始せず、完了後に改めて開始する。
  let loadState = (typeof LogoutCheck !== 'undefined' && typeof LogoutCheck.getLoadState === 'function')
    ? LogoutCheck.getLoadState()
    : 'ready';

  // まだ読み込みが始まっていない場合は、ここで開始してローディング表示にする
  if (loadState === 'idle' && typeof LogoutCheck !== 'undefined' && typeof LogoutCheck.preload === 'function') {
    LogoutCheck.preload();
    loadState = 'loading';
  }

  if (loadState === 'loading') {
    if (badgeText) badgeText.textContent = '画面認識モデルを読み込んでいます…';
    const loadingEl = document.getElementById('logout-cam-loading');
    if (loadingEl) loadingEl.style.display = 'flex';
    _logoutPollTimer = setInterval(() => {
      // モデル読み込み中にページを離れていた場合はそのまま中断する。
      // （ここで再開すると背景でカメラが起動し、誤って確認が確定したり、
      //   他のカメラ利用（貸出・返却の録画など）と競合したりするため）。
      if (!isPageActive('logout-verify')) {
        clearInterval(_logoutPollTimer);
        _logoutPollTimer = null;
        if (loadingEl) loadingEl.style.display = 'none';
        return;
      }
      const s = (typeof LogoutCheck.getLoadState === 'function') ? LogoutCheck.getLoadState() : 'ready';
      if (s === 'ready') {
        clearInterval(_logoutPollTimer);
        _logoutPollTimer = null;
        if (loadingEl) loadingEl.style.display = 'none';
        _startLogoutCameraCheck();
      } else if (s === 'error') {
        clearInterval(_logoutPollTimer);
        _logoutPollTimer = null;
        if (loadingEl) loadingEl.style.display = 'none';
        // モデル読み込みに失敗した場合は、2分経過後に表示される手動確認へ任せる
        _startLogoutWaitBar();
        if (_logoutManualTimer) { clearTimeout(_logoutManualTimer); _logoutManualTimer = null; }
        _logoutManualTimer = setTimeout(() => {
          if (_chkState[1]) return;
          if (manualBtn) manualBtn.style.display = '';
          if (badgeText) badgeText.textContent = '自動確認に時間がかかっています…';
          if (preview) preview.className = 'logout-cam-preview logout-cam-preview--full logout-cam-preview--bad';
          _stopLogoutWaitBar();
          const waitWrap = document.getElementById('logout-cam-wait-bar-wrap');
          if (waitWrap) waitWrap.style.display = 'none';
        }, LOGOUT_MANUAL_FALLBACK_MS);
        if (badgeText) badgeText.textContent = '画面認識モデルを読み込めませんでした。しばらくお待ちください…';
        if (preview) preview.className = 'logout-cam-preview logout-cam-preview--full logout-cam-preview--bad';
      }
    }, 300);
    return;
  }

  if (badgeText) badgeText.textContent = 'カメラを準備しています…';
  const loadingEl = document.getElementById('logout-cam-loading');
  if (loadingEl) loadingEl.style.display = 'none';

  _startLogoutWaitBar();

  if (_logoutManualTimer) { clearTimeout(_logoutManualTimer); _logoutManualTimer = null; }
  _logoutManualTimer = setTimeout(() => {
    if (_chkState[1]) return;
    if (manualBtn) manualBtn.style.display = '';
    if (badgeText) badgeText.textContent = '自動確認に時間がかかっています…';
    if (preview) preview.className = 'logout-cam-preview logout-cam-preview--full logout-cam-preview--bad';
    _stopLogoutWaitBar();
    const waitWrap = document.getElementById('logout-cam-wait-bar-wrap');
    if (waitWrap) waitWrap.style.display = 'none';
  }, LOGOUT_MANUAL_FALLBACK_MS);

  if (typeof LogoutCheck === 'undefined') {
    // 画面認識モデル自体が読み込めない場合も、本人確認なしでは先に進めない。
    // 2分間は手動ボタンを出さずに待たせ、その間に復旧しない場合のみ手動確認を許可する。
    if (badgeText) badgeText.textContent = '画面認識モデルを読み込めませんでした。しばらくお待ちください…';
    if (preview) preview.className = 'logout-cam-preview logout-cam-preview--full logout-cam-preview--bad';
    return;
  }

  LogoutCheck.start({
    onStatus: ({ label, confidence, logoutConfidence, isOk }) => {
      if (_chkState[1]) return;
      if (preview) preview.className = 'logout-cam-preview logout-cam-preview--full ' + (isOk ? 'logout-cam-preview--good' : 'logout-cam-preview--bad');
      if (badgeText) badgeText.textContent = _logoutStatusText(label, confidence, logoutConfidence);
    },
    onOk: () => {
      _logoutCheckMethod = 'camera';
      _setLogoutConfirmed();
    },
    onError: () => {
      // カメラ自体に問題がある場合も、本人確認なしで即座に先へは進ませない。
      // 手動ボタンは _logoutManualTimer（2分）が経過してから表示される。
      if (preview) preview.className = 'logout-cam-preview logout-cam-preview--full logout-cam-preview--bad';
      if (badgeText) badgeText.textContent = 'カメラでの自動確認でエラーが発生しました…';
    },
  });
}

function _updateLogoutLaunchBtn(confirmed) {
  const btn = document.getElementById('logout-verify-launch-btn');
  // カメラ確認が無効の運用ではボタン自体を表示しない（項目1はただのチェックボックス）。
  if (_logoutCamEnabled === false) {
    if (btn) {
      btn.style.display = 'none';
      btn.classList.toggle('checked', !!confirmed);
    }
    return;
  }
  const text = document.getElementById('logout-verify-launch-text');
  if (text) {
    text.textContent = confirmed
      ? '確認済み（タップで再確認）'
      : '確認方法を見る';
  }
  if (btn) btn.classList.toggle('checked', !!confirmed);
}

function _setLogoutConfirmed() {
  if (_chkState[1]) return;
  _chkState[1] = true;

  if (_logoutManualTimer) { clearTimeout(_logoutManualTimer); _logoutManualTimer = null; }
  if (typeof LogoutCheck !== 'undefined') LogoutCheck.stop();
  _stopLogoutWaitBar();

  const box = document.getElementById('chk-box-1');
  const item = document.getElementById('chk-item-1');
  const preview = document.getElementById('logout-cam-preview');
  const manualBtn = document.getElementById('logout-cam-manual-btn');
  const waitWrap = document.getElementById('logout-cam-wait-bar-wrap');
  if (box) { box.classList.add('checked'); _popCheckbox(box); }
  if (item) item.classList.add('checked');
  if (preview) preview.className = 'logout-cam-preview logout-cam-preview--full logout-cam-preview--confirmed';
  if (manualBtn) manualBtn.style.display = 'none';
  if (waitWrap) waitWrap.style.display = 'none';

  _updateLogoutLaunchBtn(true);

  vibrate(20);
  _evalChecklist();

  if (isPageActive('logout-verify')) {
    setTimeout(() => {
      if (isPageActive('logout-verify')) goTo('return-checklist');
    }, 1100);
  }
}

function confirmLogoutManually() {
  _logoutCheckMethod = 'manual';
  _setLogoutConfirmed();
}

function _initReturnChecklist() {
  _chkState[1] = false;
  _chkState[2] = false;
  _chkState[3] = false;
  _damageReported = false;
  _logoutCheckMethod = null;

  [1, 2, 3].forEach(n => {
    const box = document.getElementById(`chk-box-${n}`);
    const item = document.getElementById(`chk-item-${n}`);
    if (box) box.classList.toggle('checked', _chkState[n]);
    if (item) {
      item.classList.toggle('checked', _chkState[n]);
      item.setAttribute('aria-checked', String(_chkState[n]));
    }
  });

  const damageContinue = document.getElementById('damage-continue-area');
  const okArea = document.getElementById('checklist-ok-area');
  const hint = document.getElementById('checklist-hint');

  if (damageContinue) damageContinue.style.display = 'none';
  if (okArea) okArea.style.display = 'none';
  if (hint) { hint.style.display = ''; hint.textContent = '3つすべてにチェックを入れると次へ進めます。'; }

  // 前回のボタン演出（disabled状態）を必ずリセットする
  const okBtn = document.getElementById('checklist-ok-btn');
  if (okBtn) okBtn.disabled = false;

  const loan = window._selectedLoan;
  if (loan) {
    const el1 = document.getElementById('dg-device-num-teacher');
    const el2 = document.getElementById('dg-device-num-no-teacher');
    const el3 = document.getElementById('dg-device-num-report');
    if (el1) el1.textContent = loan.deviceId;
    if (el2) el2.textContent = loan.deviceId;
    if (el3) el3.textContent = loan.deviceId;
  }

  _updateLogoutLaunchBtn(false);
  _applyLogoutCheckMode();
  _evalChecklist();
}

function _popCheckbox(box) {
  if (!box) return;
  box.classList.remove('is-popping');
  void box.offsetWidth; // 連続でチェックしても毎回アニメーションが再生されるようにリフローを挟む
  box.classList.add('is-popping');
  setTimeout(() => box.classList.remove('is-popping'), 480);
}

function toggleCheck(n) {
  // カメラでログアウト確認を行う設定のとき、項目1は「確認方法を見る」ボタンから
  // カメラ確認へ進む（認識できたら自動でチェックが付く）。
  // カメラ確認をオフにしている運用では、項目1も他の項目と同じ「ただのチェックボックス」。
  if (n === 1 && _logoutCamEnabled !== false) {
    if (!_chkState[1]) {
      goToLogoutVerify();
    } else {
      _chkState[1] = false;
      const box = document.getElementById('chk-box-1');
      const item = document.getElementById('chk-item-1');
      if (box) box.classList.remove('checked');
      if (item) {
        item.classList.remove('checked');
        item.setAttribute('aria-checked', 'false');
      }
      _updateLogoutLaunchBtn(false);
      vibrate(20);
      _evalChecklist();
    }
    return;
  }

  _chkState[n] = !_chkState[n];

  const box = document.getElementById(`chk-box-${n}`);
  const item = document.getElementById(`chk-item-${n}`);
  if (box) {
    box.classList.toggle('checked', _chkState[n]);
    if (_chkState[n]) _popCheckbox(box);
  }
  if (item) {
    item.classList.toggle('checked', _chkState[n]);
    item.setAttribute('aria-checked', _chkState[n]);
  }

  vibrate(20);
  _evalChecklist();
}

// 返却チェックリストの表示状態を決める純粋な判定。
// chk1: ログアウト確認済み / chk2: シャットダウン確認済み / chk3: 破損なしを確認済み
// damageReported: 破損・故障を報告フローで報告済み
// 返却方法は2通り:
//  (a) 壊れていない場合 → 3つすべてチェック → 「確認完了。扉を開ける」
//  (b) 壊してしまった場合 → チェックボックスとは別に用意した
//       「壊してしまった生徒はこちら」ボタンから報告フローへ進み、返却する
function _checklistDecision(chk1, chk2, chk3, damageReported) {
  if (damageReported) {
    return { showOk: false, showDamageContinue: true, hint: '' };
  }
  if (chk1 && chk2 && chk3) {
    return { showOk: true, showDamageContinue: false, hint: '' };
  }
  return {
    showOk: false,
    showDamageContinue: false,
    hint: '3つすべてにチェックを入れると次へ進めます。壊してしまった場合は、下の「壊してしまった生徒はこちら」から報告してください',
  };
}

function _evalChecklist() {
  const decision = _checklistDecision(_chkState[1], _chkState[2], _chkState[3], _damageReported);
  const okArea = document.getElementById('checklist-ok-area');
  const damageContinue = document.getElementById('damage-continue-area');
  const hint = document.getElementById('checklist-hint');

  if (okArea) okArea.style.display = decision.showOk ? '' : 'none';
  if (damageContinue) damageContinue.style.display = decision.showDamageContinue ? '' : 'none';
  if (hint) {
    hint.style.display = decision.hint ? '' : 'none';
    if (decision.hint) hint.textContent = decision.hint;
  }
}

// 「壊してしまった生徒はこちら」ボタン → 故障（破損）報告の専用画面へ遷移する。
// 返却チェックリストの3つ目（破損なしチェック）はあくまで「正常に返す」手段で、
// 破損の申告はこのボタン経由の専用フローで行う。ボタンはチェックリスト未完了でも
// 常に押せる（どんな状態の生徒でも報告への導線を塞がない）。
function goToDamageReport() {
  const loan = window._selectedLoan;
  const el = document.getElementById('dg-device-num-report');
  if (el && loan) el.textContent = loan.deviceId;
  goTo('damage-report');
}

function showDamageTeacherGuide() {
  goTo('damage-teacher');
}

function showDamageNoTeacherGuide() {
  goTo('damage-no-teacher');
}

function proceedWithDamage() {
  _damageReported = true;
  proceedToReturnDoor();
}

function proceedWithDamageNotReported() {
  _damageReported = true;
  proceedToReturnDoor();
}

/* 「確認完了。扉を開ける」ボタン：実際の解錠処理（proceedToReturnDoor）へ進む。
   二度押しはボタンのdisabledで防ぐ。
   旧: ボタン内にミニチュアの扉アイコンがあり、それが開く演出を待ってから
   遷移していた。アイコンは装飾過多のため削除したので、待機もなしに進む。 */
function playDoorBtnThenProceed(btn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  proceedToReturnDoor();
}

async function proceedToReturnDoor() {
  const loan = window._selectedLoan;
  if (!loan) {
    await showCustomAlert('エラー', '選択情報が失われました');
    goTo('top');
    return;
  }

  document.getElementById('door-return-user').textContent = `${loan.name} さんの端末`;

  goTo('return-door');

  showLoading('解錠中...', '', 'return');
  const cmdResult = await sendArduinoCommand('open', loan.deviceId, loan.id);
  hideLoading();

  // チェックアウト側と同様、解錠コマンドが成功しなかった場合は扉が実際には
  // 開いていないため、閉扉ポーリングには進まず即座に手動完了ボタンを出す。
  // （以前は結果を確認せず無条件でポーリングへ進んでいたため、解錠に失敗した
  //   場合でも「扉が閉まるのを待っています」の画面のままタイムアウト(2分)まで
  //   何も起きないという不具合があった）
  if (cmdResult && !cmdResult.ok) {
    const waitEl = document.getElementById('return-door-wait');
    const btnEl = document.getElementById('return-manual-btn-area');
    const hintEl = document.getElementById('return-manual-hint');
    if (hintEl && cmdResult.error) {
      hintEl.textContent = `解錠できませんでした（${cmdResult.error}）。端末を実際に棚へ戻し、扉を閉めたことを確認した場合のみ、手動で記録してください。`;
    }
    if (waitEl) waitEl.style.display = 'none';
    if (btnEl) btnEl.style.display = '';
    startManualCompleteAutoReturn('return');
    return;
  }

  _navLocked = true;
  startDoorPolling(
    async () => {
      const s3 = document.getElementById('return-door-step3-num');
      _markStepDone(s3);
      vibrate([20, 50, 20]);
      await _finalizeReturn(loan);
    },
    () => {
      console.warn('[DoorPoll] 扉閉じタイムアウト。手動ボタンを表示します。');
      const waitEl = document.getElementById('return-door-wait');
      const btnEl = document.getElementById('return-manual-btn-area');
      if (waitEl) waitEl.style.display = 'none';
      if (btnEl) btnEl.style.display = '';
      startManualCompleteAutoReturn('return');
    },
    loan.deviceId,
    () => _startDoorHelpEscalation(false)
  );
}

async function _finalizeReturn(loan) {
  if (_processing) return;
  cancelManualCompleteAutoReturn();
  stopDoorPolling();

  showLoading('返却を記録中...', 'スプレッドシートを更新しています', 'return', 50);
  _processing = true;

  try {
    const r = await gasCall('returnComplete', {
      loanId: loan.id,
      isDamaged: _damageReported
    });
    if (r.success) {
      showLoading('完了しました', 'データを同期しています', 'return', 90);
      vibrate([30, 60, 30]);
      await syncLoans();
      updateStatusBanner();
      refreshDoorGrid().catch(() => { });
      const doneNameEl = document.getElementById('return-done-name');
      const doneDeviceEl = document.getElementById('return-done-device');
      const doneTimeEl = document.getElementById('return-done-time');
      if (doneNameEl) doneNameEl.textContent = `${loan.name} さん`;
      if (doneDeviceEl) doneDeviceEl.textContent = loan.deviceId;
      if (doneTimeEl) {
        const now = new Date();
        doneTimeEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      }
      if (loan.returnSessionId) {
        await CameraModule.stopAndSaveRecording({
          reason: 'return_success',
          action: 'return_confirm',
          kind: 'return', // 録画の種別（返却）を明示する
          name: loan.name,
          email: loan.email,
          deviceId: loan.deviceId,
          loanId: loan.id,
          logoutCheckMethod: _logoutCheckMethod || 'unknown', // 'camera' | 'manual'
        });
      }
      window._selectedLoan = null;
      goTo('return-done', true);
    } else {
      showFlash('return-door', 'error', r.message || 'エラーが発生しました。ネットワーク復帰後に再試行されます。');
      _enqueuePendingReturn({ ...loan, isDamaged: _damageReported });
      window._selectedLoan = null;
      goTo('return-select', true);
    }
  } catch (e) {
    showFlash('return-door', 'error', '通信エラーが発生しました。ネットワーク復帰後に自動的に再試行します。');
    _enqueuePendingReturn({ ...loan, isDamaged: _damageReported });
    window._selectedLoan = null;
    goTo('return-select', true);
  } finally {
    _processing = false;
    hideLoading();
  }
}

async function doReturnComplete() {
  if (_processing) return;

  const loan = window._selectedLoan;
  if (!loan) {
    await showCustomAlert('エラー', '選択情報が失われました');
    goTo('top', true);
    return;
  }

  cancelManualCompleteAutoReturn();
  stopDoorPolling();

  const btn = document.getElementById('return-done-btn');
  setBtnLoading(btn, '記録中...');

  const confirmed = await showCustomConfirm(
    '返却を手動で記録',
    '扉のセンサーで返却を確認できていません。実際に端末を棚へ戻し、扉を閉めたことを確認してから記録してください。',
    { okLabel: '端末を確認して記録する' }
  );
  if (!confirmed) {
    resetBtn(btn, BTN_HTML.returnDone);
    startManualCompleteAutoReturn('return');
    return;
  }
  await _finalizeReturn(loan);

  resetBtn(btn, BTN_HTML.returnDone);
}

// 「手動で完了する」画面（扉が閉まったことを検知できない場合）で、生徒が
// その場ですぐに離れたい場合の代替導線。画面をトップへ戻すだけ。
// 貸出側: 確定前の貸出予約(active_loans)がそのまま残り、30分の掃除で自動解放される。
// 返却側: returnComplete を呼んでいないため貸出記録も残り「貸出中」のままなので、
//        管理者が強制返却などで事後的に解消する必要がある。
function deferDoorCompletion() {
  if (isPageActive('checkout-door') && window._pendingCheckoutLoanId && window._pendingCheckoutSessionId) {
    const loanId = window._pendingCheckoutLoanId;
    const sessionId = window._pendingCheckoutSessionId;
    window._pendingCheckoutLoanId = null;
    window._pendingCheckoutSessionId = null;
    gasCall('checkoutCancel', { loanId, sessionId }).catch(e => {
      console.error('貸出予約を解除できませんでした:', e);
    });
  }
  goTo('top', true);
}

async function backFromCheckoutConfirm() {
  if (_backInProgress) return;
  _backInProgress = true;
  try {
    // 録画はここで削除しない。確認画面から戻って再度送信する場合、
    // 同じ録画を続けて確定保存できるようにする（戻る→再送信で監査録画が
    // 欠落するバグの防止）。もしこのままトップ等へ離脱した場合は、
    // goTo()→CameraModule.abortIfOrphan が「孤立録画」として自動削除する。
    goTo('checkout');
  } finally {
    _backInProgress = false;
  }
}

async function backFromCheckout() {
  if (_backInProgress) return;
  _backInProgress = true;

  try {
    const name = _getCheckoutFullName();
    const part = document.getElementById('co-email-part')?.value?.trim() || '';
    const dob = getDobValue('co-dob');
    if (name || part || dob) {
      const ok = await showCustomConfirm('確認', '入力中のデータが消えます。トップに戻りますか？');
      if (!ok) {
        _backInProgress = false;
        return;
      }
    }
    if (CameraModule.isRecording()) await CameraModule.stopAndDeleteRecording('cancel');
    goTo('top');
  } finally {
    _backInProgress = false;
  }
}

async function backFromReturnConfirm() {
  if (_backInProgress) return;
  _backInProgress = true;
  try {
    if (CameraModule.isRecording()) await CameraModule.stopAndDeleteRecording('cancel');
    goTo('return-select');
  } finally {
    _backInProgress = false;
  }
}

async function refreshStatus() {
  const icon = document.getElementById('status-refresh-btn');
  if (icon) icon.classList.add('spinning');
  showLoading('情報を更新中...');
  try {
    await syncLoans();
    updateStatusBanner();
    if (typeof _updateActionCards === 'function') _updateActionCards();
  } finally {
    hideLoading();
    if (icon) setTimeout(() => icon.classList.remove('spinning'), 600);
  }
}

async function updateTopPageInBackground() {
  const seq = _navSeq;
  try {
    await fetchSettings();
    applySettingsToUI();
    if (seq !== _navSeq) return;
    await syncLoans();
    if (seq !== _navSeq) return;
    updateStatusBanner();
    if (typeof _updateActionCards === 'function') _updateActionCards();
    refreshDoorGrid().catch(() => { });
  } catch (e) {
    console.warn('[BackgroundSync] 失敗:', e);
  }
}

let _doorStatusCache = null;
let _loanCache = null;

async function refreshDoorGrid() {
  try {
    const res = await fetch(`${ARDUINO_SERVER}/arduino/status/all`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const arduinoConnected = data.connected !== false;
    if (typeof _setConnState === 'function') _setConnState('server', true);
    if (typeof _setConnState === 'function') _setConnState('arduino', arduinoConnected);
    if (data.doors) {
      if (typeof _saveCache === 'function') {
        _saveCache(CACHE_KEYS.doorStatus, data.doors);
        _saveCache(CACHE_KEYS.doorConnected, arduinoConnected);
      }
      const doorsStr = JSON.stringify(data.doors);
      const loansStr = JSON.stringify(store.loans);

      const changed = (doorsStr !== _doorStatusCache) || (loansStr !== _loanCache);

      if (changed) {
        _doorStatusCache = doorsStr;
        _loanCache = loansStr;
        _renderDoorGrid(data.doors, arduinoConnected);
      }
    }
  } catch (e) {
    if (typeof _setConnState === 'function') _setConnState('server', false);
    if (typeof _loadCache === 'function' && typeof CACHE_KEYS !== 'undefined') {
      const cachedDoors = _loadCache(CACHE_KEYS.doorStatus);
      const cachedConnected = _loadCache(CACHE_KEYS.doorConnected);
      if (cachedDoors && cachedDoors.data) {
        _renderDoorGrid(cachedDoors.data, cachedConnected ? cachedConnected.data : false);
      } else {
        _renderDoorGrid(null, false);
      }
    } else {
      _renderDoorGrid(null, false);
    }
  }
}

// 1台ぶんのタイル状態（クラス名・アイコン・ラベル・バッジ）を計算する。
// 描画（innerHTML生成）と分離しておくことで、初回描画と差分更新の
// 両方から同じロジックを使い回せるようにしている。
function _computeDoorTileState(id, doors, connected, loansMap, failedSet) {
  const doorState = doors ? doors[id] : null;
  // 公開される画面（キオスクTOP）には氏名を出さない。貸出中かどうかだけを扱う。
  const isLoaned = !!loansMap[id];
  const isFailed = failedSet.has(id);

  let tileClass = 'door-tile';
  if (id === _highlightedDeviceId) tileClass += ' door-tile--highlight';
  let stateIcon = '';
  let stateLabel = '';
  let stateClass = '';
  let stateKey = ''; // 差分検出用のキー（見た目が同じなら再描画しない）

  if (isFailed) {
    tileClass += ' door-tile--unknown';
    stateLabel = '故障中';
    stateClass = 'door-tile__state--unknown';
    stateKey = 'failed';
    stateIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>`;
  } else if (!connected || doorState === null) {
    tileClass += ' door-tile--unknown';
    stateLabel = '不明';
    stateClass = 'door-tile__state--unknown';
    stateKey = 'unknown';
    stateIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/>
      <path d="M12 8v4M12 16h.01"/></svg>`;
  } else if (doorState === 'disconnected') {
    tileClass += ' door-tile--unknown';
    stateLabel = '未接続';
    stateClass = 'door-tile__state--unknown';
    stateKey = 'disconnected';
    stateIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18.36 5.64l-2.12 2.12M9.76 14.24l-2.12 2.12M14.24 9.76l2.83-2.83a3 3 0 0 1 4.24 4.24l-2.83 2.83M9.76 14.24l-2.83 2.83a3 3 0 0 1-4.24-4.24l2.83-2.83M8 16l8-8"/></svg>`;
  } else if (doorState === 'open') {
    tileClass += ' door-tile--open';
    stateLabel = '開';
    stateClass = 'door-tile__state--open';
    stateKey = 'open';
    stateIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 8L6 12l12 4V8z"/><line x1="6" y1="8" x2="6" y2="16"/></svg>`;
  } else {
    tileClass += ' door-tile--closed';
    stateLabel = '閉';
    stateClass = 'door-tile__state--closed';
    stateKey = 'closed';
    stateIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  }

  // バッジは端末IDの下に置く固定の枠。バッジなしのタイルも同じ高さの枠を
  // 確保して、全タイルの縦位置を揃える（重なり・はみ出し防止）。
  let loanBadge = '<div class="door-tile__loan-badge is-empty" aria-hidden="true">&nbsp;</div>';
  if (isLoaned) {
    loanBadge = '<div class="door-tile__loan-badge">貸出中</div>';
  } else if (isFailed) {
    loanBadge = '<div class="door-tile__loan-badge door-tile__loan-badge--failed">故障中</div>';
  }

  if (isLoaned && !isFailed) tileClass += ' door-tile--loaned';

  const innerHTML = `
    <div class="door-tile__id">${escHtml(id)}</div>
    ${loanBadge}
    <div class="door-tile__state-wrap">
      <span class="door-tile__state ${stateClass}">
        ${stateIcon}
        ${stateLabel}
      </span>
    </div>
  `;

  // 見た目に影響する要素だけを差分キーに含める（ハイライトは
  // フリップ演出の対象にしない：単なる注目表示のため）
  const diffKey = `${stateKey}|${isLoaned ? 'loan' : ''}`;

  return { tileClass, innerHTML, diffKey };
}

function _renderDoorGrid(doors, connected) {
  const grid = document.getElementById('door-status-grid');
  if (!grid) return;

  const loansMap = {};
  store.loans.forEach(l => {
    loansMap[l.deviceId] = true;
  });

  const failedSet = new Set((store.failures || []).filter(f => f.status === '故障中').map(f => f.deviceId));

  const isFirstRender = grid.dataset.doorGridInit !== '1';

  if (isFirstRender) {
    // 初回のみ丸ごと構築する。以降はタイルのDOMノードを使い回す。
    grid.innerHTML = ALL_DEVICES.map(id => {
      const { tileClass, innerHTML, diffKey } = _computeDoorTileState(id, doors, connected, loansMap, failedSet);
      return `<div class="${tileClass}" id="door-tile-${escHtml(id)}" data-device-id="${escHtml(id)}" data-diff-key="${escHtml(diffKey)}">${innerHTML}</div>`;
    }).join('');
    grid.dataset.doorGridInit = '1';
    return;
  }

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  ALL_DEVICES.forEach(id => {
    const tile = document.getElementById(`door-tile-${id}`);
    if (!tile) return; // 万一タイルが無い場合は何もしない（再構築は次回に委ねる）

    const { tileClass, innerHTML, diffKey } = _computeDoorTileState(id, doors, connected, loansMap, failedSet);
    const prevKey = tile.dataset.diffKey;
    const shouldHighlight = id === _highlightedDeviceId;

    // フリップ演出が進行中のタイルは、is-flip-out / is-flip-in を
    // 消してしまうようなクラス総入れ替えは避けつつ、ハイライトの
    // 付け外しだけは即座に反映する（注目表示は演出より優先度が高い）。
    const isFlipping = tile.classList.contains('is-flip-out') || tile.classList.contains('is-flip-in');
    if (isFlipping) {
      tile.classList.toggle('door-tile--highlight', shouldHighlight);
      return;
    }

    // ハイライトの有無だけを見てクラスを常に同期させる（フリップ対象外）
    tile.className = tileClass;

    if (prevKey === diffKey) {
      // 見た目に変化なし：中身は既に最新のはずなので何もしない
      return;
    }

    tile.dataset.diffKey = diffKey;

    if (reduceMotion) {
      tile.innerHTML = innerHTML;
      return;
    }

    // 直前のフリップ演出のリスナーが残っていれば掃除してから開始する
    // （通常は isFlipping ガードで到達しないが、念のための防御）
    if (tile._flipCleanup) tile._flipCleanup();

    // 状態が実際に変わったタイルだけ、扉を裏返すようにフリップして
    // 中身を差し替える。
    tile.classList.add('is-flip-out');
    const onFlipOutEnd = () => {
      tile.removeEventListener('animationend', onFlipOutEnd);
      tile.classList.remove('is-flip-out');
      tile.innerHTML = innerHTML;
      tile.classList.add('is-flip-in');
      const onFlipInEnd = () => {
        tile.removeEventListener('animationend', onFlipInEnd);
        tile.classList.remove('is-flip-in');
        tile._flipCleanup = null;
      };
      tile._flipCleanup = () => {
        tile.removeEventListener('animationend', onFlipInEnd);
        tile.classList.remove('is-flip-in');
        tile._flipCleanup = null;
      };
      tile.addEventListener('animationend', onFlipInEnd);
    };
    tile._flipCleanup = () => {
      tile.removeEventListener('animationend', onFlipOutEnd);
      tile.classList.remove('is-flip-out');
      tile._flipCleanup = null;
    };
    tile.addEventListener('animationend', onFlipOutEnd);
  });
}

// 現在の貸出/返却フローで対象になっている扉番号を、トップ画面の
// 扉状態グリッド上でも分かるように光らせる（該当タイルが無い＝
// まだグリッドが描画されていない場合は無視してよい）。
let _highlightedDeviceId = null;

function highlightDoorTile(deviceId) {
  clearDoorTileHighlight();
  _highlightedDeviceId = deviceId || null;
  const tile = deviceId ? document.getElementById(`door-tile-${deviceId}`) : null;
  if (tile) tile.classList.add('door-tile--highlight');
}

function clearDoorTileHighlight() {
  if (!_highlightedDeviceId) return;
  const tile = document.getElementById(`door-tile-${_highlightedDeviceId}`);
  if (tile) tile.classList.remove('door-tile--highlight');
  _highlightedDeviceId = null;
}

/* ==========================================================================
   扉が開かない場合の二段階ヘルプ表示
   （15秒経っても扉が開かれない場合はまず優しいヒントを、それでも45秒
   経過した場合は「先生に声をかけてください」という案内に切り替える。
   通信断でロック機器自体に到達できていない場合とは別に、「解錠はできて
   いるはずなのに扉が開かれていない」という生徒操作待ちの状態をケアする）
   ========================================================================== */
let _doorHelpEscalationTimer = null;
const DOOR_HELP_ESCALATION_MS = 45000;

function _doorHelpHintEl(isCheckout) {
  return document.getElementById(isCheckout ? 'checkout-door-help-hint' : 'return-door-help-hint');
}

function _showDoorHelpHint(isCheckout, stage) {
  const el = _doorHelpHintEl(isCheckout);
  if (!el) return;
  const warnIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`;
  if (stage === 1) {
    el.className = 'door-help-hint';
    el.innerHTML = `${warnIcon}<span>表示されている番号の扉を確認し、ゆっくり開けてください</span>`;
  } else {
    el.className = 'door-help-hint door-help-hint--escalate';
    el.innerHTML = `${warnIcon}<span><strong>うまく開かない場合は、近くの先生かサーバー室にお声がけください。</strong></span>`;
  }
  el.style.display = 'flex';
}

function _startDoorHelpEscalation(isCheckout) {
  _showDoorHelpHint(isCheckout, 1);
  if (_doorHelpEscalationTimer) clearTimeout(_doorHelpEscalationTimer);
  _doorHelpEscalationTimer = setTimeout(() => {
    _showDoorHelpHint(isCheckout, 2);
  }, DOOR_HELP_ESCALATION_MS);
}

function _clearDoorHelpEscalation() {
  if (_doorHelpEscalationTimer) { clearTimeout(_doorHelpEscalationTimer); _doorHelpEscalationTimer = null; }
  ['checkout-door-help-hint', 'return-door-help-hint'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.display = 'none'; el.className = 'door-help-hint'; }
  });
}

function _initDoorGrid() {
  const grid = document.getElementById('door-status-grid');
  if (!grid) return;
  // ローディング表示に戻すため、次回の _renderDoorGrid は
  // 差分更新ではなく初回描画からやり直す。
  delete grid.dataset.doorGridInit;
  grid.innerHTML = ALL_DEVICES.map(id => `
    <div class="door-tile door-tile--loading">
      <div class="door-tile__id">${escHtml(id)}</div>
      <div class="door-tile__skel"></div>
    </div>
  `).join('');
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && ['t', 'n', 'w', 'T', 'N', 'W'].includes(e.key)) {
    e.preventDefault();
  }
  if (e.key === 'F12') {
    e.preventDefault();
  }
}, true);

window.addEventListener('contextmenu', e => e.preventDefault());

/* === メール入力ヒント === */
function updateEmailHint() {
  const hintEl = document.getElementById('co-email-hint');
  if (!hintEl) return;
  if (!_selectedEmailPattern) {
    hintEl.textContent = '';
    return;
  }
  const p = _selectedEmailPattern;
  // 桁数に応じたサンプル数字を生成する（例: 4桁なら "1234"、5桁なら "12345"）
  const sampleDigits = Array.from({ length: p.length }, (_, i) => (i % 9) + 1).join('');
  const full = p.template.replace('{{input}}', sampleDigits);
  hintEl.innerHTML = `例: <strong>${escHtml(full)}</strong>`;
}

const _origSelectEmailPattern = selectEmailPattern;
selectEmailPattern = function (index, fromUserTap) {
  // ユーザーが自分で学年を選択した時だけ「選択済み」フラグを立てる。
  // 学年選択ステップから次のステップへの遷移は「次へ」ボタンだけが行う。
  // 選択チップをタップしただけでは画面が進まないように、ここから
  // checkoutGoNext() は自動では呼ばない。
  if (fromUserTap) _gradePickedByUser = true;

  _origSelectEmailPattern(index, fromUserTap);
  updateEmailHint();
};

/* === チュートリアル（初回のみ） === */
const TUTORIAL_SHOWN_KEY = 'tutorial_shown';

function showTutorialIfFirstTime() {
  if (localStorage.getItem(TUTORIAL_SHOWN_KEY)) return;
  showTutorial();
}

function showTutorial() {
  const existing = document.getElementById('tutorial-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'tutorial-overlay';
  overlay.className = 'tutorial-overlay';
  overlay.innerHTML = `
    <div class="tutorial-backdrop"></div>
    <div class="tutorial-card">
      <div class="tutorial-title">端末貸出管理システムへようこそ</div>
      <div class="tutorial-steps">
        <div class="tutorial-step">
          <div class="tutorial-step-num">1</div>
          <div class="tutorial-step-body">
            <div class="tutorial-step-title">端末を借りる</div>
            <div class="tutorial-step-desc">トップ画面の「貸出」をタップして、学年と学籍番号を入力</div>
          </div>
        </div>
        <div class="tutorial-step">
          <div class="tutorial-step-num">2</div>
          <div class="tutorial-step-body">
            <div class="tutorial-step-title">ドアが開きます</div>
            <div class="tutorial-step-desc">自分の番号のドアが開いたら、Chromebookを取り出してください</div>
          </div>
        </div>
        <div class="tutorial-step">
          <div class="tutorial-step-num">3</div>
          <div class="tutorial-step-body">
            <div class="tutorial-step-title">返却する</div>
            <div class="tutorial-step-desc">返却時に「返却」をタップして、Chromebookをドアに戻してください</div>
          </div>
        </div>
      </div>
      <button class="tutorial-close" onclick="closeTutorial()">はじめる</button>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => overlay.classList.add('show'));
  });

  overlay.querySelector('.tutorial-backdrop').addEventListener('click', closeTutorial);
}

function closeTutorial() {
  localStorage.setItem(TUTORIAL_SHOWN_KEY, '1');
  const overlay = document.getElementById('tutorial-overlay');
  if (overlay) {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 400);
  }
}

/* === 起動時のチュートリアル表示 === */
window.addEventListener('load', () => {
  // チュートリアルダイアログは不要なため非表示
});
