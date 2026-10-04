'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');

function extractFunction(name) {
    const match = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm').exec(SOURCE);
    assert.ok(match, `${name} が js/admin.js に見つかりません`);
    const lines = SOURCE.slice(match.index).split('\n');
    const extracted = [];
    for (const line of lines) {
        extracted.push(line);
        if (line === '}') break;
    }
    return extracted.join('\n');
}

function makeElement(id) {
    const classes = new Set();
    return {
        id,
        disabled: false,
        innerHTML: 'label',
        textContent: '',
        dataset: {},
        classList: {
            add: c => classes.add(c),
            remove: c => classes.delete(c),
            contains: c => classes.has(c),
        },
    };
}

// 同期ボタンの状態管理だけを、最小限の DOM/ネットワーク差し替えで動かす。
function createEnv({ elements = {}, apiJson } = {}) {
    const els = {
        'spreadsheet-sync-now-btn': makeElement('spreadsheet-sync-now-btn'),
        'spreadsheet-sync-status': makeElement('spreadsheet-sync-status'),
        'spreadsheet-sync-detail': makeElement('spreadsheet-sync-detail'),
        'spreadsheet-sync-error': makeElement('spreadsheet-sync-error'),
        ...elements,
    };
    const toasts = [];
    const audits = [];
    const context = {
        console: { warn: () => { }, error: () => { }, log: () => { } },
        sessionToken: 'token',
        setTimeout,
        clearTimeout,
        document: { getElementById: id => els[id] || null },
        setBtnLoading(btn) {
            if (!btn) return;
            if (btn.dataset.prevHtml === undefined) btn.dataset.prevHtml = btn.innerHTML;
            btn.classList.add('btn-loading');
            btn.disabled = true;
        },
        resetBtn(btn) {
            if (!btn) return;
            if (btn.dataset.prevHtml !== undefined) btn.innerHTML = btn.dataset.prevHtml;
            btn.classList.remove('btn-loading');
            btn.disabled = false;
        },
        fmtDateTime: v => String(v),
        showToast: (m) => toasts.push(m),
        postAudit: async (a, d) => { audits.push(d); },
        apiJson: apiJson || (async () => ({ ok: true, enabled: true })),
    };
    vm.createContext(context);
    vm.runInContext([
        'let _spreadsheetSyncRunning = false;',
        'let _lastSpreadsheetSyncStatus = null;',
        'let _spreadsheetSyncRefreshTimers = [];',
        'let _spreadsheetSyncManualError = \'\';',
        'const SPREADSHEET_SYNC_TIMEOUT_MS = 120000;',
        'const SPREADSHEET_SYNC_WATCHDOG_MS = SPREADSHEET_SYNC_TIMEOUT_MS + 5000;',
        extractFunction('_clearSpreadsheetSyncRefreshTimers'),
        extractFunction('scheduleSpreadsheetSyncStatusRefresh'),
        extractFunction('applySpreadsheetSyncButtonState'),
        extractFunction('renderSpreadsheetSyncStatus'),
        extractFunction('loadSpreadsheetSyncStatus'),
        extractFunction('runManualSpreadsheetSync'),
        'globalThis.api = { run: runManualSpreadsheetSync, render: renderSpreadsheetSyncStatus, clearTimers: _clearSpreadsheetSyncRefreshTimers, state: function () { return { running: _spreadsheetSyncRunning, status: _lastSpreadsheetSyncStatus, timers: _spreadsheetSyncRefreshTimers.length }; } };',
    ].join('\n\n'), context);
    return { ctx: context, els, toasts, audits };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('初期状態では押せる(状態不明でも復帰手段を残す)', () => {
    const { ctx, els } = createEnv();
    ctx.api.render(null);
    assert.equal(els['spreadsheet-sync-now-btn'].disabled, false);
});

test('連携が無効な状態のときは押せない', () => {
    const { ctx, els } = createEnv();
    ctx.api.render({ enabled: false, configurationError: 'GAS_URL未設定' });
    assert.equal(els['spreadsheet-sync-now-btn'].disabled, true);
    assert.equal(els['spreadsheet-sync-detail'].textContent, 'GAS_URL未設定');
});

test('実行中は自動更新が走ってもボタンが押せない(二重送信を防ぐ)', async () => {
    const d = deferred();
    const { ctx, els } = createEnv({ apiJson: () => d.promise });
    const btn = els['spreadsheet-sync-now-btn'];

    const running = ctx.api.run(btn);
    assert.equal(btn.disabled, true, '開始直後は押せない');
    assert.equal(btn.classList.contains('btn-loading'), true, 'ローディング表示が出る');

    // 管理画面の6秒ごとの自動更新が実行中に走っても状態を壊さない
    ctx.api.render({ enabled: true, lastOkAt: 'x' });
    assert.equal(btn.disabled, true, '自動更新後も押せない');
    assert.equal(btn.classList.contains('btn-loading'), true, 'ローディング表示が残る');

    d.resolve({ ok: true, message: '同期しました' });
    await running;
    assert.equal(btn.disabled, false, '完了後は押せる');
    assert.equal(btn.classList.contains('btn-loading'), false, 'ローディング表示が外れる');
    assert.equal(btn.innerHTML, 'label', 'ラベルが元に戻る');
});

test('実行中に押されても二重送信されない', async () => {
    const d = deferred();
    let calls = 0;
    const { ctx, els } = createEnv({ apiJson: () => { calls++; return d.promise; } });
    const btn = els['spreadsheet-sync-now-btn'];

    const first = ctx.api.run(btn);
    await ctx.api.run(btn);
    await ctx.api.run(btn);
    assert.equal(calls, 1, 'POST は1回だけ');

    d.resolve({ ok: true });
    await first;
});

test('失敗してもローディングは必ず解除される', async () => {
    const { ctx, els } = createEnv({
        apiJson: async path => {
            if (path === '/api/sync-now') throw new Error('boom');
            return { ok: true, enabled: true, lastOkAt: 'x' };
        },
    });
    const btn = els['spreadsheet-sync-now-btn'];

    await ctx.api.run(btn);
    assert.equal(btn.classList.contains('btn-loading'), false);
    assert.equal(btn.disabled, false, '再度試せる状態に戻る');
    assert.equal(els['spreadsheet-sync-error'].textContent, 'boom', '失敗原因が表示に残る');
    assert.equal(els['spreadsheet-sync-status'].textContent, '手動同期に失敗しました');
});

test('状態取得自体が失敗しても失敗原因を消さない', async () => {
    const { ctx, els } = createEnv({ apiJson: async () => { throw new Error('offline'); } });
    const btn = els['spreadsheet-sync-now-btn'];

    await ctx.api.run(btn);
    assert.equal(els['spreadsheet-sync-error'].textContent, 'offline', '状態取得に失敗しても原因が残る');
    assert.equal(btn.disabled, false, '押せないまま終わらない');
});

test('状態が取得できない場合は理由表示を残して押せる状態に戻る', async () => {
    const { ctx, els } = createEnv({ apiJson: async () => { throw new Error('timeout'); } });
    const btn = els['spreadsheet-sync-now-btn'];

    await ctx.api.run(btn);
    assert.equal(els['spreadsheet-sync-status'].textContent, '手動同期に失敗しました');
    assert.equal(els['spreadsheet-sync-error'].textContent, 'timeout', '状態取得に失敗しても原因が残る');
    assert.equal(btn.disabled, false, '押せないまま終わらない');
});

test('サーバー側が実行中の応答(202)でもボタンは解放し、表示だけが追従する', async () => {
    const { ctx, els } = createEnv({
        apiJson: async (path) => (path === '/api/sync-now'
            ? { ok: true, queued: true, message: '同期処理中です' }
            : { ok: true, enabled: true }),
    });
    const btn = els['spreadsheet-sync-now-btn'];

    await ctx.api.run(btn);
    assert.equal(btn.disabled, false, '202でも押せる状態に戻る');
    assert.equal(ctx.api.state().timers, 7, '追従用のタイマーが予約される');
    ctx.api.clearTimers();
});

test('ログアウト時にタイマーと実行中フラグが破棄される', () => {
    const m = SOURCE.match(/function clearAdminBackgroundTasks\(\)[\s\S]*?\n\}/);
    assert.ok(m, 'clearAdminBackgroundTasks が見つかること');
    assert.ok(m[0].includes('_clearSpreadsheetSyncRefreshTimers()'), 'タイマーが破棄される');
    assert.ok(m[0].includes('_spreadsheetSyncRunning = false'), '実行中フラグが解除される');
});

test('同期リクエストにはタイムアウトが指定されている', () => {
    assert.match(SOURCE, /apiJson\('\/api\/sync-now', \{ method: 'POST', timeoutMs: SPREADSHEET_SYNC_TIMEOUT_MS \}\)/);
    assert.match(SOURCE, /apiJson\('\/api\/sync-status', \{ timeoutMs: \d+ \}\)/);
});
