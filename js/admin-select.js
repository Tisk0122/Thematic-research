/* ============================================================
   カスタムセレクト（管理者パネル）
   ------------------------------------------------------------
   ネイティブ <select class="select"> をブラウザ標準の見た目のまま
   使うと、ポップアップ部分だけOS標準のスタイルになってしまい
   （特にダークモードでは文字が読めないほど視認性が落ちる）、
   管理画面全体のデザイントークンから浮いてしまう。

   この対応では、元の <select> は「値・イベントの発生源」として
   そのままDOMに残し、見た目だけをトークンに沿った独自の
   トリガー＋ポップアップに差し替える。既存コードが行っている
     - select.value の読み書き
     - onchange 属性 / addEventListener('change', ...)
     - select.innerHTML を書き換えての選択肢の動的更新
   はすべて今まで通り動作する（＝この後の実装は見た目の差し替えのみ）。
   ============================================================ */
(function () {
  'use strict';

  let uidSeq = 0;
  let closeActive = null; // 現在開いているパネルを閉じる関数（同時に1つだけ開く）

  function enhanceAll(root) {
    (root || document).querySelectorAll('select.select:not(.cs-native)').forEach(enhance);
  }

  function enhance(select) {
    if (select.classList.contains('cs-native')) return; // 二重初期化防止
    const uid = 'cs' + (++uidSeq);

    // --- 元のselectは値の入れ物として残し、見た目だけ隠す ---
    select.classList.add('cs-native');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');

    const wrap = document.createElement('div');
    wrap.className = 'cs-wrap';
    wrap.style.width = select.style.width || '100%';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cs-trigger';
    if (select.disabled) trigger.disabled = true;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML =
      '<span class="cs-trigger-label"></span>' +
      '<svg class="cs-arrow" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">' +
      '<path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    wrap.appendChild(trigger);
    const label = trigger.querySelector('.cs-trigger-label');

    const panel = document.createElement('div');
    panel.className = 'cs-panel';
    panel.id = uid + '-panel';
    panel.setAttribute('role', 'listbox');
    document.body.appendChild(panel);
    trigger.setAttribute('aria-controls', panel.id);

    let optionEls = [];
    let activeIndex = -1;
    let isOpen = false;

    // --- select.value への外部からの代入も見た目に反映させる ---
    const nativeValueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return nativeValueDesc.get.call(select); },
      set(v) {
        nativeValueDesc.set.call(select, v);
        syncLabel();
        if (isOpen) buildPanel();
      }
    });

    function syncLabel() {
      const opts = Array.from(select.options);
      const sel = opts[select.selectedIndex];
      label.textContent = sel ? sel.textContent : '';
      const disabled = select.disabled || opts.length === 0;
      trigger.disabled = disabled;
      trigger.classList.toggle('is-disabled', disabled);
    }

    function buildPanel() {
      panel.innerHTML = '';
      optionEls = Array.from(select.options).map((opt, i) => {
        const item = document.createElement('div');
        item.className = 'cs-option';
        item.id = uid + '-opt-' + i;
        item.setAttribute('role', 'option');
        const textSpan = document.createElement('span');
        textSpan.className = 'cs-option-text';
        textSpan.textContent = opt.textContent;
        item.appendChild(textSpan);
        if (opt.disabled) {
          item.classList.add('is-disabled');
          item.setAttribute('aria-disabled', 'true');
        }
        if (i === select.selectedIndex) {
          item.classList.add('is-selected');
          item.setAttribute('aria-selected', 'true');
          const ns = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(ns, 'svg');
          svg.setAttribute('class', 'cs-check');
          svg.setAttribute('width', '13');
          svg.setAttribute('height', '10');
          svg.setAttribute('viewBox', '0 0 13 10');
          svg.setAttribute('fill', 'none');
          svg.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS(ns, 'path');
          path.setAttribute('d', 'M1 5L4.5 8.5L12 1');
          path.setAttribute('stroke', 'currentColor');
          path.setAttribute('stroke-width', '1.8');
          path.setAttribute('stroke-linecap', 'round');
          path.setAttribute('stroke-linejoin', 'round');
          svg.appendChild(path);
          item.appendChild(svg);
        }
        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', () => {
          if (opt.disabled) return;
          applySelection(i);
          close();
          trigger.focus();
        });
        item.addEventListener('mouseenter', () => { if (!opt.disabled) setActive(i); });
        panel.appendChild(item);
        return item;
      });
    }

    function applySelection(i) {
      const opt = select.options[i];
      if (!opt) return;
      if (select.selectedIndex === i) return;
      select.value = opt.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setActive(i) {
      if (!optionEls.length) return;
      const idx = Math.max(0, Math.min(i, optionEls.length - 1));
      activeIndex = idx;
      optionEls.forEach((el, j) => el.classList.toggle('is-active', j === idx));
      trigger.setAttribute('aria-activedescendant', optionEls[idx].id);
      optionEls[idx].scrollIntoView({ block: 'nearest' });
    }

    function moveActive(delta) {
      if (!optionEls.length) return;
      let idx = activeIndex < 0 ? select.selectedIndex : activeIndex;
      for (let n = 0; n < optionEls.length; n++) {
        idx = (idx + delta + optionEls.length) % optionEls.length;
        if (!optionEls[idx].classList.contains('is-disabled')) break;
      }
      setActive(idx);
    }

    function place() {
      const r = trigger.getBoundingClientRect();
      const margin = 6;
      const maxW = Math.min(360, window.innerWidth - 16);
      panel.style.minWidth = r.width + 'px';
      panel.style.width = 'auto';
      panel.style.maxWidth = maxW + 'px';
      const panelWidth = Math.min(maxW, Math.max(r.width, panel.scrollWidth));
      let left = r.left;
      if (left + panelWidth > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - 8 - panelWidth);
      }
      panel.style.left = left + 'px';

      const maxH = Math.min(288, window.innerHeight - 24);
      panel.style.maxHeight = maxH + 'px';
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      const needed = Math.min(maxH, panel.scrollHeight || maxH);
      if (spaceBelow < needed && spaceAbove > spaceBelow) {
        panel.classList.add('cs-panel-up');
        panel.style.top = Math.max(8, r.top - margin - needed) + 'px';
        panel.style.maxHeight = Math.min(maxH, spaceAbove) + 'px';
      } else {
        panel.classList.remove('cs-panel-up');
        panel.style.top = (r.bottom + margin) + 'px';
        panel.style.maxHeight = Math.min(maxH, spaceBelow) + 'px';
      }
    }

    function onDocMouseDown(e) {
      if (wrap.contains(e.target) || panel.contains(e.target)) return;
      close();
    }
    function onReposition() { if (isOpen) place(); }

    function open() {
      if (trigger.disabled || isOpen) return;
      if (closeActive) closeActive();
      buildPanel();
      panel.style.visibility = 'hidden';
      panel.style.display = 'block';
      place();
      panel.style.visibility = '';
      // requestAnimationFrame で1フレーム後にトランジション開始
      requestAnimationFrame(() => panel.classList.add('is-open'));
      isOpen = true;
      trigger.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      setActive(select.selectedIndex < 0 ? 0 : select.selectedIndex);
      document.addEventListener('mousedown', onDocMouseDown, true);
      window.addEventListener('resize', onReposition);
      window.addEventListener('scroll', onReposition, true);
      closeActive = close;
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      panel.classList.remove('is-open');
      trigger.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      document.removeEventListener('mousedown', onDocMouseDown, true);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      if (closeActive === close) closeActive = null;
      setTimeout(() => { if (!isOpen) panel.style.display = 'none'; }, 160);
    }

    trigger.addEventListener('click', () => (isOpen ? close() : open()));
    trigger.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          isOpen ? moveActive(1) : open();
          break;
        case 'ArrowUp':
          e.preventDefault();
          isOpen ? moveActive(-1) : open();
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (!isOpen) { open(); }
          else if (activeIndex >= 0) {
            const el = optionEls[activeIndex];
            if (el && !el.classList.contains('is-disabled')) {
              applySelection(activeIndex);
              close();
            }
          }
          break;
        case 'Escape':
          if (isOpen) { e.preventDefault(); close(); }
          break;
        case 'Tab':
          if (isOpen) close();
          break;
        case 'Home':
          if (isOpen) { e.preventDefault(); setActive(0); }
          break;
        case 'End':
          if (isOpen) { e.preventDefault(); setActive(optionEls.length - 1); }
          break;
      }
    });

    // select.innerHTML の書き換え（動的な選択肢差し替え）を検知
    const mo = new MutationObserver(() => { syncLabel(); if (isOpen) buildPanel(); });
    mo.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    syncLabel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => enhanceAll());
  } else {
    enhanceAll();
  }

  // 後からDOMに追加される .select にも対応
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes && m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches && node.matches('select.select')) enhance(node);
        if (node.querySelectorAll) enhanceAll(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
