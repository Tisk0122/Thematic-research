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

function createAuthorizeRequest(storedToken) {
    const context = {
        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: key => key === 'SYNC_TOKEN' ? storedToken : null,
            }),
        },
        SYNC_TOKEN_PROP_KEY: 'SYNC_TOKEN',
    };
    vm.runInNewContext([
        extractFunction('_timingSafeStringEqual'),
        extractFunction('_authorizeRequest'),
        'globalThis.authorizeRequest = _authorizeRequest;',
    ].join('\n\n'), context);
    return context.authorizeRequest;
}

test('未登録のGASトークンでは要求を拒否する', () => {
    const authorize = createAuthorizeRequest('');
    assert.match(authorize('syncFromLocal', { token: 'unpaired-token' }).message, /未設定/);
});

test('事前登録されたトークンだけを受け入れる', () => {
    const authorize = createAuthorizeRequest('expected-token');
    assert.equal(authorize('syncFromLocal', { token: 'expected-token' }), null);
    assert.match(authorize('syncFromLocal', { token: 'other-token' }).message, /一致しません/);
});
