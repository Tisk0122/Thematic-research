'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 一時DBを使い、本番DBには触れない(db.js より前に設定する)
process.env.LOCAL_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eq-')), 'test.db');

const db = require('../local-db/db');
const { enqueue, createEmailQueueWorker, classifyFailure } = require('../local-db/email_queue');

test('classifyFailure: 日次上限・レート制限・宛先不正・一時エラーを判別する', () => {
  assert.equal(classifyFailure({ code: 'QUOTA', message: 'x' }), 'quota');
  assert.equal(classifyFailure(new Error('Service invoked too many times for one day: email.')), 'quota');
  assert.equal(classifyFailure(new Error('本日のメール送信可能数の上限に達しています')), 'quota');
  assert.equal(classifyFailure(new Error('HTTP 429')), 'rate');
  assert.equal(classifyFailure({ code: 'INVALID_RECIPIENT', message: 'x' }), 'permanent');
  assert.equal(classifyFailure(new Error('Invalid email: abc')), 'permanent');
  assert.equal(classifyFailure(new Error('タイムアウト')), 'transient');
  assert.equal(classifyFailure(new Error('HTTP 500')), 'transient');
});

function startStub(handler) {
  return new Promise(resolve => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => {
        calls.push(JSON.parse(b));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(handler(calls.length)));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}
const quiet = { warn() {}, error() {}, log() {} };
const pending = () => db.prepare("SELECT * FROM email_queue WHERE sent_at = ''").all();

test('日次上限に達したら1通で送信を止め、行は消えずキューに残る', async () => {
  db.prepare('DELETE FROM email_queue').run();
  for (let i = 0; i < 5; i++) enqueue('checkout', { email: `a${i}@example.com`, name: 'x' });
  const stub = await startStub(() => ({ success: false, message: '上限', errorCode: 'QUOTA' }));
  const w = createEmailQueueWorker({ gasUrl: stub.url, token: 't', logger: quiet });
  await w.runOnce();
  assert.equal(stub.calls.length, 1, '上限後は残りを送らない');
  assert.equal(pending().length, 5, 'メールは失われない');
  await w.runOnce(); // 停止中は呼ばない
  assert.equal(stub.calls.length, 1);
  stub.server.close();
});

test('宛先不正は無限リトライせず破棄される', async () => {
  db.prepare('DELETE FROM email_queue').run();
  enqueue('return', { email: 'bad', name: 'x' });
  const stub = await startStub(() => ({ success: false, message: 'Invalid email: bad', errorCode: 'INVALID_RECIPIENT' }));
  const w = createEmailQueueWorker({ gasUrl: stub.url, token: 't', logger: quiet });
  await w.runOnce();
  assert.equal(pending().length, 0);
  assert.match(db.prepare('SELECT last_error FROM email_queue').get().last_error, /宛先不正/);
  stub.server.close();
});

test('7日超の未送信は送信されず破棄される', async () => {
  db.prepare('DELETE FROM email_queue').run();
  enqueue('checkout', { email: 'old@example.com', name: 'x' });
  db.prepare('UPDATE email_queue SET created_at = ?').run(new Date(Date.now() - 8 * 86400000).toISOString());
  const stub = await startStub(() => ({ success: true }));
  const w = createEmailQueueWorker({ gasUrl: stub.url, token: 't', logger: quiet });
  await w.runOnce();
  assert.equal(stub.calls.length, 0);
  assert.match(db.prepare('SELECT last_error FROM email_queue').get().last_error, /期限切れ/);
  stub.server.close();
});

test('一時エラーが続いたら1サイクルで3件までで中断する', async () => {
  db.prepare('DELETE FROM email_queue').run();
  for (let i = 0; i < 6; i++) enqueue('checkout', { email: `t${i}@example.com`, name: 'x' });
  const stub = await startStub(() => ({ success: false, message: '一時エラー' }));
  const w = createEmailQueueWorker({ gasUrl: stub.url, token: 't', logger: quiet });
  await w.runOnce();
  assert.equal(stub.calls.length, 3);
  stub.server.close();
});
