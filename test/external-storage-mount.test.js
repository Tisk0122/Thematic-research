'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'external-storage.js'), 'utf8');

function loadStorageModule() {
  const directories = new Set([
    '/mnt/shared/removable',
    '/mnt/shared/removable/SD'
  ]);
  const writes = [];
  const fakeFs = {
    promises: {},
    readdirSync: dir => (dir === '/media' || dir === '/run/media') ? [] : [],
    statSync(dir) {
      if (!directories.has(dir)) throw new Error('ENOENT');
      return { isDirectory: () => true, dev: 7 };
    },
    existsSync: () => false,
    writeFileSync: file => writes.push(file),
    unlinkSync() {}
  };
  const fakeUtil = {
    promisify: fn => (...args) => new Promise((resolve, reject) => {
      fn(...args, (error, value) => error ? reject(error) : resolve(value));
    })
  };
  const childProcess = {
    execFile: (_file, _args, callback) => callback(null, JSON.stringify({ blockdevices: [] }), ''),
    execFileSync: () => ''
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path.posix;
      if (name === 'os') return { homedir: () => '/home/teacher' };
      if (name === 'child_process') return childProcess;
      if (name === 'util') return fakeUtil;
      throw new Error(`Unexpected module: ${name}`);
    },
    __dirname: '/app',
    process: { platform: 'linux', pid: 1234, env: {} },
    module,
    console,
    setTimeout,
    clearTimeout
  });
  return { storage: module.exports, writes };
}

test('既定SDパスが未マウントの内部フォルダなら外部保存先にしない', () => {
  const { storage, writes } = loadStorageModule();
  assert.deepEqual(JSON.parse(JSON.stringify(storage.detectSync())), {
    found: false,
    root: null,
    source: null
  });
  assert.equal(writes.length, 0);
});

test('Linuxの非同期検出でも固定SDパスのマウント境界を必須にする', async () => {
  const { storage, writes } = loadStorageModule();
  const result = await storage.detect();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    found: false,
    root: null,
    source: null
  });
  assert.equal(writes.length, 0);
});
