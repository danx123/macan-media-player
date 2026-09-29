// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — PLUGIN: FULLSCREEN PLAYER (Focus Mode)
//
// Blows up #now-playing-panel (art, title, seekbar, controls, volume)
// into a two-column "Now Playing" screen — big art on one side, a
// stacked info/controls column on the other — hides the playlist,
// and lets the app's own album-art ambient glow (#art-blur-bg) show
// through behind it.
//
// Implementation note #1: instead of rebuilding the player's controls
// from scratch (which would mean re-wiring play/pause/seek/shuffle/
// repeat and re-syncing every bit of state by hand), this plugin
// simply REPARENTS the real #now-playing-panel DOM node into a
// fullscreen overlay and back. Because it's the same node — not a
// clone — every existing event listener, id-based lookup and bridge
// hook (track:load, art:load, player:play/pause, player:seek) keeps
// working exactly as before with zero duplicated logic.
//
// Implementation note #2: the two-column layout is done with CSS
// Grid, explicitly placing each existing child (art-frame, track-info,
// controls, progress-container, mini-vis, extra-controls) into a
// column/row — no wrapper divs, no DOM restructuring, so nothing about
// how those elements are found or listened to changes. Every size is
// vw/vh/clamp()-based so it's genuinely fluid — it re-flows on its own
// as the window resizes, no JS measuring or scaling required. A
// narrow/portrait media query falls back to a single stacked column.
//
// Implementation note #3: this is meant to be a *true* fullscreen —
// #top-bar (the MACAN logo/menu/clock header) is actually hidden
// while active (not just covered), and the overlay sits at a plain
// `inset: 0` like a real fullscreen surface. The header's original
// inline display value is restored on close.
//
// Implementation note #4: #mini-canvas (the waveform) has a hardcoded
// 320×44 backing bitmap in the HTML that script.js never resizes. If
// we display it much bigger without touching that, it'll look blurry/
// pixelated. syncMiniCanvasResolution() fixes this by bumping the
// canvas's actual width/height attributes (in device pixels) to match
// its real rendered size whenever fullscreen opens or the window
// resizes, and restores the original attributes on close.
//
// Implementation note #5: cursor auto-hide. After IDLE_HIDE_MS without
// real mouse movement the overlay gets `.plgfs-cursor-hidden`
// (cursor: none on everything inside it, and the close button fades
// out too); any movement brings both back.
// Movement is compared against the last position so the phantom
// mousemove events some webviews fire when the cursor is hidden don't
// instantly un-hide it.
//
// Implementation note #6: edge-reveal playlist. Same reparenting trick
// as the player panel — the real #playlist-panel node is moved into a
// fixed left-side drawer (#plgfs-drawer) that slides in when the
// pointer touches the left screen edge (EDGE_TRIGGER_PX) and slides
// out once the pointer moves away from it. It's the same node, so
// track clicks, search filter, drag-reorder etc. all keep working.
// ═══════════════════════════════════════════════════════════════

