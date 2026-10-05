/* ============================================================
   リモート設定（遠隔からの設定変更の依頼を、教室PCで承認する画面）
   - GASの「郵便受け」に登録された依頼は、ここで承認するまで設定へ反映されない。
   - 項目ごとに「適用する／ローカルのまま」を選べる。
   - 適用する値はサーバーが保管した値を使う（この画面から値は送らない）。
   ============================================================ */

let _rsData = null;
let _rsBusy = false;

const RS_STATUS_LABEL = {
  pending: '承認待ち', applied: '承認・適用済み', partial: '一部のみ適用', rejected: '却下（ローカルのまま）',
  expired: '期限切れ', invalid: '検証失敗（破棄）', cancelled: '依頼者が取り消し'
};
function rsStatusLabel(h) {
  if (h.status === 'applied' && String(h.decidedBy || '').indexOf('自動適用') === 0) return '自動適用済み';
  return RS_STATUS_LABEL[h.status] || h.status;
}
const RS_STATUS_CHIP = {
  pending: 'chip-warn', applied: 'chip-ok', partial: 'chip-ok', rejected: 'chip-neutral',
  expired: 'chip-neutral', invalid: 'chip-danger', cancelled: 'chip-neutral'
};

function rsFmtValue(row, v) {
  if (v === undefined || v === null) return '（未設定）';
  if (row.type === 'emailList' && v === '') return '未設定（GASの既定宛先）';
  if (v === '') return '（未設定）';
  if (row.type === 'bool') return v ? 'オン' : 'オフ';
  if (row.type === 'date' && v === 'unlimited') return '無期限';
  if (row.type === 'enum') {
    const hit = (row.options || []).find(o => o.value === v);
    return hit ? hit.label : String(v);
  }
  if (row.type === 'int') return String(v) + (row.unit || '');
  if (row.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
    return `${Number(v.slice(0, 4))}年${Number(v.slice(5, 7))}月${Number(v.slice(8, 10))}日`;
  }
  if (row.type === 'timeList') return String(v).split(',').join('、');
  if (row.type === 'emailList') return v ? String(v).split(',').join('、') : '未設定（GASの既定宛先）';
  if (row.type === 'intList') return v.map((n, i) => `CB-${String(i + 1).padStart(2, '0')} ${n}ms`).join(' / ');
  if (row.type === 'patternList') {
    const text = v.map(pattern => `${pattern.label}: ${pattern.template} (${pattern.length}桁)`).join(' / ');
    return text.length > 180 ? text.slice(0, 177) + '…' : text;
  }
  return String(v);
}

function rsRemaining(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '期限切れ';
  const h = Math.floor(ms / 3600000);
  if (h >= 48) return `あと${Math.floor(h / 24)}日`;
  if (h >= 1) return `あと${h}時間`;
  return `あと${Math.max(1, Math.floor(ms / 60000))}分`;
}

