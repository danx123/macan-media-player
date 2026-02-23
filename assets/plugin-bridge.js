// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — PLUGIN BRIDGE ADAPTER  (Patch 12)
//
// Architecture:
//   Plugin → MacanBridge.api  → safe whitelisted JS state
//   Plugin → MacanBridge.py() → generic Python route via
//            pywebview.api.plugin_request(id, action, payload)
//
// A plugin is a single self-contained JS file that calls
// MacanBridge.register(descriptor) once at load time.
//
// script.js emits hooks via MacanBridge.emit() at strategic
// points. Plugins subscribe with MacanBridge.on().
//
// New plugins only require:
//   1. Add the .js file to assets/plugins/
//   2. Add one line to plugins.config.js
//   No other file needs to be touched.
// ═══════════════════════════════════════════════════════════════

const MacanBridge = (() => {

  // ── Internal registry ──────────────────────────────────────
  const _plugins     = new Map();   // id → descriptor
  const _listeners   = new Map();   // event → [handler, ...]
  const _menuItems   = [];          // pending menu registrations
  let   _menuReady   = false;       // true once nav-menu list exists
  let   _styleSheet  = null;        // shared <style> for bridge base CSS

  // ── Hook event names (emitted by script.js) ────────────────
  // 'track:load'    payload: track object (name, artist, path, …)
  // 'player:play'   payload: { track, currentTime }
  // 'player:pause'  payload: { track, currentTime }
  // 'player:seek'   payload: { currentTime, duration, percent }
  // 'player:end'    payload: { track }
  // 'art:load'      payload: { src, track }
  // 'art:clear'     payload: null
  // 'queue:clear'   payload: null
  // 'queue:add'     payload: { tracks[] }

  // ══════════════════════════════════════════════════════════
  // PUBLIC — Plugin registration
  // ══════════════════════════════════════════════════════════

  /**
   * Register a plugin with the bridge.
   *
   * descriptor = {
   *   id:       string            required — unique kebab-case identifier
   *   name:     string            required — display name
   *   version:  string            optional — semver string, default '1.0.0'
   *   on:       { [event]: fn }   optional — hook subscriptions
   *   menu:     {                 optional — nav menu item
   *     label:  string
   *     icon:   string (SVG)
   *     order:  number (higher = lower in list, default 500)
   *     action: fn
   *     danger: bool
   *   }
   *   styles:   string            optional — CSS to inject once
   *   init:     fn                optional — called once after registration
   * }
   */
  function register(descriptor) {
    const { id } = descriptor;
    if (!id) { console.warn('[Bridge] Plugin must have an id'); return; }
    if (_plugins.has(id)) {
      console.warn(`[Bridge] Plugin "${id}" already registered — skipping`);
      return;
    }

    _plugins.set(id, descriptor);
    console.log(`[Bridge] Plugin registered: "${id}" v${descriptor.version || '1.0.0'}`);

    // Subscribe declared hook handlers
    if (descriptor.on && typeof descriptor.on === 'object') {
      Object.entries(descriptor.on).forEach(([event, handler]) => {
        on(event, handler, id);
      });
    }

    // Inject plugin CSS once
    if (descriptor.styles) {
      _injectStyle(descriptor.styles, id);
    }

    // Queue nav menu item
    if (descriptor.menu) {
      _registerMenuItem({ ...descriptor.menu, _pluginId: id });
    }

    // Run plugin init hook
    if (typeof descriptor.init === 'function') {
      try {
        descriptor.init();
      } catch (e) {
        console.error(`[Bridge] Plugin "${id}" init() threw:`, e);
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC — Event bus
  // ══════════════════════════════════════════════════════════

  /** Subscribe to a bridge event. Returns an unsubscribe function. */
  function on(event, handler, _sourceId) {
    if (!_listeners.has(event)) _listeners.set(event, []);
    const entry = { handler, id: _sourceId || '?' };
    _listeners.get(event).push(entry);
    return () => {
      const arr = _listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(entry);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }

  /**
   * Emit a hook event — called by script.js at strategic points.
   * Plugins should never need to call this directly.
   */
  function emit(event, payload) {
    const handlers = _listeners.get(event);
    if (!handlers || handlers.length === 0) return;
    handlers.forEach(({ handler, id }) => {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[Bridge] Plugin "${id}" handler for "${event}" threw:`, e);
      }
    });
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC — Python bridge (generic route)
  // ══════════════════════════════════════════════════════════

  /**
   * Call a Python-side handler registered via
   * MacanMediaAPI.register_plugin_handler(plugin_id, action, fn).
   *
   * Returns a Promise that resolves with the Python return value.
   *
   * Usage inside a plugin:
   *   const result = await MacanBridge.py('my-plugin', 'fetch_data', { key: 'val' });
   */
  async function py(pluginId, action, payload = {}) {
    if (typeof pywebview === 'undefined') {
      console.warn('[Bridge] pywebview not available — py() call skipped');
      return null;
    }
    try {
      return await pywebview.api.plugin_request(pluginId, action, payload);
    } catch (e) {
      console.error(`[Bridge] py("${pluginId}", "${action}") failed:`, e);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC — Safe read API (whitelisted JS state access)
  // ══════════════════════════════════════════════════════════
  // Plugins must use these instead of accessing S.* directly.
  // This isolates plugins from internal state structure changes.

  const api = {
    // ── Playback state ─────────────────────────────────────
    getCurrentTrack() {
      if (typeof S === 'undefined') return null;
      return S.playlist[S.currentIndex] || null;
    },
    getPlaylist() {
      if (typeof S === 'undefined') return [];
      return [...S.playlist];
    },
    getCurrentTime() {
      try { return (typeof activePlayer === 'function') ? activePlayer().currentTime : 0; }
      catch { return 0; }
    },
    getDuration() {
      return (typeof S !== 'undefined') ? S.duration : 0;
    },
    isPlaying() {
      return (typeof S !== 'undefined') ? !!S.isPlaying : false;
    },
    isShuffle() {
      return (typeof S !== 'undefined') ? !!S.isShuffle : false;
    },
    getRepeatMode() {
      return (typeof S !== 'undefined') ? S.repeatMode : 'none';
    },
    getVolume() {
      const sl = document.getElementById('volume-slider');
      return sl ? parseFloat(sl.value) : 1;
    },

    // ── Python read methods (safe subset) ──────────────────
    async getCoverArt(path) {
      if (typeof pywebview === 'undefined') return null;
      try { return await pywebview.api.get_cover_art(path); }
      catch { return null; }
    },
    async getPlaylistRegistry() {
      if (typeof pywebview === 'undefined') return {};
      try { return await pywebview.api.get_playlist_registry(); }
      catch { return {}; }
    },
    async getSettings() {
      if (typeof pywebview === 'undefined') return {};
      try { return await pywebview.api.get_settings(); }
      catch { return {}; }
    },

    // ── UI utilities ───────────────────────────────────────
    setStatus(message) {
      if (typeof setStatus === 'function') setStatus(message);
    },
    showToast(message, duration = 3000) {
      _toast(message, duration);
    },
    formatTime(seconds) {
      if (typeof formatTime === 'function') return formatTime(seconds);
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    },

    // ── Overlay factory ────────────────────────────────────
    /**
     * Create a modal overlay element for a plugin.
     * Returns the overlay div (already appended to body).
     * The overlay is hidden by default; add class 'active' to show.
     *
     * Auto-closes on backdrop click and Escape key.
     * Applies the standard Macan overlay dark backdrop style.
     */
    createOverlay(pluginId, options = {}) {
      return _createOverlay(pluginId, options);
    },

    // ── Nav menu ───────────────────────────────────────────
    /**
     * Add an item to the navigation menu.
     * Can be called at any time — deferred if menu not yet ready.
     */
    registerMenuItem(item) {
      _registerMenuItem({ ...item });
    },
  };

  // ══════════════════════════════════════════════════════════
  // PRIVATE — Overlay factory
  // ══════════════════════════════════════════════════════════

  function _createOverlay(pluginId, options = {}) {
    const existing = document.getElementById(`plg-${pluginId}-overlay`);
    if (existing) return existing;

    const overlay = document.createElement('div');
    overlay.id        = `plg-${pluginId}-overlay`;
    overlay.className = 'plg-overlay';
    overlay.setAttribute('data-plugin', pluginId);

    const panel = document.createElement('div');
    panel.className = `plg-panel plg-${pluginId}-panel`;

    if (options.html) panel.innerHTML = options.html;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Backdrop click → close
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('active');
    });

    // Escape key → close
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.classList.contains('active')) {
        overlay.classList.remove('active');
      }
    });

    return overlay;
  }

  // ══════════════════════════════════════════════════════════
  // PRIVATE — Nav menu injection
  // ══════════════════════════════════════════════════════════

  function _registerMenuItem(item) {
    _menuItems.push(item);
    _menuItems.sort((a, b) => (a.order || 500) - (b.order || 500));
    if (_menuReady) _flushMenuItems();
  }

  function _flushMenuItems() {
    const list = document.getElementById('nav-menu-list');
    if (!list) return;

    // Find the EXIT separator to insert plugin items before it
    const separator = list.querySelector('.nm-separator');

    _menuItems.forEach(item => {
      const existingEl = document.getElementById(`plg-nm-${item._pluginId || item.id}`);
      if (existingEl) return; // already injected

      const el = document.createElement('button');
      el.className  = 'nm-item' + (item.danger ? ' nm-item-danger' : '') + ' nm-item-plugin';
      el.id         = `plg-nm-${item._pluginId || item.id}`;
      el.innerHTML  =
        '<span class="nm-item-icon">' + (item.icon || _defaultIcon()) + '</span>' +
        '<span class="nm-item-label">' + (item.label || 'Plugin') + '</span>' +
        '<span class="nm-item-plugin-badge">PLUGIN</span>' +
        '<svg class="nm-item-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';

      el.addEventListener('click', () => {
        // Close nav menu first (access NavMenu close if available)
        document.getElementById('nav-menu-overlay')?.click();
        setTimeout(() => {
          try { if (typeof item.action === 'function') item.action(); }
          catch (e) { console.error('[Bridge] Menu action error:', e); }
        }, 80);
      });

      // Insert before the EXIT separator, or append at end
      if (separator) list.insertBefore(el, separator);
      else list.appendChild(el);
    });
  }

  function _defaultIcon() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" ' +
      'height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>';
  }

  // ══════════════════════════════════════════════════════════
  // PRIVATE — Style injection
  // ══════════════════════════════════════════════════════════

  function _injectStyle(css, pluginId) {
    const tag = document.createElement('style');
    tag.setAttribute('data-plugin', pluginId);
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function _ensureBridgeStyles() {
    if (_styleSheet) return;
    _styleSheet = document.createElement('style');
    _styleSheet.id = 'macan-bridge-styles';
    _styleSheet.textContent = `
      /* ── Plugin Bridge Base Styles ── */
      .plg-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.65);
        z-index: 950;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s;
        backdrop-filter: blur(6px);
      }
      .plg-overlay.active {
        opacity: 1;
        pointer-events: all;
      }
      .plg-panel {
        background: #0c0c0c;
        border: 1px solid rgba(232,255,0,0.15);
        border-radius: 10px;
        min-width: 340px;
        max-width: 92vw;
        max-height: 88vh;
        overflow-y: auto;
        box-shadow: 0 24px 80px rgba(0,0,0,0.8);
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.08) transparent;
      }
      /* Plugin badge in nav menu */
      .nm-item-plugin-badge {
        font-family: 'Space Mono', monospace;
        font-size: 0.45rem;
        font-weight: 700;
        letter-spacing: 1px;
        color: rgba(232,255,0,0.5);
        border: 1px solid rgba(232,255,0,0.2);
        border-radius: 3px;
        padding: 1px 4px;
        margin-right: 4px;
        flex-shrink: 0;
      }
      /* Bridge toast */
      #macan-bridge-toast {
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%) translateY(12px);
        background: rgba(20,20,20,0.95);
        border: 1px solid rgba(232,255,0,0.2);
        color: rgba(255,255,255,0.85);
        font-family: 'Space Mono', monospace;
        font-size: 0.65rem;
        letter-spacing: 1px;
        padding: 8px 18px;
        border-radius: 6px;
        z-index: 9999;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s, transform 0.2s;
        white-space: nowrap;
      }
      #macan-bridge-toast.show {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    `;
    document.head.appendChild(_styleSheet);
  }

  // ══════════════════════════════════════════════════════════
  // PRIVATE — Toast notification
  // ══════════════════════════════════════════════════════════

  let _toastTimer = null;
  function _toast(message, duration = 3000) {
    let el = document.getElementById('macan-bridge-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'macan-bridge-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    clearTimeout(_toastTimer);
    // Force reflow so transition re-triggers on repeat calls
    el.classList.remove('show');
    requestAnimationFrame(() => {
      el.classList.add('show');
      _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
    });
  }

  // ══════════════════════════════════════════════════════════
  // PRIVATE — Wait for nav menu list to be ready
  // ══════════════════════════════════════════════════════════

  function _waitForMenu() {
    const list = document.getElementById('nav-menu-list');
    if (list) {
      _menuReady = true;
      if (_menuItems.length) _flushMenuItems();
      return;
    }
    // Observe DOM until nav-menu-list appears (nav-menu.js builds it at init)
    const obs = new MutationObserver(() => {
      if (document.getElementById('nav-menu-list')) {
        obs.disconnect();
        _menuReady = true;
        if (_menuItems.length) _flushMenuItems();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ══════════════════════════════════════════════════════════
  // PRIVATE — Debug helper (dev only)
  // ══════════════════════════════════════════════════════════

  function _listPlugins() {
    console.table(
      Array.from(_plugins.entries()).map(([id, d]) => ({
        id, name: d.name || id, version: d.version || '1.0.0',
        hooks: Object.keys(d.on || {}).join(', ') || '—',
        menu: !!d.menu,
      }))
    );
  }

  // ══════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════

  _ensureBridgeStyles();
  _waitForMenu();

  console.log('[MacanBridge] Plugin Bridge Adapter ready');

  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════
  return {
    register,
    on,
    emit,
    py,
    api,
    // Dev helpers
    _listPlugins,
    _toast,
  };

})();

window.MacanBridge = MacanBridge;
