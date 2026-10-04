'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.LOCAL_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sy-')), 'test.db');
const { createSyncJob } = require('../local-db/sync');
const quiet = { warn() {}, error() {}, log() {} };

function stub(getReply) {
  return new Promise(resolve => {
    const state = { calls: 0 };
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        state.calls++;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(getReply()));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

test('変更がなければ2回目はGASを呼ばず、force指定なら必ず送る', async () => {
  const s = await stub(() => ({ success: true }));
  const job = createSyncJob({ gasUrl: s.url, token: 't', logger: quiet });
  assert.equal((await job.runOnce()).success, true);
  assert.equal(s.state.calls, 1);
  const again = await job.runOnce();
  assert.equal(again.success, true);
  assert.equal(again.skipped, true);
  assert.equal(s.state.calls, 1);
  await job.runOnce({ force: true });
  assert.equal(s.state.calls, 2);
  s.server.close();
});

test('失敗後はバックオフ中GASを呼ばず、forceなら呼ぶ', async () => {
  const s = await stub(() => ({ success: false, message: 'NG' }));
  const job = createSyncJob({ gasUrl: s.url, token: 't', logger: quiet });
  assert.equal((await job.runOnce()).success, false);
  assert.equal(s.state.calls, 1);
  const r = await job.runOnce();
  assert.equal(r.skipped, true);
  assert.equal(s.state.calls, 1);
  await job.runOnce({ force: true });
  assert.equal(s.state.calls, 2);
  s.server.close();
});
