'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'local-db', 'lending.js'), 'utf8');
function extractFunction(source, name, file) {
    const match = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(source);
    assert.ok(match, `${name} が ${file} に見つかりません`);
    const lines = source.slice(match.index).split('\n');
    const functionLines = [];
    for (const line of lines) {
        functionLines.push(line);
        if (line === '}') break;
    }
    return functionLines.join('\n');
}

const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const context = { _sysSettings: { returnVerify: true } };
vm.runInNewContext([
    extractFunction(SOURCE, '_isReturnVerificationRequired', 'local-db/lending.js'),
    extractFunction(appSource, 'isReturnVerificationRequiredForLoan', 'js/app.js'),
    'globalThis.isReturnVerificationRequired = _isReturnVerificationRequired;',
    'globalThis.isKioskReturnVerificationRequired = isReturnVerificationRequiredForLoan;',
].join('\n\n'), context);

test('返却認証が貸出時にオフだった貸出は、後から設定をオンにしても生年月日を求めない', () => {
    assert.equal(context.isReturnVerificationRequired(
        { return_verify_required: 0 },
        { returnVerify: true }
    ), false);
});

test('貸出時に認証が必要でも現在の設定がオフなら生年月日を求めない', () => {
    assert.equal(context.isReturnVerificationRequired(
        { return_verify_required: 1 },
        { returnVerify: false }
    ), false);
});

test('貸出時と現在の両方で認証が有効なら生年月日を照合する', () => {
    assert.equal(context.isReturnVerificationRequired(
        { return_verify_required: 1 },
        { returnVerify: true }
    ), true);
});

test('キオスクは貸出時と現在の設定が両方有効な場合だけ生年月日入力を表示する', () => {
    context._sysSettings.returnVerify = true;
    assert.equal(context.isKioskReturnVerificationRequired({ returnVerifyRequired: true }), true);
    assert.equal(context.isKioskReturnVerificationRequired({ returnVerifyRequired: false }), false);

    context._sysSettings.returnVerify = false;
    assert.equal(context.isKioskReturnVerificationRequired({ returnVerifyRequired: true }), false);
});
