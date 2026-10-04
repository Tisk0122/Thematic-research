'use strict';
/* ============================================================
   外部ストレージ（USBメモリ・SDカード）の自動検出モジュール

   用途:
     ・録画データ
     ・ローカルDBバックアップ(.db)
     ・設定(JSON)バックアップ
   の保存先を、外部ストレージが差し込まれている間はそこへ、
   無い場合は内部ストレージへ、自動で切り替える。

   検出の優先順位(先勝ち):
     1. EXTERNAL_STORAGE_DIR(環境変数で明示指定された保存先)
     2. SD_CARD_PATH(従来の固定SDパス / env)
     3. /media/* 以下のマウント(Linux)
     4. /run/media 配下のユーザー毎のマウント(udisks, Linux)
     5. lsblk が見つけた USB/MMC のマウントポイント(Linux・非同期検出のみ)

   いずれの候補も「実在する・ディレクトリである・書き込みできる」ことを
   確認してから採択する。USB/SD候補はマウント状態と保存先マーカーを毎回再確認し,
   現在使用中のルートも書き込み可能な状態か確認する。

   【自動適用(auto-adopt)】
   OSの自動マウントに失敗しているUSB(udisks2の設定やセッション状態が原因で
   /media 配下に出てこないケース。Linux Mintフォーラムでも多発している既知問題)
   向けに、lsblk でUSB/SDデバイスを発見したら udisksctl mount で自前で
   マウントを試みる。さらに、管理用媒体を区別するマーカー
   (.device-lending-storage)が無い外部媒体にも自動で設置して採用する。
   これにより「挿すだけで保存先として使われる」動作になる。
   誤採用防止のため、マーカー自動設置は『リムーバブルなUSB/SDデバイス』
   (lsblkの tran=usb/mmc/sdio)に限る。内部ディスクのパーティションは
   対象外(REMOVABLE_TRAN で判定)。

   システム領域(/, /boot, /home 等)やこのアプリ自身のディレクトリは
   常に対象外とする。
   ============================================================ */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const child_process = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(child_process.execFile);

const APP_ROOT = path.resolve(__dirname);
const EXTERNAL_DIR_ENV = process.env.EXTERNAL_STORAGE_DIR;
const SD_PATH_ENV = process.env.SD_CARD_PATH;
const LEGACY_SD_PATH = '/mnt/shared/removable/SD/';
const STORAGE_MARKER = '.device-lending-storage';
// 自動マウント・自動採用の対象とするバス種別(リムーバブル媒体のみ)。
const REMOVABLE_TRAN = new Set(['usb', 'mmc', 'sdio']);
// セルフマウント(uudisksctl)は失敗しても致命的ではないため、
// 連続して試す頻度を抑える最小間隔。
const MOUNT_RETRY_MIN_INTERVAL_MS = 30 * 1000;
let _lastSelfMountAttemptAt = 0;
let _lastSelfMountAttemptDev = ''; // 直近で試したデバイス(連打防止)

// 絶対に対象外にするシステム・OS領域
const _SYSTEM_MOUNTS = new Set([
  '/', '/boot', '/boot/firmware', '/home', '/tmp', '/var', '/usr', '/etc',
  '/proc', '/sys', '/dev', '/run', '/opt', '/sbin', '/bin', '/lib', '/root',
  '/snap', '/var/run', '/run', '/mnt', '/media'
]);

function _isCandidateRoot(mp) {
  if (!mp || typeof mp !== 'string') return false;
  mp = path.resolve(mp);
  if (_SYSTEM_MOUNTS.has(mp)) return false;
  // ホームディレクトリやその下は対象外（誤検出防止）
  const home = os.homedir();
  if (home && (mp === home || mp.startsWith(home + path.sep))) return false;
  // このアプリ自身の領域（アプリ本体・data・recordings 等）は対象外
  if (mp === APP_ROOT || mp.startsWith(APP_ROOT + path.sep)) return false;
  return true;
}

