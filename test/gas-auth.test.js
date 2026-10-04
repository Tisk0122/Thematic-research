'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

function extractFunction(name) {
    const match = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(SOURCE);
    assert.ok(match, `${name} が gas/Code.gs に見つかりません`);
    const lines = SOURCE.slice(match.index).split('\n');
    const extracted = [];
    for (const line of lines) {
        extracted.push(line);
        if (line === '}') break;
    }
    return extracted.join('\n');
}

// スクリプトプロパティ/スクリプトロックを模した実行環境を作る。
// initial   : 初期プロパティ
// lockAvailable : スクリプトロックを取得できるか(同時リクエストの再現用)
function createGas(initial = {}, { lockAvailable = true } = {}) {
    const store = new Map(Object.entries(initial));
    const context = {
        store,
        console: { error: () => {}, log: () => {}, info: () => {} },
        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: key => (store.has(key) ? store.get(key) : null),
                setProperty: (key, value) => { store.set(key, String(value)); },
                deleteProperty: key => { store.delete(key); },
            }),
        },
        LockService: {
            // 実在するAPIは tryLock / waitLock のみ。
            // tryWaitLock を書くと、テストは通っても本番で
            // 「tryWaitLock is not a function」になる。
            // 未知のメソッドを呼ばないよう、Proxy で存在を検査する。
            getScriptLock: () => new Proxy({
                tryLock: () => lockAvailable,
                waitLock: () => { },
                releaseLock: () => { },
            }, {
                get(target, prop) {
                    if (!(prop in target)) {
                        throw new TypeError(`${String(prop)} is not a function`);
                    }
                    return target[prop];
                },
            }),
        },
        SYNC_TOKEN_PROP_KEY: 'SYNC_TOKEN',
        SYNC_PAIRING_OPEN_PROP_KEY: 'SYNC_PAIRING_OPEN',
        PAIRING_OPEN_TTL_MS: 60 * 60 * 1000,
        SYNC_TOKEN_MIN_LENGTH: 16,
        _authorizedToken: null,
    };
    vm.createContext(context);
    vm.runInContext([
        extractFunction('_timingSafeStringEqual'),
        extractFunction('_normalizeToken'),
        extractFunction('_pairingDeadline'),
        extractFunction('_isPairingOpen'),
        extractFunction('_pairTokenIfOpen'),
        extractFunction('_currentSyncToken'),
        extractFunction('_authorizeRequest'),
        extractFunction('resetSyncPairing'),
        'globalThis.api = { authorize: _authorizeRequest, reset: resetSyncPairing, currentToken: _currentSyncToken, deadline: function () { return _pairingDeadline(PropertiesService.getScriptProperties()); } };',
    ].join('\n\n'), context);
    return context;
}

const REAL_TOKEN = '0123456789abcdef0123456789abcdef';

test('未ペアリングかつ受付が閉じている場合は要求を拒否する', () => {
    const gas = createGas();
    const result = gas.api.authorize('syncFromLocal', { token: REAL_TOKEN });
    assert.equal(result.success, false);
    assert.match(result.message, /ペアリングされていません/);
    assert.match(result.message, /resetSyncPairing/);
    assert.equal(gas.store.get('SYNC_TOKEN'), undefined);
});

test('事前登録されたトークンだけを受け入れる', () => {
    const gas = createGas({ SYNC_TOKEN: 'expected-token' });
    assert.equal(gas.api.authorize('syncFromLocal', { token: 'expected-token' }), null);
    const result = gas.api.authorize('syncFromLocal', { token: 'other-token' });
    assert.match(result.message, /一致しません/);
});

test('resetSyncPairing はトークンを削除し受付期限を設定する', () => {
    const gas = createGas({ SYNC_TOKEN: 'old-token' });
    gas.api.reset();
    assert.equal(gas.store.get('SYNC_TOKEN'), undefined);
    const deadline = gas.api.deadline();
    assert.ok(deadline > Date.now(), '受付期限が未来であるべき');
    assert.ok(deadline <= Date.now() + 60 * 60 * 1000, '受付期限は60分以内であるべき');
});

test('resetSyncPairing を実行すると次の1リクエストで自動ペアリングされる', () => {
    const gas = createGas();
    gas.api.reset();
    assert.equal(gas.api.authorize('syncFromLocal', { token: REAL_TOKEN }), null);
    assert.equal(gas.store.get('SYNC_TOKEN'), REAL_TOKEN, '送信されたトークンが登録される');
    assert.equal(gas.store.get('SYNC_PAIRING_OPEN'), undefined, '受付は1回で閉じられる');
});

test('ペアリング後のリクエストは登録済みトークンで照合される', () => {
    const gas = createGas();
    gas.api.reset();
    gas.api.authorize('syncFromLocal', { token: REAL_TOKEN });
    const result = gas.api.authorize('syncFromLocal', { token: 'f'.repeat(32) });
    assert.match(result.message, /一致しません/);
    assert.equal(gas.store.get('SYNC_TOKEN'), REAL_TOKEN, '上書きされない');
});

