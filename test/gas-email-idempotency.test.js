'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

function extractFunction(name) {
  const match = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(source);
  assert.ok(match, `${name} が gas/Code.gs に見つかりません`);
  const rest = source.slice(match.index);
  const end = rest.indexOf('\n}');
  assert.notEqual(end, -1, `${name} の終端が見つかりません`);
  return rest.slice(0, end + 2);
}

function createContext() {
  const properties = new Map();
  const rows = [];
  let hidden = false;
  const sheet = {
    getLastRow: () => rows.length,
    appendRow: row => rows.push(row.slice()),
    isSheetHidden: () => hidden,
    hideSheet: () => { hidden = true; },
    deleteRow: row => rows.splice(row - 1, 1),
    getRange(row, column, numRows, numColumns) {
      return {
        getValues: () => rows.slice(row - 1, row - 1 + numRows)
          .map(values => values.slice(column - 1, column - 1 + numColumns)),
        clearContent() {
          for (let i = row - 1; i < row - 1 + numRows; i++) {
            for (let j = column - 1; j < column - 1 + numColumns; j++) {
              if (rows[i]) rows[i][j] = '';
            }
          }
        },
        setValues(values) {
          values.forEach((value, i) => { rows[row - 1 + i] = value.slice(); });
        },
        createTextFinder(value) {
          let exact = false;
          const finder = {
            matchEntireCell: () => { exact = true; return finder; },
            findNext: () => rows.slice(row - 1, row - 1 + numRows)
              .some(values => exact ? values[column - 1] === value : String(values[column - 1]).includes(value))
              ? {} : null
          };
          return finder;
        }
      };
    }
  };
  let sent = 0;
  const context = {
    Date,
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => properties.get(key) || null,
        setProperty: (key, value) => properties.set(key, value),
        deleteProperty: key => properties.delete(key)
      })
    },
    getSheet: name => {
      assert.equal(name, 'メール送信重複防止');
      return sheet;
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (_algorithm, value) => [String(value).length, ...String(value).split('').map(c => c.charCodeAt(0))],
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url')
    }
  };
  vm.runInNewContext([
    `const USER_EMAIL_IDEMPOTENCY_SHEET = 'メール送信重複防止';`,
    `const USER_EMAIL_IDEMPOTENCY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;`,
    extractFunction('_userEmailIdempotencyHash'),
    extractFunction('_getUserEmailIdempotencySheet'),
    extractFunction('_pruneUserEmailIdempotencySheet'),
    extractFunction('_sendUserActionEmailOnce'),
    'globalThis.sendOnce = _sendUserActionEmailOnce;'
  ].join('\n\n'), context);

  return { context, getSent: () => sent, sendEmail: () => { sent++; } };
}

test('同じメールキューイベントの再送では二重送信しない', () => {
  const { context, getSent, sendEmail } = createContext();
  assert.equal(context.sendOnce('queue-1:created-at', sendEmail).success, true);
  const duplicate = context.sendOnce('queue-1:created-at', sendEmail);
  assert.equal(duplicate.success, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(getSent(), 1);
});

test('送信例外時は重複防止記録を解除して再試行できる', () => {
  const { context, getSent, sendEmail } = createContext();
  assert.throws(() => context.sendOnce('queue-2:created-at', () => {
    throw new Error('temporary send error');
  }), /temporary send error/);
  assert.equal(context.sendOnce('queue-2:created-at', sendEmail).success, true);
  assert.equal(getSent(), 1);
});