(() => {
  const PLUGIN_ID = 'fullscreen-player';

  let overlayEl      = null;
  let closeBtn       = null;
  let toggleBtn      = null;
  let npp            = null; // #now-playing-panel node
  let nppParent      = null; // its original parent (#main-layout)
  let nppNextSibling = null; // its original position marker
  let active         = false;

  let miniCanvasOrigW = null;
  let miniCanvasOrigH = null;

  let topBarEl        = null;
  let topBarOrigDisplay = '';

  // Cursor auto-hide + playlist edge drawer
  const IDLE_HIDE_MS     = 2500; // idle time before the cursor hides
  const EDGE_TRIGGER_PX  = 6;    // distance from left edge that reveals the playlist
  const DRAWER_LEAVE_PAD = 48;   // how far past the drawer the pointer must go to close it

  let drawerEl        = null;
  let plPanel         = null; // #playlist-panel node
  let plParent        = null;
  let plNextSibling   = null;
  let drawerOpen      = false;
  let idleTimer       = null;
  let lastMouseX      = -1;
  let lastMouseY      = -1;

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
      z-index: 900;
      display: none;
      align-items: center;
      justify-content: center;
      /* Darker on the right (behind text/controls, for legibility),
         lighter/more transparent toward the left (behind the art) so
         the app's existing #art-blur-bg ambient glow reads through
         instead of getting smothered by a flat black backdrop. */
      background: radial-gradient(ellipse 75% 100% at 24% 50%,
        rgba(0,0,0,0.18) 0%,
        rgba(0,0,0,0.58) 48%,
        rgba(0,0,0,0.92) 82%);
      opacity: 0;
      transition: opacity 0.3s ease;
      overflow: hidden;
    }
    #plgfs-overlay.plgfs-active {
      display: flex;
      opacity: 1;
    }

    /* #now-playing-panel, reparented in here, loses the sidebar "card"
       look (no background/border/blur/radius/shadow) and becomes a
       two-column CSS Grid: art on the left, everything else stacked
       in a column on the right. Every existing child keeps its own
       id/listeners — only *where* it sits changes. The selector only
       applies while the panel is actually inside the overlay, so its
       normal in-layout sidebar appearance is untouched. */
    #plgfs-overlay #now-playing-panel {
      border-right: none !important;
      width: 100%;
      height: 100%;
      max-width: none;
      max-height: none;
      background: transparent;
      backdrop-filter: none;
      border: none;
      border-radius: 0;
      box-shadow: none;
      display: grid;
      grid-template-columns: minmax(0, 1fr) min(460px, 42vw);
      grid-template-rows: auto auto auto 1fr auto;
      align-items: center;
      column-gap: clamp(32px, 5vw, 96px);
      row-gap: clamp(14px, 2vh, 26px);
      padding: clamp(28px, 5vh, 64px) clamp(28px, 5vw, 80px);
    }

    #plgfs-overlay #art-frame {
      grid-column: 1;
      grid-row: 1 / 6;
      justify-self: center;
      align-self: center;
      width: min(64vh, 46vw, 620px);
      height: min(64vh, 46vw, 620px);
    }

    #plgfs-overlay #track-info    { grid-column: 2; grid-row: 1; width: 100%; text-align: center; }
    #plgfs-overlay #controls      { grid-column: 2; grid-row: 2; width: 100%; justify-content: center; gap: clamp(10px, 1vw, 18px); }
    #plgfs-overlay #progress-container { grid-column: 2; grid-row: 3; width: 100%; }
    #plgfs-overlay #mini-vis      { grid-column: 2; grid-row: 4; width: 100%; height: 100%; min-height: 64px; align-self: stretch; }
    #plgfs-overlay #extra-controls { grid-column: 2; grid-row: 5; width: 100%; }

    /* Declutter for focus mode — Add Files / Add Folder / Clear / the
       Fullscreen toggle itself aren't needed once you're already in
       here; Esc or the close button handles exiting. */
    #plgfs-overlay #action-row { display: none; }

    #plgfs-overlay #track-title    { font-size: clamp(2.2rem, 3.4vw, 3.6rem); }
    #plgfs-overlay #track-artist   { font-size: clamp(0.75rem, 1vw, 0.95rem); margin-top: 10px; }
    #plgfs-overlay #track-meta-row { justify-content: center; margin-top: 14px; }
    #plgfs-overlay .meta-badge     { font-size: clamp(0.6rem, 0.85vw, 0.75rem); padding: 5px 12px; }

    #plgfs-overlay .ctrl-btn.ctrl-secondary { width: clamp(42px, 2.6vw, 52px); height: clamp(42px, 2.6vw, 52px); }
    #plgfs-overlay .ctrl-btn.ctrl-primary   { width: clamp(58px, 3.8vw, 74px); height: clamp(58px, 3.8vw, 74px); }

    #plgfs-overlay #progress-container span { font-size: clamp(0.6rem, 0.75vw, 0.75rem); }

    /* Narrow / portrait windows: fall back to a single stacked column
       (art on top, everything else below) instead of squeezing two
       columns into too little width. */
    @media (max-width: 820px), (max-aspect-ratio: 4/5) {
      #plgfs-overlay #now-playing-panel {
        grid-template-columns: 1fr;
        grid-template-rows: auto auto auto auto 1fr auto;
        justify-items: center;
      }
      #plgfs-overlay #art-frame {
        grid-column: 1; grid-row: 1;
        width: min(50vh, 68vw, 380px);
        height: min(50vh, 68vw, 380px);
      }
      #plgfs-overlay #track-info      { grid-row: 2; text-align: center; }
      #plgfs-overlay #track-meta-row  { justify-content: center; }
      #plgfs-overlay #controls        { grid-row: 3; justify-content: center; }
      #plgfs-overlay #progress-container { grid-row: 4; }
      #plgfs-overlay #mini-vis        { grid-row: 5; height: auto; min-height: 56px; align-self: unset; }
      #plgfs-overlay #extra-controls  { grid-row: 6; }
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
      transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.15s, opacity 0.35s ease;
    }
    #plgfs-close-btn:hover {
      color: var(--accent, #E8FF00);
      border-color: rgba(232,255,0,0.4);
      background: rgba(28,28,28,0.9);
      transform: scale(1.06);
    }
    #plgfs-close-btn.plgfs-visible { display: flex; }

    /* ── Cursor auto-hide ─────────────────────────────────────
       Some children set their own cursor (buttons, seekbar...), so
       the rule has to hit every descendant with !important. */
    #plgfs-overlay.plgfs-cursor-hidden,
    #plgfs-overlay.plgfs-cursor-hidden *,
    #plgfs-close-btn.plgfs-cursor-hidden {
      cursor: none !important;
    }

    /* Close button fades out together with the cursor while idle and
       comes back on the next mouse movement. pointer-events:none keeps
       an invisible button from catching stray clicks; Esc still exits. */
    #plgfs-close-btn.plgfs-cursor-hidden {
      opacity: 0;
      pointer-events: none;
    }

    /* ── Playlist drawer (slides in from the left edge) ──────── */
    #plgfs-drawer {
      position: fixed;
      top: 0; bottom: 0; left: 0;
      width: min(440px, 90vw);
      z-index: 902;
      display: none;
      transform: translateX(-102%);
      transition: transform 0.28s cubic-bezier(0.22, 0.8, 0.3, 1),
                  box-shadow 0.28s ease;
      box-shadow: none;
    }
    #plgfs-drawer.plgfs-drawer-mounted { display: block; }
    #plgfs-drawer.plgfs-drawer-open {
      transform: translateX(0);
      box-shadow: 12px 0 48px rgba(0,0,0,0.6);
    }
    #plgfs-drawer #playlist-panel {
      width: 100%;
      height: 100%;
      background: rgba(8,8,8,0.9);
      border-right: 1px solid rgba(255,255,255,0.08);
    }

    /* Drawer is just for picking a track — hide the header (QUEUE title,
       tool buttons row, filter box). The header stays in the DOM, so
       its buttons/listeners are untouched and it's back on close. */
    #plgfs-drawer .pl-header-right { display: none; }

    #plgfs-toggle-btn.plgfs-on {
      color: var(--accent, #E8FF00);
      border-color: rgba(232,255,0,0.35);
    }
  `;

  // ── Waveform canvas resolution sync ─────────────────────────
  // Draw code in script.js reads miniCanvas.width/height directly as
  // its pixel-space coordinate system every animation frame, so
  // bumping these attributes here is picked up automatically on the
  // very next frame — no redraw call needed.
  function syncMiniCanvasResolution() {
    const canvas = document.getElementById('mini-canvas');
    if (!canvas) return;

    if (miniCanvasOrigW === null) {
      miniCanvasOrigW = canvas.width;
      miniCanvasOrigH = canvas.height;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));

    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  function restoreMiniCanvasResolution() {
    if (miniCanvasOrigW === null) return;
    const canvas = document.getElementById('mini-canvas');
    if (canvas) {
      canvas.width = miniCanvasOrigW;
      canvas.height = miniCanvasOrigH;
    }
    miniCanvasOrigW = null;
    miniCanvasOrigH = null;
  }

  let resizeRAF = null;
  function onWindowResize() {
    if (!active) return;
    if (resizeRAF) cancelAnimationFrame(resizeRAF);
    resizeRAF = requestAnimationFrame(syncMiniCanvasResolution);
  }

  // ── Cursor auto-hide ────────────────────────────────────────
  function setCursorHidden(hidden) {
    if (!overlayEl) return;
    overlayEl.classList.toggle('plgfs-cursor-hidden', hidden);
    if (closeBtn) closeBtn.classList.toggle('plgfs-cursor-hidden', hidden);
  }

  function scheduleCursorHide() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!active) return;
      // Keep the cursor while the playlist is open (user is browsing it).
      if (drawerOpen) { scheduleCursorHide(); return; }
      setCursorHidden(true);
    }, IDLE_HIDE_MS);
  }

  // ── Playlist drawer ─────────────────────────────────────────
  function mountPlaylist() {
    plPanel = document.getElementById('playlist-panel');
    if (!plPanel) return;

    if (!drawerEl) {
      drawerEl = document.createElement('div');
      drawerEl.id = 'plgfs-drawer';
      document.body.appendChild(drawerEl);
    }

    plParent      = plPanel.parentNode;
    plNextSibling = plPanel.nextSibling;

    plPanel.style.display = '';
    drawerEl.appendChild(plPanel);
    drawerEl.classList.add('plgfs-drawer-mounted');
  }

  function unmountPlaylist() {
    closeDrawer(true);
    if (drawerEl) drawerEl.classList.remove('plgfs-drawer-mounted');

    if (plPanel && plParent) {
      if (plNextSibling && plNextSibling.parentNode === plParent) {
        plParent.insertBefore(plPanel, plNextSibling);
      } else {
        plParent.appendChild(plPanel);
      }
    }
    plPanel = plParent = plNextSibling = null;
  }

  function openDrawer() {
    if (drawerOpen || !drawerEl || !plPanel) return;
    drawerOpen = true;
    drawerEl.classList.add('plgfs-drawer-open');
    setCursorHidden(false);
  }

  function closeDrawer(immediate) {
    if (!drawerOpen) return;
    drawerOpen = false;
    if (drawerEl) drawerEl.classList.remove('plgfs-drawer-open');
    if (!immediate) scheduleCursorHide();
  }

  // ── Global mouse handling (only acts while fullscreen is active) ──
  function onMouseMove(e) {
    if (!active) return;

    // Ignore phantom events with no real movement.
    if (e.clientX === lastMouseX && e.clientY === lastMouseY) return;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    setCursorHidden(false);

    if (e.clientX <= EDGE_TRIGGER_PX) {
      openDrawer();
    } else if (drawerOpen && drawerEl) {
      const drawerRight = drawerEl.getBoundingClientRect().right;
      const ae = document.activeElement;
      const busy =
        e.buttons !== 0 ||                                     // mid-drag (reorder, etc.)
        (ae && drawerEl.contains(ae) && ae.tagName === 'INPUT'); // typing in the filter box
      if (!busy && e.clientX > drawerRight + DRAWER_LEAVE_PAD) closeDrawer();
    }

    scheduleCursorHide();
  }

  // Pointer left the window through the left edge — treat as an edge hit.
  function onMouseLeave(e) {
    if (!active) return;
    if (e.clientX <= EDGE_TRIGGER_PX) openDrawer();
  }

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

    window.addEventListener('resize', onWindowResize);
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    document.documentElement.addEventListener('mouseleave', onMouseLeave);
  }

  // ── Open / close ────────────────────────────────────────────
  function open() {
    if (active) return;
    npp = document.getElementById('now-playing-panel');
    if (!npp) return;

    ensureOverlay();

    nppParent      = npp.parentNode;
    nppNextSibling = npp.nextSibling;

    overlayEl.appendChild(npp);
    overlayEl.classList.add('plgfs-active');
    closeBtn.classList.add('plgfs-visible');

    // Playlist starts hidden in a left-edge drawer; it slides in when
    // the pointer touches the left edge of the screen.
    mountPlaylist();

    // True fullscreen — hide the header too, not just cover it.
    topBarEl = document.getElementById('top-bar');
    if (topBarEl) {
      topBarOrigDisplay = topBarEl.style.display;
      topBarEl.style.display = 'none';
    }

    active = true;
    lastMouseX = lastMouseY = -1;
    scheduleCursorHide();
    if (toggleBtn) toggleBtn.classList.add('plgfs-on');
    MacanBridge.api.showToast('FULLSCREEN PLAYER — Esc to exit · Move the mouse to the left edge = playlist');

    // Wait a frame so the grid layout has actually settled into its
    // new (much bigger) size before measuring the waveform canvas.
    requestAnimationFrame(syncMiniCanvasResolution);
  }

  function close() {
    if (!active || !npp) return;

    restoreMiniCanvasResolution();

    clearTimeout(idleTimer);
    setCursorHidden(false);

    // Playlist goes back first so the now-playing panel's recorded
    // sibling position is valid again when it's re-inserted below.
    unmountPlaylist();

    // Put the panel back exactly where it came from.
    if (nppNextSibling) nppParent.insertBefore(npp, nppNextSibling);
    else nppParent.appendChild(npp);

    overlayEl.classList.remove('plgfs-active');
    closeBtn.classList.remove('plgfs-visible');

    if (topBarEl) {
      topBarEl.style.display = topBarOrigDisplay;
      topBarEl = null;
    }

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
    version: '1.1.0',
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
