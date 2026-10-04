'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'external-storage.js'), 'utf8');

// lsblk の実出力に近い形: USBディスク(sda, tran=usb)と、
// その1つ目のパーティション(sda1, tranは空)が /mnt/ext/usb にマウントされている。
function lsblkOut(noTranOnPartition = true) {
  return JSON.stringify({
    blockdevices: [{
      name: 'sda',
      tran: 'usb',
      mountpoints: [null],
      children: [{
        name: 'sda1',
        tran: noTranOnPartition ? '' : 'usb',
        mountpoints: ['/mnt/ext/usb']
      }]
    }]
  });
}

// /media・/run/media が空で、/mnt/ext/usb だけが「実際のマウントポイント」に
// 存在するシナリオ(lsblk 検出だけが頼りになるケース)を構築する。
function loadStorageModule(opts) {
  opts = opts || {};
  const markedRoots = new Set(opts.markedRoots || []);
  const mountedMps = new Set(opts.mountedMps || ['/mnt/ext/usb']);
  const writes = [];

  const dirDev = (dir) => {
    if (dir === '/mnt/ext') return 5;
    if (dir === '/mnt/shared' || dir === '/mnt/shared/removable') return 5;
    if (mountedMps.has(dir)) return 99; // マウント境界: 親とは異なるデバイス番号
    return 5;
  };

  const fakeFs = {
    promises: {
      access(p) {
        if (p.endsWith('.device-lending-storage')) {
          const root = p.slice(0, -'.device-lending-storage'.length).replace(/\/+$/, '');
          return markedRoots.has(root) ? Promise.resolve() : Promise.reject(new Error('ENOENT'));
        }
        return Promise.resolve();
      },
      stat(dir) {
        if (!mountedMps.has(dir) && dir !== '/mnt/ext'
          && dir !== '/mnt/shared/removable/SD' && dir !== '/mnt/shared'
          && dir !== '/mnt/shared/removable') {
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
        return Promise.resolve({ isDirectory: () => true, dev: dirDev(dir) });
      },
      writeFile(p, data) { writes.push(p); return Promise.resolve(); },
      unlink() { return Promise.resolve(); }
    },
    readdirSync(dir) { return (dir === '/media' || dir === '/run/media') ? [] : []; },
    statSync(dir) {
      if (!mountedMps.has(dir)) throw new Error('ENOENT');
      return { isDirectory: () => true, dev: dirDev(dir) };
    },
    existsSync(p) {
      if (p.endsWith('.device-lending-storage')) {
        const root = p.slice(0, -'.device-lending-storage'.length);
        return markedRoots.has(root);
      }
      return mountedMps.has(p);
    },
    writeFileSync() {},
    unlinkSync() {}
  };

  const fakeUtil = {
    promisify: fn => (...args) => new Promise((resolve, reject) => {
      fn(...args, (error, value) => error ? reject(error) : resolve(value));
    })
  };

  const childProcess = {
    execFile: (_file, _args, _opts, callback) =>
      callback(null, { stdout: opts.lsblkOut === undefined ? lsblkOut() : opts.lsblkOut, stderr: '' }),
    execFileSync: () => ''
  };

  const module = { exports: {} };
  const writesRef = writes;
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
    clearTimeout,
    Date
  });
  return { storage: module.exports, writesRef };
}

test('lsblk: USBパーティション(TRAN空)にマウントされていても親のTRANを引き継いで検出する', async () => {
  const { storage } = loadStorageModule({
    markedRoots: ['/mnt/ext/usb'],
    lsblkOut: lsblkOut(true) // パーティションのtranは空、親ディスクだけが usb
  });
  const result = await storage.detect();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    found: true,
    root: '/mnt/ext/usb',
    source: 'lsblk'
  });
});

test('lsblk: マーカーが無いUSBマウントは採用せず、検出しない', async () => {
  const { storage } = loadStorageModule({
    markedRoots: [] // マーカー未配置
  });
  const result = await storage.detect();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    found: false,
    root: null,
    source: null
  });
});

test('inspectDetection: マーカー欠落の候補を理由付きで報告する', async () => {
  const { storage } = loadStorageModule({
    markedRoots: ['/mnt/ext/usb'], // detect では見つかる前提
    lsblkOut: lsblkOut(true)
  });
  // まず mark ありで detect が true になること自体の確認
  const det = await storage.detect();
  assert.equal(det.found, true);

  // 別インスタンスでマーカー無しの状態を作り、診断結果を確認する
  const { storage: storageNoMarker } = loadStorageModule({ markedRoots: [] });
  const rows = await storageNoMarker.inspectDetection();
  const usb = rows.find(r => r.root === '/mnt/ext/usb');
  assert.ok(usb, 'lsblk で見つかるはずのUSBマウントが診断候補に含まれていない');
  assert.equal(usb.source, 'lsblk');
  assert.equal(usb.markerRequired, true);
  assert.equal(usb.markerFound, false); // この理由で採用されない
  assert.equal(usb.isMountPoint, true);
  assert.equal(usb.dirValid, true);
  assert.equal(usb.writable, true);
});