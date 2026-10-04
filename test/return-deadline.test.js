'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'local-db', 'lending.js'), 'utf8');
const match = /^function\s+getLoanDeadline\s*\(/m.exec(SOURCE);
assert.ok(match, 'getLoanDeadline が local-db/lending.js に見つかりません');

const functionLines = SOURCE.slice(match.index).split('\n');
const getLoanDeadlineSource = [];
for (const line of functionLines) {
    getLoanDeadlineSource.push(line);
    if (line === '}') break;
}

const DEFAULT_SETTINGS = {
    returnDeadlineHour: 16,
    returnDeadlineMinute: 0,
    gracePeriodMinutes: 0,
};
const context = { Date, DEFAULT_SETTINGS };
vm.runInNewContext(`${getLoanDeadlineSource.join('\n')}\nglobalThis.getLoanDeadline = getLoanDeadline;`, context);

function settings(overrides = {}) {
    return Object.assign({}, DEFAULT_SETTINGS, overrides);
}

test('期限前の平日貸出は当日の設定時刻が期限になる', () => {
    const checkout = new Date(2025, 8, 1, 9, 0, 0);
    assert.deepEqual(
        context.getLoanDeadline({ checkout_time: checkout.toISOString() }, settings()),
        new Date(2025, 8, 1, 16, 0, 0)
    );
});

test('設定時刻を過ぎた貸出は翌日の同時刻が期限になる', () => {
    const checkout = new Date(2025, 8, 1, 17, 0, 0);
    assert.deepEqual(
        context.getLoanDeadline({ checkout_time: checkout.toISOString() }, settings()),
        new Date(2025, 8, 2, 16, 0, 0)
    );
});

test('金曜夕方の貸出期限は週末を繰り延べず翌日の設定時刻になる', () => {
    const checkout = new Date(2025, 8, 5, 17, 0, 0);
    assert.deepEqual(
        context.getLoanDeadline({ checkout_time: checkout.toISOString() }, settings()),
        new Date(2025, 8, 6, 16, 0, 0)
    );
});

test('期限時刻と猶予時間の設定が反映される', () => {
    const checkout = new Date(2025, 8, 1, 9, 0, 0);
    assert.deepEqual(
        context.getLoanDeadline({ checkout_time: checkout.toISOString() }, settings({
            returnDeadlineHour: 15,
            returnDeadlineMinute: 30,
            gracePeriodMinutes: 20,
        })),
        new Date(2025, 8, 1, 15, 50, 0)
    );
});

test('貸出時刻が不正または欠落している場合は null を返す', () => {
    assert.equal(context.getLoanDeadline({ checkout_time: 'invalid' }, settings()), null);
    assert.equal(context.getLoanDeadline({}, settings()), null);
});
