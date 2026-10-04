'use strict';

/*
 * Arduino とのシリアル通信「だけ」を担当する子プロセス。
 * ------------------------------------------------------------
 * なぜ分離しているか:
 *   `serialport` はネイティブ（C++）アドオンを使うモジュールで、Arduino未接続
 *   時の検出・オープン処理などで、環境によっては JavaScript の try/catch では
 *   捕まえられない致命的エラー（セグメンテーションフォルト等）でプロセスごと
 *   即死することがある。
 *   これがメインサーバー（server.js）と同じプロセスで起きると、キオスク画面
 *   ごと・貸出/返却機能ごと巻き添えで落ち、アプリアイコンから起動しても
 *   「何も表示されずに消える」ように見えてしまう。
 *   このファイルを別プロセス（child_process.fork）として切り離すことで、
 *   万一ここでクラッシュしても影響はこのプロセスだけに閉じ込められ、
 *   メインサーバー・キオスク画面は動き続ける（Arduino機能だけが使えなくなる）。
 *
 * server.js とは IPC（process.send / process.on('message')）でやり取りする。
 * 送るメッセージ:
 *   { type: 'open',        path }              ポートを開けた
 *   { type: 'not_found',   message }           Arduinoが見つからない（未接続 等）
 *   { type: 'unavailable', message }           serialport モジュール自体が使えない
 *   { type: 'error',       message }           オープン後のシリアルエラー
 *   { type: 'close' }                          ポートが閉じた
 *   { type: 'line',        data }              Arduinoからの1行分の受信データ
 *   { type: 'write_error', message }           書き込み失敗
 * 受け取るメッセージ:
 *   { type: 'write', data }                    Arduinoへ書き込み
 *   { type: 'close' }                          明示的に閉じる（プロセスごと終了する）
 */

// 万一の同期例外でこのプロセスが落ちても、親（server.js）には影響しない。
// ここでは「落ちる前に理由を伝える」ことだけ試みる（間に合わない場合もある）。
process.on('uncaughtException', (err) => {
  try {
    process.send({ type: 'error', message: 'serial-bridge内で致命的エラー: ' + (err && err.stack || err) });
  } catch (_) { /* 送信自体に失敗しても諦めて終了する */ }
  process.exit(1);
});

const PORT_ARG = process.argv[2] || '';
const BAUD = parseInt(process.argv[3], 10) || 9600;

// Arduino(公式)および主要な互換クローン基板のベンダーID。
// 公式 ATmega/ATtiny(USB CDC): 0x2341, 0x2A03, 0x1B4E
// CH340 系クローン(最も一般的な互換チップ): 0x1A86
// CP2102/CP2104 系クローン: 0x10C4
// FTDI FT232 系クローン: 0x0403
// ESP32 系: 0x303A (Silicon Labs CP210x), 0x1A86 (CH340), 0x10C4
// Seeed/SparkFun: 0x2886, 0x1B4F
const KNOWN_ARDUINO_VIDS = ['2341', '2a03', '1b4e', '1a86', '10c4', '0403', '303a', '2886', '1b4f'];

let serial = null;
let _lastDetectionNote = '';
let _diagnostics = [];
let _portCandidates = [];

function logDiag(message) {
  _diagnostics.push(message);
  // ローカルファイルで追跡しやすいよう stderr にも出す(server.js には影響しない)
  try { process.stderr.write('[serial-bridge] ' + message + '\n'); } catch (_) {}
}

function isArduinoLike(p) {
  const vid = (p.vendorId || '').toLowerCase();
  if (KNOWN_ARDUINO_VIDS.includes(vid)) return true;

  // ベンダーID取得に失敗していても、ArduinoがCOMポートとして見えるWindowsでは、
  // シリアルポートの一覧に載っていれば候補とする(VIDがnullの機種/ドライバも多いため)。
  const path = String(p.path || '');
  const isSerial = /^(COM\d+|ttyACM\d+|ttyUSB\d+)$/i.test(path);
  if (isSerial && !vid) return true;

  return false;
}

