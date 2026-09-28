'use strict';

const CAM_SERVER = window.location.origin;

const MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

let _streamCam = null;
let _recorderCam = null;
let _sessionId = null;
let _isRecording = false;
let _uploadQueue = Promise.resolve(); // チャンクを順番に送るキュー
let _currentMime = '';               // 実際に使用しているMIMEタイプ
let _currentPage = null;             // 録画を開始したページ名（orphan検出用）

function camLog(level, ...args) {
  if (level === 'INFO' && !(typeof _sysSettings !== 'undefined' && _sysSettings.enableDebugLogs === true)) {
    return;
  }
  const ts = new Date().toISOString();
  const lvMap = { 'INFO': '情報', 'WARN': '警告', 'ERROR': 'エラー' };
  const lv = lvMap[level] || level;
  const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  fn(`[カメラ][${lv}] ${ts}`, ...args);
}

function selectMime() {
  for (const m of MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(m)) {
      camLog('INFO', `選択されたMIMEタイプ: ${m}`);
      return m;
    }
  }
  camLog('WARN', 'サポートされるMIMEタイプが見つかりません。デフォルトを使用します。');
  return '';
}

function getExtension(mime) {
  if (!mime) return 'webm';
  if (mime.startsWith('video/mp4')) return 'mp4';
  return 'webm';
}

function genSessionId() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${ts}_${Math.random().toString(36).slice(2, 7)}`;
}

function enqueueUpload(sessionId, streamType, blob, meta, ext) {
  _uploadQueue = _uploadQueue.then(async () => {
    // リトライ設定
    const MAX_RETRIES = 3;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        camLog('WARN', `チャンク送信リトライ ${attempt}/${MAX_RETRIES} (${delay}ms後):`, sessionId);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      try {
        const res = await fetch(`${CAM_SERVER}/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': blob.type || 'video/webm',
            'X-Session-Id': sessionId,
            'X-Stream-Type': streamType,
            'X-File-Ext': ext || 'webm',
            'X-Meta': encodeURIComponent(JSON.stringify(meta)),
          },
          body: blob,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        return; // 成功したら終了
      } catch (e) {
        lastError = e;
        camLog('ERROR', `チャンク送信失敗 (試行 ${attempt + 1}/${MAX_RETRIES + 1}):`, e.message);
      }
    }

    // 全リトライ失敗
    camLog('ERROR', `チャンク送信完全失敗 (${MAX_RETRIES + 1}回試行):`, sessionId, lastError?.message);
    reportCameraAlert('録画チャンクの送信に失敗しました', `sessionId=${sessionId} error=${lastError?.message}`);
  });
}

function _updateRecNoticeUI(recording) {
  const ids = ['checkout-rec-notice', 'confirm-rec-notice'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = recording ? 'flex' : 'none';
  });
}

let _lastCamAlertAt = 0;
const CAM_ALERT_COOLDOWN_MS = 60000; // 同じ端末から連続で通知が飛ばないようにする

function reportCameraAlert(message, context, status = 'error') {
  const now = Date.now();
  if (status !== 'ok') {
    if (now - _lastCamAlertAt < CAM_ALERT_COOLDOWN_MS) return;
    _lastCamAlertAt = now;
  }
  try {
    fetch(`${CAM_SERVER}/api/camera-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        message: status === 'ok' ? '' : message,
        context: context || (typeof KIOSK_ID !== 'undefined' ? KIOSK_ID : '')
      }),
      keepalive: true,
    }).catch(() => { });
  } catch (_) { /* 通知に失敗しても録画処理自体は継続する */ }
}

async function init() {
  if (_streamCam && _streamCam.active) return true;
  _streamCam = null; // 古いストリームをクリア
  try {
    camLog('INFO', 'カメラの初期化開始');
    _streamCam = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    _streamCam.getVideoTracks().forEach(track => {
      track.addEventListener('ended', () => {
        reportCameraAlert('カメラ接続が切断されました', track.label || '');
      }, { once: true });
    });
    camLog('INFO', 'カメラの初期化完了');
    reportCameraAlert('', typeof KIOSK_ID !== 'undefined' ? KIOSK_ID : '', 'ok');
    return true;
  } catch (e) {
    camLog('ERROR', '初期化失敗:', e.message);
    let friendly = 'カメラの初期化に失敗しました';
    if (e && e.name === 'NotFoundError') friendly = 'カメラが見つかりません（未接続の可能性）';
    else if (e && e.name === 'NotAllowedError') friendly = 'カメラの使用が許可されていません';
    else if (e && e.name === 'NotReadableError') friendly = 'カメラが他のアプリで使用中か、ハードウェアエラーが発生しています';
    reportCameraAlert(friendly, e && e.message);
    return false;
  }
}

async function startRecording(meta = {}, pageName = null) {
  if (_isRecording) {
    camLog('WARN', 'すでに録画中。既存録画を破棄して新規開始します。');
    await _forceStop('orphan');
  }
  camLog('INFO', '録画開始要求:', meta);

  try {
    if (!_streamCam || !_streamCam.active) {
      const ok = await init();
      if (!ok) throw new Error('カメラストリームが取得できません');
    }

    const mime = selectMime();
    _currentMime = mime;
    _sessionId = genSessionId();
    _currentPage = pageName;
    _uploadQueue = Promise.resolve();

    const ext = getExtension(mime);
    camLog('INFO', `sessionId: ${_sessionId} / MIME: ${mime || 'default'} / 拡張子: ${ext}`);

    const recorderOptions = mime ? { mimeType: mime } : {};
    _recorderCam = new MediaRecorder(_streamCam, recorderOptions);
    _recorderCam.ondataavailable = e => {
      if (e.data && e.data.size > 0) {
        enqueueUpload(_sessionId, 'cam', e.data, meta, ext);
      }
    };
    _recorderCam.onerror = e => camLog('ERROR', 'カメラ録画エラー:', e.error);
    _recorderCam.onstop = () => camLog('INFO', '録画ストリーム停止完了');

    _recorderCam.start(2000);

    _isRecording = true;
    _updateRecNoticeUI(true);
    // 録画が実際に始まった時点で無操作監視を起動する
    // （goTo() は録画開始前に走るため、ページ遷移だけでは監視が有効にならない）
    if (typeof startIdleTimer === 'function') startIdleTimer();
    camLog('INFO', '録画開始完了');
    return true;

  } catch (e) {
    camLog('ERROR', '録画開始失敗:', e.message);
    reportCameraAlert('録画の開始に失敗しました', e && e.message);
    _cleanup();
    return false;
  }
}

async function stopAndSaveRecording(meta = {}) {
  if (!_isRecording) { camLog('WARN', '録画中ではない（save）'); return; }
  const sid = _sessionId;
  const ext = getExtension(_currentMime);
  camLog('INFO', '録画停止 → 保存:', sid, meta);

  await _stopRecorders();
  await _uploadQueue; // 残チャンクの送信完了を待つ

  try {
    await fetch(`${CAM_SERVER}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sid,
        ext,
        meta: { ...meta, savedAt: new Date().toISOString() },
      }),
    });
    camLog('INFO', 'ファイナライズ完了:', sid);
  } catch (e) {
    camLog('ERROR', 'ファイナライズ失敗:', e.message);
  }

  _cleanup();
}

