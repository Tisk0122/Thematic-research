'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'js', 'api.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function actionNames(source) {
  return new Set(Array.from(source.matchAll(/'([^']+)'/g), match => match[1]));
}

test('生徒画面でgasCallするアクションはローカルAPI対象として定義されている', () => {
  const localSet = apiSource.match(/const LOCAL_API_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(localSet, 'LOCAL_API_ACTIONS が見つかりません');
  const localActions = actionNames(localSet[1]);
  const appCalls = Array.from(appSource.matchAll(/\bgasCall\(\s*'([^']+)'/g), match => match[1]);
  assert.ok(appCalls.length > 0, '生徒画面のgasCall呼び出しが見つかりません');
  for (const action of appCalls) {
    assert.ok(localActions.has(action), `${action} がローカルAPI対象に含まれていません`);
  }

  const serverSets = serverSource.match(/const LOCAL_READ_ACTIONS = new Set\(\[([\s\S]*?)\]\);[\s\S]*?const LOCAL_WRITE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(serverSets, 'server.js のローカルアクション定義が見つかりません');
  const serverActions = new Set([
    ...actionNames(serverSets[1]),
    ...actionNames(serverSets[2])
  ]);
  for (const action of localActions) {
    assert.ok(serverActions.has(action), `${action} はserver.jsでローカル処理されません`);
  }
});

test('外部GASの4xxやネットワーク断でもローカル貸出APIは利用できる', async () => {
  const requests = [];
  const context = {
    AbortController,
    ARDUINO_SERVER: 'http://localhost:3000',
    GAS_WRITE_ACTIONS: new Set(['checkoutPrepare']),
    URL,
    URLSearchParams,
    clearTimeout,
    console: { warn() {}, error() {} },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('action=remoteOnly')) {
        return new Response(JSON.stringify({ error: 'GAS rejected request' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    },
    navigator: { onLine: true },
    sessionStorage: { getItem: () => null },
    setTimeout,
    _setConnState() {}
  };
  vm.runInNewContext(apiSource, context);

  await assert.rejects(context.gasCall('remoteOnly'), /GAS rejected request/);
  context.navigator.onLine = false;
  const result = await context.gasCall('checkoutPrepare', { name: 'Test' });

  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /\/api\/gas$/);
  assert.equal(requests[1].options.method, 'POST');
});
