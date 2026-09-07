// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — PLUGIN: FULLSCREEN PLAYER (Focus Mode)
//
// Blows up #now-playing-panel (art, title, seekbar, controls, volume,
// add-files row) to fill the whole window, hides the playlist, and
// gives it a dark ambient backdrop — no queue, just the player.
//
// Implementation note: instead of rebuilding the player's controls
// from scratch (which would mean re-wiring play/pause/seek/shuffle/
// repeat and re-syncing every bit of state by hand), this plugin
// simply REPARENTS the real #now-playing-panel DOM node into a
// fullscreen overlay and back. Because it's the same node — not a
// clone — every existing event listener, id-based lookup and bridge
// hook (track:load, art:load, player:play/pause, player:seek) keeps
// working exactly as before with zero duplicated logic.
// ═══════════════════════════════════════════════════════════════

(() => {
  const PLUGIN_ID = 'fullscreen-player';

  let overlayEl      = null;
  let closeBtn        = null;
  let toggleBtn       = null;
  let npp              = null; // #now-playing-panel node
  let nppParent        = null; // its original parent (#main-layout)
  let nppNextSibling   = null; // its original position marker
  let active           = false;

  const ICON_EXPAND =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';

  const ICON_CLOSE =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  const STYLES = `
    #plgfs-overlay {
      position: fixed;
      inset: 0;
      z-index: 900; /* above #top-bar (100) and #main-layout (10) */
      display: none;
      align-items: center;
      justify-content: center;
      background: radial-gradient(ellipse at center, rgba(20,20,20,0.55) 0%, rgba(0,0,0,0.94) 72%);
      opacity: 0;
      transition: opacity 0.25s ease;
    }
    #plgfs-overlay.plgfs-active {
      display: flex;
      opacity: 1;
    }

    /* #now-playing-panel, reparented in here, gets a fullscreen-friendly
       reskin — the selector only applies while it's actually inside the
       overlay, so its normal in-layout appearance is untouched. */
    #plgfs-overlay #now-playing-panel {
      border-right: none !important;
      width: min(94vw, 460px);
      max-height: 90vh;
      border-radius: 18px;
      border: 1px solid rgba(232,255,0,0.12);
      box-shadow: 0 30px 100px rgba(0,0,0,0.75), 0 0 0 1px rgba(232,255,0,0.04);
      padding: 44px 36px 32px;
      gap: 24px;
    }
    #plgfs-overlay #art-frame {
      width: 260px;
      height: 260px;
    }

    #plgfs-close-btn {
      position: fixed;
      top: 20px; right: 24px;
      width: 38px; height: 38px;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(18,18,18,0.75);
      color: rgba(255,255,255,0.7);
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 901;
      backdrop-filter: blur(6px);
      transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.15s;
    }
    #plgfs-close-btn:hover {
      color: var(--accent, #E8FF00);
      border-color: rgba(232,255,0,0.4);
      background: rgba(28,28,28,0.9);
      transform: scale(1.06);
    }
    #plgfs-close-btn.plgfs-visible { display: flex; }

    #plgfs-toggle-btn.plgfs-on {
      color: var(--accent, #E8FF00);
      border-color: rgba(232,255,0,0.35);
    }

    @media (max-width: 640px) {
      #plgfs-overlay #now-playing-panel {
        width: 100vw;
        height: 100vh;
        max-height: 100vh;
        border-radius: 0;
        justify-content: center;
      }
      #plgfs-overlay #art-frame { width: 200px; height: 200px; }
    }
  `;

  // ── Overlay (created once, lazily) ─────────────────────────
  function ensureOverlay() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.id = 'plgfs-overlay';
    document.body.appendChild(overlayEl);

    // Click on the empty backdrop (not on the panel itself) exits,
    // same convention as MacanBridge.createOverlay().
    overlayEl.addEventListener('click', e => {
      if (e.target === overlayEl) close();
    });

    closeBtn = document.createElement('button');
    closeBtn.id = 'plgfs-close-btn';
    closeBtn.title = 'Exit fullscreen player (Esc)';
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.addEventListener('click', close);
    document.body.appendChild(closeBtn);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && active) close();
    });
  }

  // ── Open / close ────────────────────────────────────────────
  function open() {
    if (active) return;
    npp = document.getElementById('now-playing-panel');
    if (!npp) return;

    ensureOverlay();

    nppParent    = npp.parentNode;
    nppNextSibling = npp.nextSibling;

    overlayEl.appendChild(npp);
    overlayEl.classList.add('plgfs-active');
    closeBtn.classList.add('plgfs-visible');

    const playlistPanel = document.getElementById('playlist-panel');
    if (playlistPanel) playlistPanel.style.display = 'none';

    active = true;
    if (toggleBtn) toggleBtn.classList.add('plgfs-on');
    MacanBridge.api.showToast('FULLSCREEN PLAYER — Esc to exit');
  }

  function close() {
    if (!active || !npp) return;

    // Put the panel back exactly where it came from.
    if (nppNextSibling) nppParent.insertBefore(npp, nppNextSibling);
    else nppParent.appendChild(npp);

    overlayEl.classList.remove('plgfs-active');
    closeBtn.classList.remove('plgfs-visible');

    const playlistPanel = document.getElementById('playlist-panel');
    if (playlistPanel) playlistPanel.style.display = '';

    active = false;
    if (toggleBtn) toggleBtn.classList.remove('plgfs-on');
  }

  function toggle() {
    if (active) close(); else open();
  }

  // ── Toggle button injected next to ADD FILES / ADD FOLDER / CLEAR ──
  function injectToggleButton() {
    if (document.getElementById('plgfs-toggle-btn')) return;
    const actionRow = document.getElementById('action-row');
    if (!actionRow) return;

    toggleBtn = document.createElement('button');
    toggleBtn.className = 'action-btn';
    toggleBtn.id = 'plgfs-toggle-btn';
    toggleBtn.title = 'Fullscreen Player';
    toggleBtn.innerHTML = ICON_EXPAND + 'FULLSCREEN';
    toggleBtn.addEventListener('click', toggle);
    actionRow.appendChild(toggleBtn);
  }

  function waitForActionRow() {
    if (document.getElementById('action-row')) {
      injectToggleButton();
      return;
    }
    const obs = new MutationObserver(() => {
      if (document.getElementById('action-row')) {
        injectToggleButton();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── Register with the bridge ────────────────────────────────
  window.MacanBridge.register({
    id: PLUGIN_ID,
    name: 'Fullscreen Player',
    version: '1.0.0',
    styles: STYLES,
    menu: {
      label: 'FULLSCREEN PLAYER',
      order: 250,
      icon: ICON_EXPAND,
      action: () => toggle(),
    },
    init() {
      waitForActionRow();
    },
  });
})();