async function stopAndDeleteRecording(reason = 'cancel') {
  if (!_isRecording) { camLog('WARN', '録画中ではない（delete）'); return; }
  const sid = _sessionId;
  camLog('INFO', `録画停止 → 削除 (理由: ${reason}):`, sid);

  await _stopRecorders();
  await _uploadQueue;

  await deleteRecording(sid, reason);

  _cleanup();
}

async function _forceStop(reason = 'cancel') {
  const sid = _sessionId;
  camLog('WARN', `強制停止 (理由: ${reason}):`, sid);

  await _stopRecorders();

  // 保留中のアップロードを待つ（最大10秒）
  try {
    await Promise.race([
      _uploadQueue,
      new Promise((_, reject) => setTimeout(() => reject(new Error('タイムアウト')), 10000))
    ]);
  } catch (e) {
    camLog('WARN', '強制停止時のアップロード待機タイムアウト/エラー:', e.message);
  }

  if (sid) {
    await deleteRecording(sid, reason).catch(e => camLog('WARN', '強制停止時の削除失敗:', e.message));
  }
  _cleanup();
}

async function deleteRecording(sessionId, reason = 'return') {
  if (!sessionId) return;
  try {
    const res = await fetch(`${CAM_SERVER}/recording`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, reason }),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* 本文が無い/JSONでない場合は無視 */ }
    if (!res.ok || !data || data.ok !== true) {
      camLog('ERROR', `削除失敗 (${reason}) HTTP ${res.status}:`, sessionId, data && data.error);
      reportCameraAlert('不要な録画データの削除に失敗しました', `sessionId=${sessionId} reason=${reason} status=${res.status} error=${data && data.error}`);
      return;
    }
    camLog('INFO', `削除完了 (${reason}):`, sessionId, data.deleted);
  } catch (e) {
    camLog('ERROR', '削除リクエスト失敗:', sessionId, e.message);
    reportCameraAlert('不要な録画データの削除に失敗しました（通信エラー）', `sessionId=${sessionId} reason=${reason} ${e.message}`);
  }
}

function _stopRecorders() {
  return new Promise(resolve => {
    if (!_recorderCam || _recorderCam.state === 'inactive') { resolve(); return; }
    _recorderCam.addEventListener('stop', resolve, { once: true });
    try {
      _recorderCam.stop();
    } catch (e) {
      camLog('WARN', 'レコーダー停止エラー:', e.message);
      resolve();
    }
  });
}

function _cleanup() {
  _recorderCam = null;
  _sessionId = null;
  _isRecording = false;
  _currentMime = '';
  _currentPage = null;
  _uploadQueue = Promise.resolve();
  _updateRecNoticeUI(false);
  camLog('INFO', '録画リソース解放完了');
}

window.CameraModule = {
  init,
  startRecording,
  stopAndSaveRecording,
  stopAndDeleteRecording,
  deleteRecording,
  isRecording: () => _isRecording,
  sessionId: () => _sessionId,
  currentPage: () => _currentPage,
  getStream: () => _streamCam,
  abortIfOrphan: async (allowedPage) => {
    if (!_isRecording || !_currentPage) return;
    const snapPage = _currentPage;

    const isAllowed = (
      (snapPage === allowedPage) ||
      (snapPage === 'checkout' && (allowedPage === 'checkout-confirm' || allowedPage === 'checkout')) ||
      (snapPage === 'return-confirm' && (
        allowedPage === 'return-checklist' ||
        allowedPage === 'return-door' ||
        allowedPage === 'damage-teacher' ||
        allowedPage === 'damage-no-teacher' ||
        allowedPage === 'logout-guide' ||
        allowedPage === 'logout-verify' ||
        allowedPage === 'return-confirm'
      )) ||
      (snapPage === 'return-door' && allowedPage === 'return-done')
    );

    if (!isAllowed) {
      camLog('WARN', `Orphan録画を検出 (開始ページ: ${snapPage}, 現在: ${allowedPage})。停止します。`);
      await _forceStop('orphan');
    }
  },
};
