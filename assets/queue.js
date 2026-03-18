// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — QUEUE MODULE (Up Next)
// ═══════════════════════════════════════════════════════════════

const Queue = (() => {

  // ─── State ──────────────────────────────────────────────────
  let _items     = [];
  let _panelOpen = false;

  // ─── DOM refs (resolved lazily to avoid timing issues) ───────
  const $ = id => document.getElementById(id);

  // ─── Helpers ────────────────────────────────────────────────
  function _updateBadge() {
    const n      = _items.length;
    const badge  = $('queue-badge');
    const countEl= $('queue-count');
    const emptyEl= $('queue-empty');

    if (badge) {
      badge.textContent   = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
      badge.style.display = n > 0 ? 'flex' : 'none';
    }
    if (countEl) countEl.textContent = n > 0 ? `${n} track${n !== 1 ? 's' : ''}` : '';
    if (emptyEl) emptyEl.style.display = n === 0 ? 'flex' : 'none';
  }

  function _escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Render queue list ───────────────────────────────────────
  function _render() {
    const list = $('queue-list');
    if (!list) return;
    _updateBadge();

    if (_items.length === 0) { list.innerHTML = ''; return; }

    const frag = document.createDocumentFragment();
    _items.forEach((track, i) => {
      const item = document.createElement('div');
      item.className  = 'queue-item';
      item.draggable  = true;
      item.dataset.idx = i;

      const artSrc = track.cover_art || '';
      item.innerHTML = `
        <div class="queue-item-drag">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
          </svg>
        </div>
        <div class="queue-item-num">${i + 1}</div>
        <div class="queue-item-art">
          ${artSrc
            ? `<img src="${_escHtml(artSrc)}" alt="" loading="lazy">`
            : `<div class="queue-item-art-placeholder">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                </svg>
              </div>`}
        </div>
        <div class="queue-item-info">
          <div class="queue-item-name">${_escHtml(track.name)}</div>
          <div class="queue-item-artist">${_escHtml(track.artist || '—')}</div>
        </div>
        <button class="queue-item-remove" title="Remove" data-idx="${i}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>`;

      // Remove button
      item.querySelector('.queue-item-remove').addEventListener('click', e => {
        e.stopPropagation();
        _items.splice(parseInt(e.currentTarget.dataset.idx), 1);
        _render();
      });

      // Click to play immediately
      item.addEventListener('click', e => {
        if (e.target.closest('.queue-item-remove')) return;
        const idx = parseInt(item.dataset.idx);
        const clicked = _items[idx];
        _items.splice(0, idx + 1);
        _render();
        if (typeof loadTrack === 'function' && typeof S !== 'undefined') {
          let pIdx = S.playlist.findIndex(t => t.path && t.path === clicked.path);
          if (pIdx < 0) {
            S.playlist.splice(S.currentIndex + 1, 0, clicked);
            pIdx = S.currentIndex + 1;
          }
          loadTrack(pIdx, true);
        }
      });

      // Drag to reorder
      let _dragIdx = -1;
      item.addEventListener('dragstart', e => {
        _dragIdx = i;
        item.classList.add('queue-item-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('queue-item-dragging');
        list.querySelectorAll('.queue-item').forEach(el =>
          el.classList.remove('queue-drop-above', 'queue-drop-below'));
      });
      item.addEventListener('dragover', e => {
        e.preventDefault();
        if (_dragIdx === i) return;
        const after = e.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
        item.classList.toggle('queue-drop-above', !after);
        item.classList.toggle('queue-drop-below', after);
      });
      item.addEventListener('dragleave', () =>
        item.classList.remove('queue-drop-above', 'queue-drop-below'));
      item.addEventListener('drop', e => {
        e.preventDefault();
        if (_dragIdx < 0 || _dragIdx === i) return;
        const after = e.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
        const [moved] = _items.splice(_dragIdx, 1);
        let insertAt = _dragIdx < i ? (after ? i : i - 1) : (after ? i + 1 : i);
        _items.splice(Math.max(0, insertAt), 0, moved);
        _dragIdx = -1;
        _render();
      });

      frag.appendChild(item);
    });

    list.replaceChildren(frag);
  }

  // ─── Badge flash ─────────────────────────────────────────────
  function _flashBadge() {
    const badge = $('queue-badge');
    if (!badge) return;
    badge.classList.remove('queue-badge-flash');
    void badge.offsetWidth;
    badge.classList.add('queue-badge-flash');
    setTimeout(() => badge.classList.remove('queue-badge-flash'), 600);
  }

  // ─── Public API ──────────────────────────────────────────────
  function add(tracks) {
    const arr = Array.isArray(tracks) ? tracks : [tracks];
    _items.push(...arr.map(t => ({ ...t })));
    _render(); _flashBadge();
  }

  function addPlayNext(tracks) {
    const arr = Array.isArray(tracks) ? tracks : [tracks];
    _items.unshift(...arr.map(t => ({ ...t })));
    _render(); _flashBadge();
  }

  function shift() {
    if (!_items.length) return null;
    const track = _items.shift();
    _render();
    return track;
  }

  function peek() { return _items[0] || null; }

  function clear() { _items = []; _render(); }

  // ─── Panel open/close ────────────────────────────────────────
  function openPanel() {
    const overlay = $('queue-panel-overlay');
    if (!overlay) return;
    _panelOpen = true;
    overlay.classList.add('active');
    // Force btn active state
    const btn = $('btn-up-next');
    if (btn) btn.classList.add('active');
    _render();
  }

  function closePanel() {
    const overlay = $('queue-panel-overlay');
    if (!overlay) return;
    _panelOpen = false;
    overlay.classList.remove('active');
    const btn = $('btn-up-next');
    if (btn) btn.classList.remove('active');
  }

  function togglePanel() {
    _panelOpen ? closePanel() : openPanel();
  }

  // ─── Wire events (deferred so DOM is guaranteed ready) ───────
  function _init() {
    const btnOpen  = $('btn-up-next');
    const closeBtn = $('queue-close-btn');
    const clearBtn = $('queue-clear-btn');
    const overlay  = $('queue-panel-overlay');

    if (btnOpen)  btnOpen.addEventListener('click', togglePanel);
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    if (clearBtn) clearBtn.addEventListener('click', clear);

    if (overlay) {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) closePanel();
      });
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && _panelOpen) closePanel();
    });

    // Ensure btn-up-next is visible regardless of settings state
    if (btnOpen) btnOpen.style.removeProperty('display');

    _updateBadge();
  }

  // Defer init until DOM is fully ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  return {
    add, addPlayNext, shift, peek, clear,
    get length() { return _items.length; },
    openPanel, closePanel, togglePanel,
  };

})();

window.Queue = Queue;