test('受付期限切れではペアリングしない', () => {
    const gas = createGas({ SYNC_PAIRING_OPEN: String(Date.now() - 1000) });
    const result = gas.api.authorize('syncFromLocal', { token: REAL_TOKEN });
    assert.match(result.message, /ペアリングされていません/);
    assert.equal(gas.store.get('SYNC_TOKEN'), undefined);
    assert.equal(gas.store.get('SYNC_PAIRING_OPEN'), undefined, '期限切れの残骸は片付く');
});

test('受付中に短すぎるトークンではペアリング枠を消費しない', () => {
    const gas = createGas();
    gas.api.reset();
    const result = gas.api.authorize('syncFromLocal', { token: 'short' });
    assert.match(result.message, /ペアリングされていません/);
    assert.equal(gas.store.get('SYNC_TOKEN'), undefined);
    assert.ok(gas.api.deadline() > 0, '受付状態は残り続ける');
});

test('前後空白付きのトークンは正規化して受け入れる', () => {
    const gas = createGas();
    gas.api.reset();
    assert.equal(gas.api.authorize('syncFromLocal', { token: `  ${REAL_TOKEN}\n` }), null);
    assert.equal(gas.store.get('SYNC_TOKEN'), REAL_TOKEN);
    assert.equal(gas.api.authorize('syncFromLocal', { token: REAL_TOKEN }), null, '後続も通る');
});

test('トークン未送信のリクエストはペアリングしない', () => {
    const gas = createGas();
    gas.api.reset();
    const cases = [null, undefined, { token: null }, { token: 12345 }, { token: '   ' }];
    for (const params of cases) {
        const result = gas.api.authorize('syncFromLocal', params);
        assert.match(result.message, /ペアリングされていません/);
    }
    assert.equal(gas.store.get('SYNC_TOKEN'), undefined);
});

test('スクリプトロックが取れなければ上書きせず拒否する', () => {
    const gas = createGas({}, { lockAvailable: false });
    gas.api.reset();
    const result = gas.api.authorize('syncFromLocal', { token: REAL_TOKEN });
    assert.match(result.message, /ペアリングされていません/);
    assert.equal(gas.store.get('SYNC_TOKEN'), undefined);
});

test('壊れた受付期限値は安全側に倒して拒否する', () => {
    for (const value of ['abc', '0', '-1', 'NaN']) {
        const gas = createGas({ SYNC_PAIRING_OPEN: value });
        const result = gas.api.authorize('syncFromLocal', { token: REAL_TOKEN });
        assert.match(result.message, /ペアリングされていません/, `値 ${value} は拒否されるべき`);
        assert.equal(gas.store.get('SYNC_TOKEN'), undefined);
    }
});

test('自動ペアリング直後の実行内キャッシュからトークンを読める', () => {
    const gas = createGas();
    gas.api.reset();
    gas.api.authorize('syncFromLocal', { token: REAL_TOKEN });
    // プロパティの読み戻しが遅れて空文字になった情况的を再現しても、
    // 同一実行内ではキャッシュ側の値が使われる。
    gas.store.set('SYNC_TOKEN', '');
    assert.equal(gas.api.currentToken(), REAL_TOKEN);
});

test('スクリプトロックには実在するAPIしか呼ばない', () => {
    // Lock オブジェクトが持つのは tryLock / waitLock / releaseLock だけ。
    // tryWaitLock のような実在しない名前を使うと、
    // モックではテストが通っても本番で TypeError になる。
    const REAL_LOCK_METHODS = ['tryLock', 'waitLock', 'releaseLock'];
    const used = new Set();
    for (const m of SOURCE.matchAll(/\block\.([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[1]);
    assert.ok(used.size > 0, 'lock を使う処理が存在すること');
    for (const m of used) {
        assert.ok(REAL_LOCK_METHODS.includes(m), `lock.${m}() は Apps Script に存在しません`);
    }
    assert.ok(!/\block\.tryWaitLock\s*\(/.test(SOURCE), 'lock.tryWaitLock() が残っていないこと');
    assert.ok(!/tryWaitLock/.test(SOURCE.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
        'コメント以外に tryWaitLock が残っていないこと');
});

test('スクリプトプロパティには実在するAPIしか呼ばない', () => {
    const REAL_PROP_METHODS = [
        'getProperty', 'setProperty', 'deleteProperty', 'getProperties',
    ];
    const used = new Set();
    for (const m of SOURCE.matchAll(/props\.([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[1]);
    for (const m of used) {
        assert.ok(REAL_PROP_METHODS.includes(m), `props.${m}() は Apps Script に存在しません`);
    }
});