async function detectPort() {
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    logDiag(`検出されたシリアルポート: ${JSON.stringify(ports)}`);
    const candidates = ports.filter(isArduinoLike);
    if (candidates.length === 1) {
      logDiag(`Arduino候補を1台特定: ${candidates[0].path} (VID=${candidates[0].vendorId || '不明'})`);
      return candidates[0].path;
    }
    if (candidates.length > 1) {
      _lastDetectionNote = `Arduinoらしきデバイスが${candidates.length}台見つかったため自動選択できません(${candidates.map(c => c.path).join(', ')})。run-server.sh/start.shの--serialで使用するポートを指定してください。`;
      logDiag(`Arduino候補が複数(${candidates.length}台)あります: ${candidates.map(c => c.path).join(', ')}`);
      // 複数台ある場合は、候補を試行順リストとして返す(openに失敗したら次を試す)。
      _portCandidates = candidates.map(c => c.path);
      return _portCandidates[0];
    }
    return _portCandidates[0] || null;
  } catch (e) {
    logDiag(`ポート一覧の取得に失敗: ${e.message}`);
    return null;
  }
}

// 明示指定されたポート(config.envのSERIAL_PORT)が、現在実際に存在するかを
// 確認する。USB機器の抜き差しや、別のPCで作った config.env をそのまま
// 使い回した場合など、指定されたポート名が現状と一致しないケースがある。
// 見つからない場合は、指定を無視して自動検出にフォールバックすることで、
// 「config.envを手動で書き換えないと直らない」状況を避ける。
async function resolveTargetPath() {
  if (!PORT_ARG) return detectPort();

  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    const exists = ports.some(p => p.path === PORT_ARG);
    if (exists) return PORT_ARG;
    // 指定されたポートが今は存在しない → 自動検出を試す
    const detected = await detectPort();
    return detected || PORT_ARG; // 自動検出もダメなら元の指定のまま試す(エラーメッセージで気づけるように)
  } catch (_) {
    return PORT_ARG; // ポート一覧取得自体に失敗した場合は、指定通りに開こうとする
  }
}

// ポートのオープンを試行する。失敗理由が「他プログラムに占有されている」
// (Windowsではよくある)などの一時的な場合は、ポートが解放されるまで数回リトライする。
// オープンに成功したら、このポートに対するすべての通信(受信・書込・open通知)を
// ここで一括でセットアップしてから親へ返す。
function setupPort(p, targetPath, ReadlineParser) {
  // バグ修正: maxLength を指定していなかったため、改行が届かない異常行が
  // 延々とメモリに溜まる恐れがあった。上限を超える行はエラーとして扱い、
  // ポートごと再オープンさせる（長大データは本来このブリッジが扱う
  // コマンド/ステータス交換に存在しないため、4096バイトで十分）。
  const parser = p.pipe(new ReadlineParser({ delimiter: '\n', maxLength: 4096 }));

  p.on('error', (err) => {
    try { process.send({ type: 'error', message: err.message || String(err) }); } catch (_) { }
  });
  p.on('close', () => {
    try { process.send({ type: 'close' }); } catch (_) { }
  });
  parser.on('data', (line) => {
    try { process.send({ type: 'line', data: line }); } catch (_) { }
  });

  // 親からの write / close メッセージを処理する
  const msgHandler = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'write') {
      try {
        p.write(msg.data, (err) => {
          if (err) {
            try { process.send({ type: 'write_error', message: err.message }); } catch (_) { }
          }
        });
      } catch (e) {
        try { process.send({ type: 'write_error', message: e.message || String(e) }); } catch (_) { }
      }
    } else if (msg.type === 'close') {
      try { process.removeListener('message', msgHandler); p.close(() => process.exit(0)); } catch (_) { process.exit(0); }
    }
  };
  process.on('message', msgHandler);

  // 開けたことを親へ通知
  try { process.send({ type: 'open', path: targetPath }); } catch (_) { }
}