async function loadRemoteSettingsView() {
  const btn = document.getElementById('rs-refresh-btn');
  setBtnLoading(btn);
  try {
    _rsData = await apiJson('/api/remote-settings');
    renderRemoteSettings();
    rsSetBadge(_rsData.pending.length);
  } catch (e) {
    showToast('リモート設定の取得に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

function rsSetBadge(n) {
  const b = document.getElementById('badge-remote-settings');
  if (!b) return;
  if (n > 0) { b.style.display = 'block'; b.textContent = n > 99 ? '99+' : n; } else { b.style.display = 'none'; }
}

async function refreshRemoteSettingsBadge() {
  try {
    const r = await apiJson('/api/remote-settings/summary');
    rsSetBadge(r.pending || 0);
  } catch (_) { /* バッジは補助表示 */ }
}

function renderRemoteSettings() {
  const d = _rsData;
  if (!d) return;

  // --- 状態バナー ---
  const st = document.getElementById('rs-status-text');
  const dot = document.getElementById('rs-status-dot');
  let text; let color = 'var(--text-dim)';
  if (d.mode === 'off') {
    text = '遠隔からの設定変更は受け付けていません（この端末のローカル設定のみで運用中）。';
  } else if (!d.poll.gasConfigured) {
    text = 'GAS連携が未設定のため、遠隔の依頼は取得できません。';
    color = 'var(--warn-strong)';
  } else if (d.poll.lastError) {
    text = `最後の確認に失敗しました: ${d.poll.lastError}`;
    color = 'var(--warn-strong)';
  } else if (d.poll.lastOkAt) {
    text = `約${Math.round((d.poll.intervalMs || 180000) / 60000)}分ごとに確認しています（最終確認: ${fmtDateTime(d.poll.lastOkAt)}）。承認するまで設定は変わりません。`;
    color = 'var(--ok-strong)';
  } else {
    text = '確認を待っています。承認するまで設定は変わりません。';
  }
  st.textContent = text;
  dot.style.background = color;

  // --- 承認待ち ---
  const list = document.getElementById('rs-pending-list');
  document.getElementById('rs-pending-count').textContent = d.pending.length ? `${d.pending.length} 件` : '承認待ちはありません';
  if (d.pending.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-text">遠隔からの設定変更の依頼は届いていません。<br>依頼はスプレッドシートの「リモート設定」メニューから作成されます。</div></div>`;
  } else {
    list.innerHTML = d.pending.map(rsRenderRequest).join('');
  }

  // --- 受信設定 ---
  const modeInput = document.querySelector(`input[name="rs-mode"][value="${d.mode}"]`);
  if (modeInput) modeInput.checked = true;
  rsRenderLockList(d);
  rsRenderAutoList(d);

  // --- 履歴 ---
  const hb = document.getElementById('rs-history-body');
  if (d.history.length === 0) {
    hb.innerHTML = '<tr><td colspan="5" class="table-empty-cell">履歴はまだありません</td></tr>';
  } else {
    hb.innerHTML = d.history.map(h => {
      const keys = (h.status === 'applied' || h.status === 'partial')
        ? h.appliedKeys.map(k => labelOf(k) + ((h.autoApplied || []).includes(k) ? '（自動）' : '')).join('、')
        : (h.labels || []).join('、');
      const note = h.decisionNote ? `<div class="text-dim" style="font-size:12px;">${escHtml(h.decisionNote)}</div>` : '';
      return `<tr>
        <td>${escHtml(fmtDateTime(h.receivedAt))}</td>
        <td>${escHtml(h.createdBy || '—')}</td>
        <td>${escHtml(keys || '—')}${note}</td>
        <td><span class="chip ${RS_STATUS_CHIP[h.status] || 'chip-neutral'}"><span class="chip-dot"></span>${escHtml(rsStatusLabel(h))}</span></td>
        <td>${escHtml(h.decidedAt ? fmtDateTime(h.decidedAt) : '—')}</td>
      </tr>`;
    }).join('');
  }
}

function labelOf(key) {
  const s = (_rsData.schema || []).find(x => x.key === key);
  return s ? s.label : key;
}

function rsRenderRequest(req) {
  const changedRows = req.rows.filter(r => r.changed);
  const rows = req.rows.map(r => {
    const same = !r.changed;
    return `<tr class="${same ? 'text-dim' : ''}">
      <td style="width:42px;text-align:center;">
        <input type="checkbox" class="rs-accept" data-req="${escHtml(req.id)}" data-key="${escHtml(r.key)}"
          ${same ? 'disabled' : 'checked'} aria-label="${escHtml(r.label)}を適用する">
      </td>
      <td><div style="font-weight:700;">${escHtml(r.label)}</div><div class="text-dim" style="font-size:11px;">${escHtml(r.group)}</div></td>
      <td>${escHtml(rsFmtValue(r, r.current))}</td>
      <td style="font-weight:700;${same ? '' : 'color:var(--warn-strong);'}">${same ? escHtml(rsFmtValue(r, r.proposed)) : '→ ' + escHtml(rsFmtValue(r, r.proposed))}</td>
      <td>${same ? '<span class="chip chip-neutral">変更なし</span>' : '<span class="chip chip-warn"><span class="chip-dot"></span>変更あり</span>'}</td>
    </tr>`;
  }).join('');
  const ignored = (req.ignoredKeys || []).length
    ? `<p class="field-hint">「ローカル固定」のため無視した項目: ${escHtml(req.ignoredKeys.map(labelOf).join('、'))}</p>` : '';
  const autoNote = (req.autoApplied || []).length
    ? `<div class="banner banner-ok" style="margin:10px 0;"><div><b>自動適用済み:</b> ${escHtml(req.autoApplied.map(labelOf).join('、'))}（この依頼の残りの項目だけが承認待ちです）</div></div>` : '';
  const note = req.note
    ? `<div class="banner" style="margin:10px 0;"><div><b>依頼者のメモ:</b> ${escHtml(req.note)}</div></div>` : '';
  return `
  <div class="card" style="margin-bottom:14px;" data-rs-card="${escHtml(req.id)}">
    <div class="card-head">
      <div>
        <div class="card-title">${escHtml(req.createdBy || '依頼者不明')} からの変更依頼</div>
        <div class="card-sub">依頼日時 ${escHtml(fmtDateTime(req.createdAt))} ／ 有効期限 ${escHtml(fmtDateTime(req.expiresAt))}（${escHtml(rsRemaining(req.expiresAt))}）／ 依頼ID <span class="mono">${escHtml(req.id)}</span></div>
      </div>
      <span class="chip chip-warn"><span class="chip-dot"></span>承認待ち</span>
    </div>
    <div class="card-body">
      ${autoNote}${note}
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th></th><th>項目</th><th>この端末の現在値</th><th>依頼された値</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${ignored}
      <p class="field-hint">チェックを外した項目は、この端末の現在の設定のまま（ローカルのまま）残ります。</p>
      <div class="flex-row" style="gap:8px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" data-rs-act="approve" data-req="${escHtml(req.id)}" ${changedRows.length ? '' : 'disabled'}>選択した項目を承認して適用</button>
        <button class="btn btn-ghost" data-rs-act="reject" data-req="${escHtml(req.id)}">すべて却下（ローカルのまま）</button>
      </div>
    </div>
  </div>`;
}

function rsRenderLockList(d) {
  const groups = {};
  d.schema.forEach(s => { (groups[s.group] = groups[s.group] || []).push(s); });
  const locked = new Set(d.lockedKeys);
  document.getElementById('rs-lock-list').innerHTML = Object.keys(groups).map(g => `
    <div style="margin-bottom:10px;">
      <div class="text-dim" style="font-size:12px;font-weight:700;margin-bottom:4px;">${escHtml(g)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px 18px;">
        ${groups[g].map(s => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;">
          <input type="checkbox" class="rs-lock" value="${escHtml(s.key)}" ${locked.has(s.key) ? 'checked' : ''}>${escHtml(s.label)}</label>`).join('')}
      </div>
    </div>`).join('');
}

function rsRenderAutoList(d) {
  const auto = new Set(d.autoKeys || []);
  const locked = new Set(d.lockedKeys || []);
  document.getElementById('rs-auto-list').innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px 18px;">${
    d.schema.map(s => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;">
      <input type="checkbox" class="rs-auto" value="${escHtml(s.key)}" ${auto.has(s.key) ? 'checked' : ''} ${locked.has(s.key) || s.autoApplyAllowed === false ? 'disabled' : ''}>${escHtml(s.label)}${s.autoApplyAllowed === false ? '（承認必須）' : ''}</label>`).join('')}</div>`;
}

// ローカル固定にした項目は自動適用の対象から外す（固定が優先）
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (!el || !el.classList || !el.classList.contains('rs-lock')) return;
  const auto = document.querySelector(`.rs-auto[value="${el.value}"]`);
  if (!auto) return;
  if (el.checked) { auto.checked = false; auto.disabled = true; } else { auto.disabled = false; }
});

async function rsDecide(id, accept) {
  if (_rsBusy) return;
  const req = _rsData.pending.find(r => r.id === id);
  if (!req) return;
  const rows = req.rows;
  if (accept.length > 0) {
    const lines = rows.filter(r => accept.includes(r.key))
      .map(r => `・${r.label}: ${rsFmtValue(r, r.current)} → ${rsFmtValue(r, r.proposed)}`);
    const kept = rows.filter(r => r.changed && !accept.includes(r.key)).map(r => r.label);
    const msg = `次の変更をこの端末の運用設定に適用します。\n\n${lines.join('\n')}` +
      (kept.length ? `\n\nローカルのまま残す項目: ${kept.join('、')}` : '') +
      '\n\n適用前の設定は自動バックアップされます。';
    const ok = await showConfirm('この変更を適用しますか？', msg, { okLabel: '承認して適用', danger: false });
    if (!ok) return;
  } else {
    const ok = await showConfirm('この依頼を却下しますか？', 'すべての項目をローカルのまま残し、依頼を却下します。依頼者には「却下」と通知されます。', { okLabel: '却下する' });
    if (!ok) return;
  }
  _rsBusy = true;
  try {
    const res = await apiJson('/api/remote-settings/decision', {
      method: 'POST',
      body: JSON.stringify({ id, acceptKeys: accept, expectedVersion: _rsData.settingsVersion })
    });
    showToast(res.status === 'rejected' ? '依頼を却下しました（設定は変更していません）'
      : res.status === 'partial' ? `選んだ${res.appliedKeys.length}項目を適用しました（残りはローカルのまま）`
        : `${res.appliedKeys.length}項目を適用しました`);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    _rsBusy = false;
    await loadRemoteSettingsView();
  }
}

async function rsSaveConfig() {
  const btn = document.getElementById('rs-config-save-btn');
  const mode = (document.querySelector('input[name="rs-mode"]:checked') || {}).value || 'approve';
  const lockedKeys = Array.from(document.querySelectorAll('.rs-lock:checked')).map(el => el.value);
  const autoKeys = Array.from(document.querySelectorAll('.rs-auto:checked')).map(el => el.value).filter(k => !lockedKeys.includes(k));
  setBtnLoading(btn);
  try {
    await apiJson('/api/remote-settings/config', { method: 'POST', body: JSON.stringify({ mode, lockedKeys, autoKeys }) });
    showToast('リモート設定の受信設定を保存しました');
    await loadRemoteSettingsView();
  } catch (e) {
    showToast('保存に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function rsPollNow() {
  const btn = document.getElementById('rs-poll-btn');
  setBtnLoading(btn);
  try {
    const r = await apiJson('/api/remote-settings/poll-now', { method: 'POST', body: '{}' });
    if (r.ok) showToast(r.received ? `新しい依頼を${r.received}件受信しました` : '新しい依頼はありません');
    else showToast(r.error || '確認できませんでした', 'error');
  } catch (e) {
    showToast('確認に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
    await loadRemoteSettingsView();
  }
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest && ev.target.closest('[data-rs-act]');
  if (!el) return;
  const id = el.getAttribute('data-req');
  if (el.getAttribute('data-rs-act') === 'approve') {
    const accept = Array.from(document.querySelectorAll('.rs-accept'))
      .filter(c => c.getAttribute('data-req') === id && c.checked && !c.disabled)
      .map(c => c.getAttribute('data-key'));
    if (accept.length === 0) { showToast('適用する項目を選ぶか、「すべて却下」を押してください', 'error'); return; }
    rsDecide(id, accept);
  } else if (el.getAttribute('data-rs-act') === 'reject') {
    rsDecide(id, []);
  }
});
