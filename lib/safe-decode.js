'use strict';

// パスのパーセントデコードを安全に行う。不正な % 列(例: %zz)を含むURLは
// decodeURIComponent が URIError を投げる。これをそのまま呼び出し側の
// 大域的な try/catch に委ねると原因不明のHTTP 500になってしまうため、
// デコード失敗を { ok:false } として明示的に検知できるようにする
// (呼び出し側はクライアントエラー(400)を返す)。
function safeDecodePath(value) {
  try {
    return { ok: true, value: decodeURIComponent(String(value)) };
  } catch (_) {
    return { ok: false, value: null };
  }
}

module.exports = { safeDecodePath };