function tryOpenPort(SerialPort, targetPath, ReadlineParser) {
  return new Promise((resolve) => {
    let attempt = 0;
    const MAX_ATTEMPTS = 15;
    const RETRY_DELAY = 1200;

    const doOpen = () => {
      attempt++;
      let p;
      try {
        p = new SerialPort({ path: targetPath, baudRate: BAUD, autoOpen: false });
      } catch (e) {
        logDiag(`ポート初期化失敗(${targetPath}): ${e.message}`);
        return resolve({ port: null, error: e.message || String(e) });
      }

      // オープン試行専用のリスナー。オープンに成功したら onOpen 内で必ず
      // onOpenError を外してから setupPort() へ通信用リスナーを任せる。
      // （外さないと、稼働中に発生したエラーでこの再試行用ハンドラが誤って動き、
      //   removeAllListeners() で setupPort() が貼った親通知リスナーまで剥がしてしまい、
      //   その後は切断を親へ一切通知できず、再試行も効かない "ゾンビ接続" になる）
      const onOpenError = (err) => {
        logDiag(`ポートオープン失敗(${targetPath}, attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message || String(err)}`);
        // once('open') リスナーは以後不要なので外しておく
        try { p.removeListener('open', onOpen); } catch (_) {}
        try { p.close(() => {}); } catch (_) {}
        if (attempt < MAX_ATTEMPTS) {
          setTimeout(doOpen, RETRY_DELAY);
        } else {
          resolve({ port: null, error: err.message || String(err) });
        }
      };
      const onOpen = () => {
        // オープン後は試行用エラーハンドラを必ず除去する。
        p.removeListener('error', onOpenError);
        logDiag(`ポートオープン成功(${targetPath})`);
        setupPort(p, targetPath, ReadlineParser);
        resolve({ port: p, error: null });
      };

      p.once('open', onOpen);
      p.once('error', onOpenError);

      try { p.open(); } catch (e) { logDiag(`open()呼び出し例外: ${e.message}`); resolve({ port: null, error: e.message }); }
    };

    doOpen();
  });
}

async function main() {
  let serialportLib;
  try {
    serialportLib = require('serialport');
  } catch (e) {
    process.send({ type: 'unavailable', message: 'serialport モジュールが見つかりません: ' + e.message + ' (起動前に npm install を実行してください)' });
    process.exit(0);
    return;
  }

  let ReadlineParser;
  try {
    ReadlineParser = require('@serialport/parser-readline').ReadlineParser;
  } catch (e) {
    process.send({ type: 'unavailable', message: '@serialport/parser-readline が見つかりません: ' + e.message });
    process.exit(0);
    return;
  }

  const { SerialPort } = serialportLib;

  // 最初はポート一覧を確認し、ここで全く見つからない場合は「確実に接続されていない」
  // と判断して通知する。ただし、ArduinoのUSBリセット中などで一時的に見えないこと
  // もあるため、少し待って再検出する。
  let targetPath = await resolveTargetPath();
  if (!targetPath) {
    // IDEなどがポートを一時的に掴んでいる可能性もあるため、少し間を置いて再試行する。
    let retryHit = false;
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1500));
      targetPath = await resolveTargetPath();
      if (targetPath) { retryHit = true; break; }
    }
    if (!targetPath) {
      process.send({ type: 'not_found', message: _lastDetectionNote || 'Arduinoポートが見つかりません（未接続の可能性があります）' });
      process.exit(0);
      return;
    }
  }

  // 試行順のリストを作る。明示指定されたポートを最優先し、続いて自動検出された候補を試す。
  const candidates = [];
  if (PORT_ARG) candidates.push(PORT_ARG);
  for (const c of _portCandidates) if (!candidates.includes(c)) candidates.push(c);
  if (!candidates.includes(targetPath)) candidates.push(targetPath);
  if (candidates.length === 0) candidates.push(targetPath);

  let serialPort = null;
  let lastError = null;

  for (const cand of candidates) {
    logDiag(`ポート候補を試行: ${cand}`);
    const result = await tryOpenPort(SerialPort, cand, ReadlineParser);
    if (result && result.port) {
      serialPort = result.port;
      break;
    }
    lastError = result && result.error;
    // 次の候補に進む前に少し待つ
    await new Promise(r => setTimeout(r, 500));
  }

  if (!serialPort) {
    const baseMsg = _lastDetectionNote
      ? _lastDetectionNote
      : lastError
        ? `Arduinoシリアルポートを開けませんでした: ${lastError}`
        : 'Arduinoポートが見つかりません（未接続の可能性があります）';
    process.send({ type: 'not_found', message: baseMsg });
    process.exit(0);
    return;
  }
}

main().catch((e) => {
  try { process.send({ type: 'error', message: String(e && e.stack || e) }); } catch (_) { }
  process.exit(1);
});
