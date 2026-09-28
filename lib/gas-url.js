'use strict';

const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbyiLKE52vvcBKSUbJ5eihTrLOvr-eaO5_Ncr6por_Mypw2CCExBK2g1tU5FlN45Gvmt/exec';

function parseGasUrl(value) {
  const configured = String(value || '').trim();
  if (!configured) return { url: DEFAULT_GAS_URL, error: '' };

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

module.exports = { DEFAULT_GAS_URL, parseGasUrl };
