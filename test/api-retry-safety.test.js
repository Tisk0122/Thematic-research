'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8');

function createContext(fetch) {
  let timerId = 0;
  const clearedTimers = [];
  const context = {
    AbortController,
    URL,
    URLSearchParams,
    Response,
    fetch,
    console: { warn() {}, error() {} },
    setTimeout(callback, delay) {
      const id = ++timerId;
      if (delay < 15000) callback();
      return id;
    },
    clearTimeout(id) { clearedTimers.push(id); }
  };
  vm.runInNewContext(source, context);
  return { context, clearedTimers };
}

test('POST通信の失敗を自動再試行せず、処理結果不明を明示する', async () => {
  let requests = 0;
  const { context } = createContext(async () => {
    requests++;
    throw new TypeError('network error');
  });

  await assert.rejects(
    context.fetchWithRetry('/api/gas', { method: 'POST' }),
    error => error.uncertain === true && /処理済みの可能性/.test(error.message)
  );
  assert.equal(requests, 1);
});

test('GETは一時的な通信失敗後に再試行し、各要求のタイマーを解除する', async () => {
  let requests = 0;
  const { context, clearedTimers } = createContext(async () => {
    requests++;
    if (requests === 1) throw new TypeError('temporary network error');
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });

  const result = await context.fetchWithRetry('/api/gas', { method: 'GET' });
  assert.equal(result.success, true);
  assert.equal(requests, 2);
  assert.equal(clearedTimers.length, 2);
});

