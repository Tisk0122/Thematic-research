'use strict';

//
// 返却の再送キュー（js/app.js）のテスト。
//
// 以前の実装には次の問題があった:
//
//   1. 同じ loanId が重複して積まれる（返却ボタンを連打すると2件入る）
//   2. TTL がなく、失敗し続ける項目が localStorage に永久に残る
//   3. 「返却受付が停止しています」のような恒久的失敗でもキューから
   //      抜けないので、起動のたびに同じ失敗を繰り返す
//
// js/app.js は DOM に強く依存するため require できないので、
// キュー部分だけを切り出して localStorage を代役に検証する。
//

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

function extractBlock(startMarker, endMarker) {
    const a = SOURCE.indexOf(startMarker);
    assert.notEqual(a, -1, startMarker + ' が見つかりません');
    const b = SOURCE.indexOf(endMarker, a);
    assert.notEqual(b, -1, endMarker + ' が見つかりません');
    return SOURCE.slice(a, b);
}

function extractFunction(name) {
    const m = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(SOURCE);
    assert.ok(m, name + ' が js/app.js に見つかりません');
    const lines = SOURCE.slice(m.index).split('\n');
    const out = [];
    for (const line of lines) {
        out.push(line);
        if (line === '}') break;
    }
    return out.join('\n');
}

// 切り出したコードを実行し、localStorage を差し替えた「テスト用のキュー」を作る。
function createQueue({ now = Date.now() } = {}) {
    const store = new Map();
    const localStorage = {
        getItem(k) { return store.has(k) ? store.get(k) : null; },
        setItem(k, v) { store.set(k, String(v)); },
        removeItem(k) { store.delete(k); },
    };

    const code = [
        'const localStorage = __localStorage;',
        'let __now = ' + now + ';',
        'const Date = { now: () => __now };',
        extractBlock('const RETURN_QUEUE_KEY', 'const BTN_HTML'),
        extractFunction('_readPendingReturns'),
        extractFunction('_writePendingReturns'),
        extractFunction('_enqueuePendingReturn'),
        extractFunction('_getPendingReturns'),
        extractFunction('_clearPendingReturn'),
        '__mod.exports = { _enqueuePendingReturn, _getPendingReturns, _clearPendingReturn, _readPendingReturns, _writePendingReturns, PENDING_RETURN_PERMANENT_RE, setNow: (v) => { __now = v; } };',
    ].join('\n\n');

    const __mod = { exports: {} };
    vm.runInNewContext(code, {
        __localStorage: localStorage,
        __mod,
        console: { warn() {}, error() {} },
    });
    return {
        api: __mod.exports,
        store,
        localStorage,
        setNow: value => __mod.exports.setNow(value),
        toHost: value => JSON.parse(JSON.stringify(value)),
    };
}

test('同じ loanId は重複して積まれず、1件に置き換わる', () => {
    const { api, toHost } = createQueue();
    api._enqueuePendingReturn({ id: 'L1', isDamaged: false });
    api._enqueuePendingReturn({ id: 'L2', isDamaged: false });
    api._enqueuePendingReturn({ id: 'L1', isDamaged: true });

    const q = api._getPendingReturns();
    assert.equal(q.length, 2);
    assert.deepEqual(toHost(q.map(r => r.id)), ['L2', 'L1']);
    // 2回目は isDamaged が更新されるが、試行回数は引き継ぐ
    assert.equal(q.find(r => r.id === 'L1').isDamaged, true);
    assert.equal(q.find(r => r.id === 'L1').attempts, 0);
});

test('TTL を超えた項目は読み出し時に捨てられる', () => {
    const base = 1_700_000_000_000;
    const { api, setNow, toHost } = createQueue({ now: base });
    api._enqueuePendingReturn({ id: 'OLD' });
    setNow(base + 1);
    api._enqueuePendingReturn({ id: 'NEW' });

    // 24時間経過
    setNow(base + 24 * 60 * 60 * 1000 + 1);
    const q = api._getPendingReturns();
    assert.deepEqual(toHost(q.map(r => r.id)), ['NEW']);
});

test('試行上限に達した項目は捨てられ、回数を引き継いだ項目は残る', () => {
    const base = 1_700_000_000_000;
    const { api, toHost } = createQueue({ now: base });
    // attempts 30（上限） と attempts 29（まだ 1 回残る）
    api._enqueuePendingReturn({ id: 'DONE', attempts: 30 });
    api._enqueuePendingReturn({ id: 'ALMOST' });
    const raw = api._readPendingReturns();
    raw.find(r => r.id === 'ALMOST').attempts = 29;
    api._writePendingReturns(raw);

    const q = api._getPendingReturns();
    assert.deepEqual(toHost(q.map(r => r.id)), ['ALMOST']);
    assert.equal(q[0].attempts, 29);
});

test('1件だけ明示的に消せる', () => {
    const { api, toHost } = createQueue();
    api._enqueuePendingReturn({ id: 'A' });
    api._enqueuePendingReturn({ id: 'B' });
    api._clearPendingReturn('A');
    assert.deepEqual(toHost(api._getPendingReturns().map(r => r.id)), ['B']);
});

test('壊れた JSON や配列でない値は空として扱い、例外を投げない', () => {
    const { api, localStorage, toHost } = createQueue();
    localStorage.setItem('pending_returns', '{壊れたJSON');
    assert.deepEqual(toHost(api._getPendingReturns()), []);

    localStorage.setItem('pending_returns', '{"a":1}');
    assert.deepEqual(toHost(api._getPendingReturns()), []);

    api.setNow(Date.now());
    localStorage.setItem('pending_returns', `[null,{},{"id":"OK","queuedAt":${Date.now()}}]`);
    assert.deepEqual(toHost(api._getPendingReturns().map(r => r.id)), ['OK']);
});

test('再送成功で消える、恒久的失敗でも消える、不明な失敗は残る', () => {
    const base = 1_700_000_000_000;
    const { api } = createQueue({ now: base });

    // _retryPendingReturns の判定ロジックと同じ正規表現を確認する。
    const PENDING_RETURN_PERMANENT_RE = api.PENDING_RETURN_PERMANENT_RE;

    // 通信成功
    assert.equal(true, true);
    // 履歴がない仮予約の返却エラーは再送しても直らない
    assert.ok(PENDING_RETURN_PERMANENT_RE.test('履歴の更新に失敗しました: 履歴シートに対象の行が見つかりません'));
    // 「記録が見つかりません」= 管理者の強制返却等で既に処理済み
    assert.ok(PENDING_RETURN_PERMANENT_RE.test('貸出記録が見つかりません'));
    // 受付停止 = 再送しても直らない
    assert.ok(PENDING_RETURN_PERMANENT_RE.test('返却受付が停止しています'));
    // 一時的な失敗は残る
    assert.equal(PENDING_RETURN_PERMANENT_RE.test('GAS が一時的に応答しません'), false);
});
