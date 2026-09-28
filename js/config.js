'use strict';

const ALL_DEVICES = window.ALL_DEVICES;
if (!ALL_DEVICES) throw new Error('js/devices.jsが読み込まれていません');

const ARDUINO_SERVER = (typeof window !== 'undefined')
  ? window.location.origin
  : 'http://127.0.0.1:3000';
const DOOR_POLL_INTERVAL_MS = 200;
const DOOR_CLOSE_TIMEOUT_MS = 120_000;
const DOOR_UNLOCK_DURATION_MS = 1000;

// GAS_WRITE_ACTIONS は server.js 側の LOCAL_ACTIONS と連動する
// 書き込みを伴うアクションは常に POST で送信する（GETのクエリ文字列に個人情報を載せない）
// server.js は認証なしの GET では書き込み系を受け付けないため、
// このリストのアクションは必ず POST で送る必要がある
const GAS_WRITE_ACTIONS = new Set([
  'checkoutPrepare', 'checkoutCancel', 'checkoutCommit', 'checkout', 'checkoutAuto',
  'returnVerify', 'returnComplete',
  'addBlacklist', 'removeBlacklist', 'clearData', 'updateSettings',
  'forceReturnLoan', 'editHistoryEntry', 'deleteHistoryEntry',
  'updateUser', 'deleteUser', 'addFailure', 'resolveFailure'
]);

// ---------------------------------------------------------------------------
// 画面遷移ロック共有フラグ（_navLocked）
// ---------------------------------------------------------------------------
// 貸出・返却フロー中に扉の開閉待ちなど「途中で他のページへ飛ばれると困る」
// 状態のときに true にし、goTo() からの通常遷移をブロックするためのフラグ。
// ui.js の goTo() と app.js の貸出/返却処理の両方から参照・更新される
// 「共有状態」のため、config.js（index.html / admin.html のどちらでも
// 必ず最初に読み込まれる）で一度だけ宣言する。
// ui.js は app.js より先に読み込まれる構成のため、_navLocked を app.js側で
// 宣言してしまうと ui.js の初期化処理が先に goTo() を呼んだ瞬間に
// "_navLocked is not defined" になる（実際に起きていた不具合）。
// 単に ui.js 側にも同名の変数を追加すると二重定義になり責務が曖昧になるため、
// 読み込み順に依存しない共通の設定ファイルへ移動して一本化した。
let _navLocked = false;
