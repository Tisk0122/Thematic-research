'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_GAS_URL, parseGasUrl } = require('../lib/gas-url');

test('an empty GAS URL selects the configured default endpoint', () => {
  assert.deepEqual(parseGasUrl(''), { url: DEFAULT_GAS_URL, error: '' });
  assert.deepEqual(parseGasUrl('   '), { url: DEFAULT_GAS_URL, error: '' });
  assert.equal(DEFAULT_GAS_URL, 'https://script.google.com/macros/s/AKfycbyiLKE52vvcBKSUbJ5eihTrLOvr-eaO5_Ncr6por_Mypw2CCExBK2g1tU5FlN45Gvmt/exec');
});

test('a valid Apps Script web app URL is accepted', () => {
  const result = parseGasUrl('https://script.google.com/macros/s/deployment-id/exec');
  assert.equal(result.error, '');
  assert.equal(result.url, 'https://script.google.com/macros/s/deployment-id/exec');
});

test('invalid GAS URLs are reported without throwing', () => {
  for (const value of [
    'not a url',
    'http://script.google.com/macros/s/id/exec',
    'https://example.com/macros/s/id/exec',
    'https://script.google.com/'
  ]) {
    const result = parseGasUrl(value);
    assert.equal(result.url, '');
    assert.match(result.error, /GAS_URL/);
  }
});
