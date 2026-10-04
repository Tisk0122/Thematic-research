'use strict';

// ============================================================
// ログの世代ローテーション(server.jsonl / audit.jsonl)に対する回帰テスト。
//
// 検証する不変条件:
//   1. 5MB超のログは「後半だけ残す」のではなく、世代ファイルへ退避される
//   2. 世代は上限(.3)までしか増えず、最古だけが置き換わる
//   3. 5MB未満のログには一切触れない
//
// server.js をそのまま require すると HTTP サーバーが listen してしまうため、
// ソースから _pruneLogFile の本体だけを取り出し、実ファイルに対して検証する。
// ============================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const MAX_LOG_SIZE = 5 * 1024 * 1024;

function buildPruneLog() {
  const match = /^(?:async )?function\s+_pruneLogFile\s*\(/m.exec(SERVER);
  assert.ok(match, '_pruneLogFile が server.js に見つかりません');
  const lines = SERVER.slice(match.index).split('\n');
  const extracted = [];
  for (const line of lines) {
    extracted.push(line);
    if (line === '}') break;
  }

  const genMatch = /const MAX_LOG_GENERATIONS = (\d+);/.exec(SERVER);
  assert.ok(genMatch, 'MAX_LOG_GENERATIONS の定義が必要');

  const context = {
    fs,
    fsp,
    path,
    MAX_LOG_SIZE,
    MAX_LOG_GENERATIONS: Number(genMatch[1]),
    // 実際の slog は LOG_FILE へ書きに行くため、ここでは黙らせる
    slog: () => { }
  };
  vm.runInNewContext(extracted.join('\n') + '\nglobalThis.pruneLogFile = _pruneLogFile;', context);
  return context;
}

// 識別文字列 + 指定サイズのログファイルを作る
function makeTempLog(header, extraBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-'));
  const file = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header), Buffer.alloc(extraBytes)]));
  return { dir, file };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('5MB未満のログには一切触れない', async () => {
  const ctx = buildPruneLog();
  const { dir, file } = makeTempLog('HEAD-RECORD\n', 1024);
  try {
    await ctx.pruneLogFile(file);
    assert.equal(fs.existsSync(file + '.1'), false, '世代ファイルを作らない');
    assert.equal(fs.statSync(file).size, Buffer.byteLength('HEAD-RECORD\n') + 1024,
      'サイズも変えない(全内容がそのまま残る)');
    assert.ok(fs.readFileSync(file, 'utf8').startsWith('HEAD-RECORD'), '内容を変えない');
  } finally {
    cleanup(dir);
  }
});

test('5MB超のログは .1 へ退避され、前半(証跡)が欠落しない', async () => {
  const ctx = buildPruneLog();
  const { dir, file } = makeTempLog('EARLY-EVIDENCE\n', MAX_LOG_SIZE);
  try {
    assert.ok(fs.statSync(file).size > MAX_LOG_SIZE, '前提: 5MBを超えている');
    await ctx.pruneLogFile(file);

    assert.ok(fs.existsSync(file + '.1'), '.1 に退避する');
    const gen1 = fs.readFileSync(file + '.1', 'utf8');
    assert.ok(gen1.startsWith('EARLY-EVIDENCE'), '前半の証跡がそのまま保持される');
    assert.ok(gen1.length > MAX_LOG_SIZE, '退避先にデータが欠けていない');
    assert.equal(fs.statSync(file).size, 0, '現行ファイルは空でやり直せる');
    assert.ok(fs.existsSync(file), '現行ファイル自体は残す');
  } finally {
    cleanup(dir);
  }
});

test('再度のローテートで既存世代が .2 へずれ、新しい .1 が生まれる', async () => {
  const ctx = buildPruneLog();
  const { dir, file } = makeTempLog('FIRST-BATCH\n', MAX_LOG_SIZE);
  try {
    await ctx.pruneLogFile(file);
    // 2回目: 現行に別のバッチを入れてローテート
    fs.writeFileSync(file, Buffer.concat([Buffer.from('SECOND-BATCH\n'), Buffer.alloc(MAX_LOG_SIZE)]));
    await ctx.pruneLogFile(file);

    assert.ok(fs.existsSync(file + '.1'), '.1 がある');
    assert.ok(fs.existsSync(file + '.2'), '.2 がある');
    assert.ok(fs.readFileSync(file + '.2', 'utf8').startsWith('FIRST-BATCH'), '.2 に1回目が入る');
    assert.ok(fs.readFileSync(file + '.1', 'utf8').startsWith('SECOND-BATCH'), '.1 に2回目が入る');
    assert.equal(fs.existsSync(file + '.3'), false, '3回目までは .3 を作らない');
  } finally {
    cleanup(dir);
  }
});

test('世代は上限(.3)まで。最古だけが置き換わり、.4 は作られない', async () => {
  const ctx = buildPruneLog();
  const genMatch = /const MAX_LOG_GENERATIONS = (\d+);/.exec(SERVER);
  const maxGen = Number(genMatch[1]);
  const { dir, file } = makeTempLog('BATCH-1\n', MAX_LOG_SIZE);
  try {
    for (let round = 1; round <= maxGen + 1; round++) {
      if (round > 1) {
        fs.writeFileSync(file, Buffer.concat([
          Buffer.from(`BATCH-${round}\n`),
          Buffer.alloc(MAX_LOG_SIZE)
        ]));
      }
      await ctx.pruneLogFile(file);
    }

    for (let i = 1; i <= maxGen; i++) {
      assert.ok(fs.existsSync(`${file}.${i}`), `.${i} が存在する`);
    }
    assert.equal(fs.existsSync(`${file}.${maxGen + 1}`), false,
      `上限の .${maxGen} を超える世代は作らない`);
    assert.ok(fs.readFileSync(`${file}.${maxGen}`, 'utf8').startsWith('BATCH-2'),
      '最古の世代は次にローテートした分で置き換わる');
    assert.ok(fs.readFileSync(`${file}.1`, 'utf8').startsWith(`BATCH-${maxGen + 1}`),
      '.1 は常に最新');
  } finally {
    cleanup(dir);
  }
});

test('半減方式(後半の行だけ残す)は廃止され、rename による退避になっている', () => {
  assert.ok(!SERVER.includes('lines.slice(half)'), '半減処理を残さない');
  assert.ok(!SERVER.includes('ログファイルを圧縮しました'), '旧・圧縮ログの出力を残さない');
  assert.ok(SERVER.includes('fsp.rename(filePath, `${filePath}.1`)'),
    '現行ファイルを .1 へ rename する');
  assert.ok(SERVER.includes('for (let i = MAX_LOG_GENERATIONS - 1; i >= 1; i--)'),
    '世代を1つずつずらすループがある');
});
