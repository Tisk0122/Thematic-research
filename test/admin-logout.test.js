'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');
const start = source.indexOf('async function logoutAdmin() {');
const end = source.indexOf('\n}\n\n// 全画面から抜け出す', start);
assert.notEqual(start, -1, 'logoutAdmin が見つかりません');
assert.notEqual(end, -1, 'logoutAdmin の終端が見つかりません');
const logoutFunction = source.slice(start, end + 2);

test('サーバーログアウト失敗時は管理者セッションを消さず再試行できる', async () => {
  const state = { token: null, removed: false, loginShown: false, toast: '' };
  const context = {
    showConfirm: async () => true,
    apiFetch: async () => { throw new Error('network unavailable'); },
    sessionStorage: { removeItem: () => { state.removed = true; } },
    clearAdminBackgroundTasks() {},
    showLoginScreen() { state.loginShown = true; },
    showToast(message) { state.toast = message; },
    console: { error() {} }
  };
  vm.runInNewContext([
    `const SESSION_KEY = 'admin_session_token';`,
    `let sessionToken = 'active-session';`,
    logoutFunction,
    'globalThis.runLogout = logoutAdmin;',
    'globalThis.getSessionToken = () => sessionToken;'
  ].join('\n\n'), context);

  await context.runLogout();
  assert.equal(context.getSessionToken(), 'active-session');
  assert.equal(state.removed, false);
  assert.equal(state.loginShown, false);
  assert.match(state.toast, /ログアウトできませんでした/);
});