function _safeReaddirSync(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

function _dirIsValidSync(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (e) { return false; }
}

// dir が「実際に別のファイルシステムがマウントされている境界」かどうかを判定する。
// st_dev（デバイス番号）が親ディレクトリと異なっていれば、そこでマウントが
// 切り替わっている＝本物のマウントポイントだと分かる。
//
// これが無いと、Linux Mint 等（udisks2 + Nemo/Nautilus の自動マウント）で
// USBメモリを挿した際の実際のマウント先である
//   /media/<ユーザー名>/<ラベル名>
// よりも1階層上の
//   /media/<ユーザー名>            ← ただの空フォルダ。中身は内部ディスク上
// の方を先に見つけてしまい、そこを「書き込み可能な外部ストレージ候補」だと
// 誤検出してしまう（このフォルダ自体は内部ストレージ上に存在するため、以後
// ずっと実質「内部ストレージ」に書き込み続けてしまう＝本Issue の直接原因）。
function _isMountPointSync(dir) {
  try {
    const st = fs.statSync(dir);
    const parentSt = fs.statSync(path.dirname(dir));
    return st.dev !== parentSt.dev;
  } catch (e) {
    return false;
  }
}

async function _isMountPoint(dir) {
  try {
    const [st, parentSt] = await Promise.all([
      fsp.stat(dir),
      fsp.stat(path.dirname(dir)),
    ]);
    return st.dev !== parentSt.dev;
  } catch (e) {
    return false;
  }
}

function _probeWritableSync(dir) {
  try {
    const p = path.join(dir, `.kasa-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(p, 'ok');
    fs.unlinkSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

async function _probeWritable(dir) {
  try {
    const p = path.join(dir, `.kasa-${process.pid}-${Date.now()}.tmp`);
    await fsp.writeFile(p, 'ok');
    await fsp.unlink(p);
    return true;
  } catch (e) {
    return false;
  }
}

// 保存先マーカー(.device-lending-storage)の有無を非同期で確認する
async function _hasMarker(dir) {
  try { await fsp.access(path.join(dir, STORAGE_MARKER)); return true; } catch (e) { return false; }
}

async function _dirIsValidAsync(dir) {
  try { return (await fsp.stat(dir)).isDirectory(); } catch (e) { return false; }
}

// 同期検出（起動直後の高速パス用。lsblkを使わない）
function _collectCandidatesSync() {
  const candidates = [];
  if (EXTERNAL_DIR_ENV) candidates.push({ root: EXTERNAL_DIR_ENV, source: 'env' });
  candidates.push({
    root: SD_PATH_ENV || LEGACY_SD_PATH,
    source: 'mount'
  });
  // /media/* : ディストリビューションによってマウント構造が異なるため、
  // 1階層（例: Debian系の一部で /media/<ラベル名>）と、2階層
  // （例: Ubuntu/Linux Mint の udisks2+Nemo/Nautilus 自動マウントによる
  //  /media/<ユーザー名>/<ラベル名>）の両方を候補に入れる。
  // ただし「実際に別ファイルシステムがマウントされている場所」だけを候補にする
  // （_isMountPointSync）。これが無いと、2階層構成での中間ディレクトリ
  // （/media/<ユーザー名> ＝ただの内部ストレージ上の空フォルダ）を
  // 誤って外部ストレージとして採択してしまう。
  for (const ent of _safeReaddirSync('/media')) {
    const fp = path.join('/media', ent);
    if (_isCandidateRoot(fp) && _isMountPointSync(fp)) {
      candidates.push({ root: fp, source: 'scan' });
    }
    for (const sub of _safeReaddirSync(fp)) {
      const subfp = path.join(fp, sub);
      if (_isCandidateRoot(subfp) && _isMountPointSync(subfp)) {
        candidates.push({ root: subfp, source: 'scan' });
      }
    }
  }
  // /run/media/*/* : ユーザー毎のマウント（Fedora系等）。
  // こちらも同様に、実際のマウント境界であることを確認してから採用する。
  for (const user of _safeReaddirSync('/run/media')) {
    const userDir = path.join('/run/media', user);
    for (const ent of _safeReaddirSync(userDir)) {
      const fp = path.join(userDir, ent);
      if (_isCandidateRoot(fp) && _isMountPointSync(fp)) candidates.push({ root: fp, source: 'scan' });
    }
  }
  return candidates;
}// 非同期検出：lsblk から USB/MMC のマウントポイント候補を追加。
// あわせて:
//   - OSの自動マウントに失敗しているUSBがあれば udisksctl mount で自前で
//     マウントを試みる(成功すれば次の検出で候補になる)
//   - マーカーが無いリムーバブル媒体がマウントされていたら自動設置する
//     (auto-adopt。後述の autoAdopt が有効なときのみ)
async function _lsblkMountpoints({ autoAdopt = false, autoMount = true } = {}) {
  let data;
  try {
    const { stdout } = await execFileP(
      'lsblk', ['-o', 'NAME,MOUNTPOINTS,TRAN,RM', '-J'], { timeout: 5000 }
    );
    data = JSON.parse(stdout);
  } catch (e) {
    return [];
  }
  const out = [];
  const unmountedRemovable = [];
  const mountedRemovableWithoutMarker = [];

  // 注意: lsblk の TRAN(バス種別)は通常、ディスク(sda)には付くが
  // パーティション(sda1)には付かない。かつ、実際にファイルシステムが
  // マウントされるのはパーティション側なので、パーティション単体の
  // TRAN を見ていたのでは USB/SD のマウントポイントを一切拾えない
  // (sda1 は tran が空のため、そのままでは候補から漏れてしまう)。
  // 親デバイスの TRAN を子へ引き継いで判定する(sda=usb → sda1 も usb 扱い)。
  function walk(dev, parentTran) {
    const tran = ((dev.tran || parentTran) || '').toLowerCase();
    const removable = REMOVABLE_TRAN.has(tran)
      // RM(removable flag)が立っているものもリムーバブル扱い。
      // (SDリーダー経由などで tran が取れない環境の保険)
      || dev.rm === true || dev.rm === '1';
    const mps = Array.isArray(dev.mountpoints)
      ? dev.mountpoints.filter(Boolean)
      : (dev.mountpoint ? [dev.mountpoint] : []);
    if (removable) {
      if (mps.length === 0 && (dev.children || []).length === 0 && dev.fstype && dev.fstype !== '') {
        // ファイルシステムを持つパーティションなのに未マウント。
        // OS側の自動マウントが失敗している状態。
        unmountedRemovable.push('/dev/' + dev.name);
      } else if (mps.length > 0 && dev.fstype && dev.fstype !== '') {
        for (const mp of mps) {
          if (_isCandidateRoot(mp) && !fs.existsSync(path.join(mp, STORAGE_MARKER))) {
            mountedRemovableWithoutMarker.push({ root: mp, dev: '/dev/' + dev.name });
          }
        }
      }
    }
    for (const mp of mps) {
      if (mp && _isCandidateRoot(mp)) out.push({ root: mp, source: 'lsblk' });
    }
    for (const child of (dev.children || [])) walk(child, tran);
  }
  for (const dev of (data.blockdevices || [])) walk(dev, '');

  // --- セルフマウント(OSの自動マウントに頼れない環境向け) ---
  // udisksctl は desktop セッション外でも udisks2 が動いていれば
  // polkit の許可範囲でローカルユーザーがマウントできる。
  if (autoMount && unmountedRemovable.length) {
    const now = Date.now();
    const key = unmountedRemovable.join(',');
    if (now - _lastSelfMountAttemptAt > MOUNT_RETRY_MIN_INTERVAL_MS || key !== _lastSelfMountAttemptDev) {
      _lastSelfMountAttemptAt = now;
      _lastSelfMountAttemptDev = key;
      for (const devPath of unmountedRemovable) {
        try {
          // --no-block は使わない: マウント完了を待ってから次の検出で
          // 候補として拾えるようにする。
          const r = await execFileP('udisksctl', ['mount', '-b', devPath], { timeout: 10000 });
          const m = /:(.*)$/.exec(String(r.stdout || '').trim());
          if (m && m[1]) out.push({ root: m[1].trim(), source: 'lsblk' });
        } catch (e) {
          // udisks2 が無い / polkit で拒否された等。諦めて定期検出に任せる。
        }
      }
    }
  }

  // --- マーカー自動設置(auto-adopt) ---
  // リムーバブル媒体なのにマーカーが無い场合、挿すだけで使えるように
  // 自動で設置する。検出候補になっている(=実在・マウント済み)パスのみ。
  if (autoAdopt && mountedRemovableWithoutMarker.length) {
    for (const item of mountedRemovableWithoutMarker) {
      try {
        await fsp.writeFile(path.join(item.root, STORAGE_MARKER), '自動検出対象の管理用媒体です。\n');
        out.push({ root: item.root, source: 'lsblk' });
      } catch (e) {
        // 読み取り専用などで設置できない媒体は採用しない(従来どおり)。
      }
    }
  }
  return out;
}

async function _selectAsync(candidates, currentRoot) {
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.root)) continue;
    seen.add(c.root);
    if (!_isCandidateRoot(c.root)) continue;
    if (['scan', 'lsblk'].includes(c.source)) {
      try { await fsp.access(path.join(c.root, STORAGE_MARKER)); } catch (e) { continue; }
    }
    try {
      if (!(await fsp.stat(c.root)).isDirectory()) continue;
    } catch (e) {
      continue;
    }
    if (['mount', 'scan', 'lsblk'].includes(c.source)
      && !(await _isMountPoint(c.root))) continue;
    // 現在の保存先も毎回書き込み可能か確認する。USB取り外し後に内部側へ
    // フォールバックしたパスや読み取り専用になった媒体を、使用中と誤認しない。
    if (currentRoot && path.resolve(c.root) === path.resolve(currentRoot)) {
      if (await _probeWritable(c.root)) {
        return { found: true, root: c.root, source: c.source };
      }
      continue;
    }
    if (await _probeWritable(c.root)) {
      return { found: true, root: c.root, source: c.source };
    }
  }
  return { found: false, root: null, source: null };
}

// ----- OS標準のUSBホットプラグ通知（即時検出） -----
//
// 上記の detect()/detectSync() は「その時点のマウント状況を調べに行く」
// 方式（プル型）で、これだけだと差し込み/取り外しの反映は定期チェックの
// 周期（server.js側で30秒ごと）に依存してしまう。それだと「USBを抜いた
// 直後はまだ数十秒古い表示のまま」という体感になり得るため、OS側が
// 発する「今まさに挿した/抜いた」イベントを合わせて使い、変化があった
// 瞬間に呼び出し元へ即座に知らせる。
//
// Linuxでは udev がこの役割を担っており、`udevadm monitor` はその
// イベントをそのまま流し見できる標準コマンド（すべてのディストリの
// udevベース環境に存在し、追加インストール不要）。これを子プロセスとして
// 起動し、ブロックデバイス(USBメモリ・SDカード等)の追加/削除イベントが
// 流れてくるたびにコールバックを呼ぶ。
//
// 注意: udevイベントは「デバイスが現れた/消えた」ことを教えてくれるだけで、
// udisks2等による実際のファイルシステムのマウント/アンマウントが完了する
// 保証はない（マウントは少し遅れて完了することがある）。そのため呼び出し
// 側では、通知を受けたら少し待ってから（このモジュールでは呼び出し元の
// server.js が短いデバウンスをかける）改めて detect() で実際のマウント
// 状態を確認する使い方を前提とする。
//
// udevadm が無い環境では単に何も起動せず、呼び出し元の定期チェック
//（フォールバック）だけで動作する。
function watchHotplug(onChange) {
  if (typeof onChange !== 'function') return { stop() {} };

  let child = null;
  let stopped = false;
  let restartTimer = null;

  function spawnMonitor() {
    if (stopped) return;
    let proc;
    try {
      // --subsystem-match=block: ブロックデバイス(USB/SDカード等)関連の
      // イベントのみに絞る（キーボード抜き差し等の無関係なノイズを除く）。
      proc = child_process.spawn('udevadm', ['monitor', '--udev', '--subsystem-match=block'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      return; // udevadm が無い等。フォールバック（定期チェック）のみで動作。
    }
    child = proc;
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      // 1行に "UDEV  [...] add" / "remove" / "change" のいずれかを含む行が
      // デバイスの追加・削除・状態変化を表す。中身の詳細解析はせず、
      // 「何か変化があった」ことだけを合図として使う(誤検出しても
      // detect()側で実在確認するだけなので害が無い)。
      if (/\b(add|remove|change)\b/.test(text)) {
        try { onChange(); } catch (_) { }
      }
    });
    proc.on('exit', () => {
      child = null;
      if (stopped) return;
      // 予期せず終了した場合は5秒後に再起動を試みる（フォールバックの
      // 定期チェックがある限り致命的ではないが、できる限り即時性を保つ）。
      restartTimer = setTimeout(spawnMonitor, 5000);
    });
    proc.on('error', () => { child = null; });
  }

  spawnMonitor();

  return {
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (child) { try { child.kill(); } catch (_) { } }
    }
  };
}

// ----- 公開関数 -----

// 起動直後用の高速同期検出。見つからなければ { found: false }。
function detectSync() {
  for (const c of _collectCandidatesSync()) {
    if (!_isCandidateRoot(c.root)) continue;
    if (['scan', 'lsblk'].includes(c.source)
      && !fs.existsSync(path.join(c.root, STORAGE_MARKER))) continue;
    if (['mount', 'scan', 'lsblk'].includes(c.source)
      && !_isMountPointSync(c.root)) continue;
    if (!_dirIsValidSync(c.root)) continue;
    if (_probeWritableSync(c.root)) {
      return { found: true, root: c.root, source: c.source };
    }
  }
  return { found: false, root: null, source: null };
}

// 定期チェック用の非同期検出。lsblk も使う。
// options.currentRoot: 現在使用中の外部ルート（あれば）。
// options.autoAdopt: true のとき、マーカーが無いリムーバブル媒体へ
//   自動でマーカーを設置して採用対象にする(「挿すだけで使う」運用向け)。
//   既定は false(従来どおり明示設置されたマーカーのみ採用)。
async function detect(options) {
  const currentRoot = options && options.root;
  const autoAdopt = !!(options && options.autoAdopt);
  const candidates = _collectCandidatesSync();
  candidates.push(...(await _lsblkMountpoints({ autoAdopt })));
  return _selectAsync(candidates, currentRoot);
}

// ----- 検出の診断（デバッグ・運用支援） -----
//
// detect() の内部判断をそのまま使って、候補ごとに「どこで採用を断られたか」
// を検査する。実行環境で実際にどう見えているかをログに出し、
// 「USBが挿してあるのに外部ストレージとして採用されない」理由
// (マーカーなし / マウントされていない / 書き込み不可 など)を特定するため。
// この関数自体は何も採択しない(読み取り専用の検査)。
async function inspectDetection() {
  const rows = [];
  const candidates = _collectCandidatesSync();
  candidates.push(...(await _lsblkMountpoints()));
  for (const c of candidates) {
    const markerRequired = ['scan', 'lsblk'].includes(c.source);
    const mountPointRequired = ['mount', 'scan', 'lsblk'].includes(c.source);
    const dirValid = await _dirIsValidAsync(c.root);
    const row = {
      root: c.root,
      source: c.source,
      isCandidateRoot: _isCandidateRoot(c.root),
      markerRequired,
      markerFound: markerRequired ? await _hasMarker(c.root) : null,
      mountPointRequired,
      isMountPoint: mountPointRequired ? await _isMountPoint(c.root) : null,
      dirValid,
      writable: false,
    };
    if (dirValid) {
      try {
        const p = path.join(c.root, `.kasa-diag-${process.pid}-${Date.now()}.tmp`);
        await fsp.writeFile(p, 'ok');
        await fsp.unlink(p);
        row.writable = true;
      } catch (e) {
        row.writableError = (e && e.code) ? e.code : String((e && e.message) || e);
      }
    }
    rows.push(row);
  }
  return rows;
}

module.exports = { detectSync, detect, watchHotplug, inspectDetection };