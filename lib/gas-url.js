'use strict';

// 既定の GAS_URL は持たせない。
// 以前は空/未設定のときに「このリポジトリに埋め込まれた本番デプロイ URL」へ
// フォールバックしていたため、GAS_URL を設定し忘れた端末(別拠点のセットアップ等)が
// すべて同じスプレッドシートへデータを書き込んでしまう事故が起きていた。
// 未設定は「同期・メールが無効」というエラーとして扱い、server.js の GAS_URL_ERROR が
// ヘルスチェック(/api/health-status)に警告を出す。

const UNSET_ERROR =
  'config.env の GAS_URL が未設定です。導入する各拠点の Google Apps Script ' +
  '「ウェブアプリ」URL（https://script.google.com/macros/s/.../exec）を設定してください。';

function parseGasUrl(value) {
  const configured = String(value || '').trim();
  if (!configured) return { url: '', error: UNSET_ERROR };

  try {
    const parsed = new URL(configured);
    const valid = parsed.protocol === 'https:'
      && parsed.hostname === 'script.google.com'
      && /^\/macros\/s\/[^/]+\/exec\/?$/.test(parsed.pathname)
      && !parsed.username
      && !parsed.password
      && !parsed.hash;
    if (valid) return { url: parsed.toString(), error: '' };
  } catch (_) {
  }

  return {
    url: '',
    error: 'config.env の GAS_URL が正しくありません。Google Apps Script の「ウェブアプリ」URL（https://script.google.com/macros/s/.../exec）を確認し、設定ウィザードから修正してください。'
  };
}

module.exports = { parseGasUrl };
