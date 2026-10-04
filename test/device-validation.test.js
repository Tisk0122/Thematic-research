'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function extractFunction(source, name, file) {
    const match = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(source);
    assert.ok(match, `${name} が ${file} に見つかりません`);
    const lines = source.slice(match.index).split('\n');
    const extracted = [];
    for (const line of lines) {
        extracted.push(line);
        if (line === '}') break;
    }
    return extracted.join('\n');
}

const localSource = fs.readFileSync(path.join(__dirname, '..', 'local-db', 'lending.js'), 'utf8');
const gasSource = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');
const deviceIds = Array.from({ length: 12 }, (_, i) => `CB-${String(i + 1).padStart(2, '0')}`);

test('local DB and GAS reject failure reports for unknown device IDs', () => {
    const localContext = {
        ALL_DEVICES: deviceIds,
        db: { prepare() { throw new Error('invalid ID must be rejected before database access'); } },
    };
    vm.runInNewContext([
        extractFunction(localSource, 'addFailure', 'local-db/lending.js'),
        extractFunction(localSource, 'resolveFailure', 'local-db/lending.js'),
        'globalThis.localAddFailure = addFailure;',
        'globalThis.localResolveFailure = resolveFailure;',
    ].join('\n\n'), localContext);

    const gasContext = { ALL_DEVICES: deviceIds };
    vm.runInNewContext([
        extractFunction(gasSource, 'addFailure', 'gas/Code.gs'),
        extractFunction(gasSource, 'resolveFailure', 'gas/Code.gs'),
        'globalThis.gasAddFailure = addFailure;',
        'globalThis.gasResolveFailure = resolveFailure;',
    ].join('\n\n'), gasContext);

    for (const result of [
        localContext.localAddFailure({ deviceId: 'CB-99' }),
        localContext.localResolveFailure({ deviceId: 'CB-99' }),
        gasContext.gasAddFailure({ deviceId: 'CB-99' }),
        gasContext.gasResolveFailure({ deviceId: 'CB-99' }),
    ]) {
        assert.equal(result.success, false);
        assert.match(result.message, /不正/);
    }
});
