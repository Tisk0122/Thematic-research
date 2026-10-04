'use strict';


const LogoutCheck = (() => {
  const MODEL_URL = '/model/model.json';
  const METADATA_URL = '/model/metadata.json';
  const CHECK_INTERVAL_MS = 600;     // 何msごとに1フレーム判定するか
  const OK_THRESHOLD = 0.85;         // Logout_Screen と判定する確信度のしきい値
  const OK_CONSECUTIVE_NEEDED = 3;   // 連続で何回しきい値を超えたら「確認OK」とするか（誤検知防止）
  const LABEL_LOGOUT = 'Logout_Screen';

  let _model = null;
  let _loadPromise = null;
  let _loadError = null;

  let _video = null;   // 内部用の非表示 <video>（camera.js のストリームを流し込む）
  let _canvas = null;  // フレームキャプチャ用の非表示 <canvas>（model.predict に渡す）
  let _timer = null;
  let _okStreak = 0;
  let _running = false;
  let _predicting = false;

  // start() は await（モデル読み込み・カメラ初期化・video.play）を挟むため、
  // 実行中は _running が false のままである。そのため _running だけを見る
  // 二重起動防止では、続けて2回 start() された場合に両方ともガードを通過して
  // setInterval を2つ作ってしまう。_starting を await 中も保持し、さらに
  // 世代番号を持たせて負けた側は処理を諦めさせる。
  let _starting = false;
  let _generation = 0;

  // モデル読み込み中の状態を外部（app.js）から監視できるようにする。
  // これにより「カメラ準備中」ではなく「画面認識モデル読み込み中」という
  // 具体的なローディング表示を出すことができる。
  // 読み込みが失敗した場合は 'error' を返し、手動確認へ切り替えられるようにする。
  function getLoadState() {
    if (_model) return 'ready';
    if (_loadError) return 'error';
    if (_loadPromise) return 'loading';
    return 'idle';
  }

  function _applyRealAspectRatio() {
    if (!_video || !_video.videoWidth || !_video.videoHeight) return;
    const preview = document.getElementById('logout-cam-preview');
    if (preview) {
      preview.style.aspectRatio = `${_video.videoWidth} / ${_video.videoHeight}`;
    }
  }

  function _log(...args) {
    if (typeof dlog === 'function') dlog('[LogoutCheck]', ...args);
  }

  function _warn(...args) {
    console.warn('[LogoutCheck]', ...args);
  }

  function _ensureLoaded() {
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
      if (typeof tmImage === 'undefined') {
        throw new Error('teachablemachine-image が読み込まれていません（js/vendor/teachablemachine-image.min.js を確認してください）');
      }
      _model = await tmImage.load(MODEL_URL, METADATA_URL);
      _log(`モデル読み込み完了（クラス数: ${_model.getTotalClasses()}）`);
    })();

    _loadPromise.catch(e => {
      _loadError = e;
      _warn('モデル読み込み失敗:', e.message);
    });

    return _loadPromise;
  }

  function preload() {
    _ensureLoaded().catch(e => _warn('事前読み込み失敗:', e.message));
  }

  function _ensureVideoAndCanvas() {
    _video = document.getElementById('logout-cam-video');
    if (!_canvas) {
      _canvas = document.createElement('canvas');
      _canvas.width = 224;
      _canvas.height = 224;
    }
  }

  function _captureFrame() {
    if (!_video || _video.readyState < 2) return false; // まだ映像が来ていない
    const vw = _video.videoWidth, vh = _video.videoHeight;
    if (!vw || !vh) return false;

    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2, sy = (vh - side) / 2;
    const ctx = _canvas.getContext('2d');
    ctx.drawImage(_video, sx, sy, side, side, 0, 0, _canvas.width, _canvas.height);
    return true;
  }

  async function start(opts = {}) {
    const { onStatus, onOk, onError } = opts;
    if (_running) stop(); // 二重起動防止
    // await の隙間でも二重起動させない。既に開始処理が走っている間は
    // 新しい開始要求をここで弾く。
    if (_starting) return;
    _starting = true;
    const myGeneration = ++_generation;

    // すべての return 経路で _starting を解除するため try/finally で囲む。
    try {
      try {
        await _ensureLoaded();
      } catch (e) {
        _warn('開始失敗:', e.message);
        if (onError) onError(e);
        return;
      }

      // await の後、stop() が初期化中に呼ばれた、または他の start() に
      // 世代を奪われている場合は諦める。ここで諦めないと、後で下の
      // setInterval が孤立したタイマーとして残り続ける。
      if (myGeneration !== _generation) return;

    let stream = null;
    if (typeof CameraModule !== 'undefined' && typeof CameraModule.getStream === 'function') {
      stream = CameraModule.getStream();
    }
    if ((!stream || !stream.active) && typeof CameraModule !== 'undefined' && typeof CameraModule.init === 'function') {
      try {
        const ok = await CameraModule.init();
        if (myGeneration !== _generation) return;
        if (ok) stream = CameraModule.getStream();
      } catch (e) {
        _warn('カメラの初期化に失敗:', e.message);
      }
    }
    if (myGeneration !== _generation) return;
    if (!stream || !stream.active) {
      const e = new Error('カメラストリームが取得できません（カメラが接続されていない、または権限がない可能性があります）');
      _warn(e.message);
      if (onError) onError(e);
      return;
    }

    _ensureVideoAndCanvas();
    if (!_video) {
      const e = new Error('カメラプレビュー用の video 要素 (#logout-cam-video) が見つかりません');
      _warn(e.message);
      if (onError) onError(e);
      return;
    }
    if (_video.srcObject !== stream) {
      _video.srcObject = stream;
      try { await _video.play(); } catch (_) { /* muted指定のため通常は自動再生ブロックされない */ }
      if (myGeneration !== _generation) return;
    }

    _applyRealAspectRatio();
    if (!_video.videoWidth) {
      _video.addEventListener('loadedmetadata', _applyRealAspectRatio, { once: true });
    }

    _okStreak = 0;
    _running = true;

    _timer = setInterval(async () => {
      if (!_running || _predicting) return;
      if (!_captureFrame()) return;

      _predicting = true;
      let predictions;
      try {
        predictions = await _model.predict(_canvas);
      } catch (e) {
        _warn('推論エラー:', e.message);
        _predicting = false;
        return;
      }
      _predicting = false;

      if (!_running) return;

      let bestLabel = null, bestConf = -1, logoutConf = 0;
      predictions.forEach(p => {
        if (p.className === LABEL_LOGOUT) logoutConf = p.probability;
        if (p.probability > bestConf) { bestLabel = p.className; bestConf = p.probability; }
      });

      const isOk = logoutConf >= OK_THRESHOLD;
      _okStreak = isOk ? _okStreak + 1 : 0;

      _log(`判定: ${bestLabel} (${(bestConf * 100).toFixed(0)}%) / logout=${(logoutConf * 100).toFixed(0)}% streak=${_okStreak}`);

      if (onStatus) onStatus({ label: bestLabel, confidence: bestConf, logoutConfidence: logoutConf, isOk });

      if (_okStreak >= OK_CONSECUTIVE_NEEDED) {
        stop();
        if (onOk) onOk();
      }
    }, CHECK_INTERVAL_MS);
    } finally {
      // 正常終了・早期 return（失敗/世代失効）いずれの経路でも、
      // await の隙間を塞いでいたガードは必ず解除する。
      _starting = false;
    }
  }

  function stop() {
    _running = false;
    // 初期化中（await の隙間）に stop() された場合に備え、世代を進めて
    // 走っている start() を諦めさせる。併せてガードも解除する。
    _generation++;
    _starting = false;
    _okStreak = 0;
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_video) {
      _video.srcObject = null;
      _video = null;
    }
  }

  return { preload, start, stop, getLoadState };
})();

window.LogoutCheck = LogoutCheck;
