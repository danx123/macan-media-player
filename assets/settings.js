// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — SETTINGS MODULE  (Patch 10)
//
// Features:
//   1. CUSTOMIZE BUTTONS — show/hide toolbar buttons individually
//   2. DYNAMIC AURA — extract dominant color from cover art and
//      apply it as the accent across: progress bar, volume slider,
//      visualizer colors, selected items, glow effects.
//      Falls back to default #E8FF00 when no art is present.
// ═══════════════════════════════════════════════════════════════

const Settings = (() => {
  const SK = 'macan_settings_v1';

  // Default settings object
  const DEFAULTS = {
    // Toolbar buttons visibility
    buttons: {
      'btn-equalizer':      true,
      'btn-playlist-manager': true,
      'btn-lyrics':         true,
      'btn-radio':          true,
      'btn-tv':             true,
      'btn-converter':      true,
      'btn-cache-manager':  true,
    },
    // Dynamic Aura
    dynamicAura: false,
  };

  // Button display labels for the settings UI
  const BUTTON_LABELS = {
    'btn-equalizer':       'Equalizer',
    'btn-playlist-manager':'Playlists',
    'btn-lyrics':          'Lyrics',
    'btn-radio':           'Radio Online',
    'btn-tv':              'TV Online',
    'btn-converter':       'Converter',
    'btn-cache-manager':   'Cache Manager',
  };

  let isOpen = false;
  let _current = {};  // live settings in memory
  let _auraCanvas = null; // offscreen canvas for color extraction

  // ── Storage ─────────────────────────────────────────────────
  function _load() {
    try {
      const saved = JSON.parse(localStorage.getItem(SK));
      return _deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), saved || {});
    } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  function _save(s) {
    try { localStorage.setItem(SK, JSON.stringify(s)); } catch {}
  }
  function _deepMerge(base, over) {
    if (!over || typeof over !== 'object') return base;
    Object.keys(over).forEach(k => {
      if (typeof over[k] === 'object' && !Array.isArray(over[k]) &&
          typeof base[k] === 'object') {
        _deepMerge(base[k], over[k]);
      } else {
        base[k] = over[k];
      }
    });
    return base;
  }

  // ── Apply button visibility ──────────────────────────────────
  function _applyButtons(buttons) {
    Object.entries(buttons).forEach(([id, visible]) => {
      const el = document.getElementById(id);
      if (!el) return;
      // Hide/show the button. Keep layout stable with visibility:hidden
      // so the toolbar doesn't jump; use display:none to actually remove space.
      el.style.display = visible ? '' : 'none';
    });
  }

  // ── Dynamic Aura ────────────────────────────────────────────
  // CSS custom properties used by the whole UI:
  //   --accent         → hex color  e.g. #E8FF00 or #4A90FF
  //   --accent-dim     → color + 18% alpha
  //   --accent-glow    → color + 28% alpha
  //   --accent-r/g/b   → individual channels for rgba() in JS canvas

  const ROOT = document.documentElement;
  const DEFAULT_ACCENT = { r: 232, g: 255, b: 0, hex: '#E8FF00' };
  let _auraColor = { ...DEFAULT_ACCENT };
  let _auraEnabled = false;

  function _hexFromRgb(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function _alphaHex(r, g, b, a) {
    // Returns css rgba() string
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function _applyCssAccent(r, g, b) {
    const hex  = _hexFromRgb(r, g, b);
    ROOT.style.setProperty('--accent',      hex);
    ROOT.style.setProperty('--accent-dim',  _alphaHex(r, g, b, 0.14));
    ROOT.style.setProperty('--accent-glow', _alphaHex(r, g, b, 0.28));
    _auraColor = { r, g, b, hex };
  }

  function _resetCssAccent() {
    const d = DEFAULT_ACCENT;
    ROOT.style.setProperty('--accent',      d.hex);
    ROOT.style.setProperty('--accent-dim',  'rgba(232,255,0,0.12)');
    ROOT.style.setProperty('--accent-glow', 'rgba(232,255,0,0.25)');
    _auraColor = { ...d };
  }

  // ── Color extraction from image ──────────────────────────────
  // Sample a grid of pixels, skip very dark/light/gray ones,
  // cluster nearby colors, return the most dominant vibrant cluster.
  function _extractDominant(imgEl, callback) {
    try {
      if (!_auraCanvas) {
        _auraCanvas = document.createElement('canvas');
        _auraCanvas.width = _auraCanvas.height = 64; // small for speed
      }
      const ctx = _auraCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(imgEl, 0, 0, 64, 64);
      const data = ctx.getImageData(0, 0, 64, 64).data;

      // Collect vibrant pixels (saturation > 0.25, brightness 0.2–0.85)
      const buckets = {};
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        if (a < 128) continue;

        const max = Math.max(r, g, b) / 255;
        const min = Math.min(r, g, b) / 255;
        const sat = max === 0 ? 0 : (max - min) / max;
        if (sat < 0.22 || max < 0.18 || max > 0.96) continue;

        // Quantize to reduce noise
        const qr = Math.round(r / 24) * 24;
        const qg = Math.round(g / 24) * 24;
        const qb = Math.round(b / 24) * 24;
        const key = qr + ',' + qg + ',' + qb;
        buckets[key] = (buckets[key] || 0) + 1;
      }

      // Find most frequent vibrant bucket
      let best = null, bestCount = 0;
      Object.entries(buckets).forEach(([key, count]) => {
        if (count > bestCount) { bestCount = count; best = key; }
      });

      if (best) {
        const [r, g, b] = best.split(',').map(Number);
        callback(r, g, b);
      } else {
        callback(DEFAULT_ACCENT.r, DEFAULT_ACCENT.g, DEFAULT_ACCENT.b);
      }
    } catch (e) {
      console.warn('[Aura] color extraction failed:', e);
      callback(DEFAULT_ACCENT.r, DEFAULT_ACCENT.g, DEFAULT_ACCENT.b);
    }
  }

  // Public: called from applyArt() in script.js when album art loads
  function onArtLoaded(imgEl) {
    if (!_auraEnabled) return;
    if (!imgEl || !imgEl.complete || imgEl.naturalWidth === 0) return;
    _extractDominant(imgEl, (r, g, b) => {
      _applyCssAccent(r, g, b);
    });
  }

  // Public: called when art is cleared (no track / clear queue)
  function onArtCleared() {
    if (!_auraEnabled) return;
    _resetCssAccent();
  }

  // Public getter: current aura RGB for canvas draws
  function getAuraRgb() { return _auraColor; }

  // ── Apply all settings ───────────────────────────────────────
  function applyAll(s) {
    _applyButtons(s.buttons);
    _auraEnabled = s.dynamicAura;
    if (!_auraEnabled) _resetCssAccent();
  }

  // ── Build settings panel HTML ────────────────────────────────
  function _buildPanel() {
    const panel = document.getElementById('settings-panel');
    if (!panel) return;

    // Build button checklist
    const btnRows = Object.entries(BUTTON_LABELS).map(([id, label]) => {
      const checked = _current.buttons[id] !== false;
      return '<label class="st-check-row">' +
        '<input type="checkbox" class="st-checkbox" data-btn="' + id + '"' +
          (checked ? ' checked' : '') + '>' +
        '<span class="st-check-label">' + label + '</span>' +
      '</label>';
    }).join('');

    panel.innerHTML =
      '<div class="st-header">' +
        '<div class="st-header-left">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#E8FF00" stroke-width="2">' +
            '<circle cx="12" cy="12" r="3"/>' +
            '<path d="M19.07 4.93a10 10 0 0 1 1.4 13.5L18 16"/>' +
            '<path d="M4.93 4.93a10 10 0 0 0-1.4 13.5L6 16"/>' +
            '<path d="M12 2v4M12 18v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83"/>' +
          '</svg>' +
          '<h2>SETTINGS</h2>' +
        '</div>' +
        '<button class="st-close-btn" id="st-close">✕</button>' +
      '</div>' +

      '<div class="st-body">' +

        // Section: Customize Buttons
        '<div class="st-section">' +
          '<div class="st-section-title">CUSTOMIZE TOOLBAR BUTTONS</div>' +
          '<div class="st-section-desc">Show or hide buttons in the main toolbar.</div>' +
          '<div class="st-checklist" id="st-btn-list">' + btnRows + '</div>' +
        '</div>' +

        '<div class="st-divider"></div>' +

        // Section: Dynamic Aura
        '<div class="st-section">' +
          '<div class="st-section-title-row">' +
            '<div>' +
              '<div class="st-section-title">DYNAMIC AURA</div>' +
              '<div class="st-section-desc">Adapts accent color from album art — affects ' +
              'seekbar, volume, visualizer, selected items, and glows.</div>' +
            '</div>' +
            '<label class="st-toggle">' +
              '<input type="checkbox" id="st-aura-toggle"' +
                (_current.dynamicAura ? ' checked' : '') + '>' +
              '<span class="st-toggle-track"><span class="st-toggle-thumb"></span></span>' +
            '</label>' +
          '</div>' +

          // Aura preview swatch (live)
          '<div class="st-aura-preview" id="st-aura-preview">' +
            '<div class="st-aura-swatch" id="st-aura-swatch" style="background:' +
              _auraColor.hex + '"></div>' +
            '<div class="st-aura-label" id="st-aura-label">Current: ' +
              _auraColor.hex.toUpperCase() + '</div>' +
          '</div>' +
        '</div>' +

      '</div>'; // .st-body

    _attachPanelEvents(panel);
  }

  function _attachPanelEvents(panel) {
    // Close
    panel.querySelector('#st-close').addEventListener('click', close);

    // Button checkboxes
    panel.querySelectorAll('.st-checkbox[data-btn]').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.btn;
        _current.buttons[id] = cb.checked;
        _save(_current);
        _applyButtons(_current.buttons);
      });
    });

    // Aura toggle
    const auraToggle = panel.querySelector('#st-aura-toggle');
    auraToggle.addEventListener('change', () => {
      _current.dynamicAura = auraToggle.checked;
      _auraEnabled = auraToggle.checked;
      _save(_current);
      if (!_auraEnabled) {
        _resetCssAccent();
        _updateAuraSwatch();
      } else {
        // Trigger extraction if art is currently displayed
        const albumArtEl = document.getElementById('album-art');
        if (albumArtEl && albumArtEl.classList.contains('loaded')) {
          onArtLoaded(albumArtEl);
          setTimeout(_updateAuraSwatch, 150);
        }
      }
    });
  }

  function _updateAuraSwatch() {
    const swatch = document.getElementById('st-aura-swatch');
    const label  = document.getElementById('st-aura-label');
    if (swatch) swatch.style.background = _auraColor.hex;
    if (label)  label.textContent = 'Current: ' + _auraColor.hex.toUpperCase();
  }

  // ── Open / Close ────────────────────────────────────────────
  function open() {
    isOpen = true;
    _current = _load();
    const overlay = document.getElementById('settings-overlay');
    _buildPanel();
    overlay.classList.add('active');
  }
  function close() {
    isOpen = false;
    document.getElementById('settings-overlay').classList.remove('active');
  }

  // ── Overlay click to close ───────────────────────────────────
  document.getElementById('settings-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('settings-overlay')) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) close(); });

  // ── Init ─────────────────────────────────────────────────────
  _current = _load();
  applyAll(_current); // apply on startup

  // Re-export swatch update for applyArt hook
  setInterval(() => { if (isOpen) _updateAuraSwatch(); }, 500);

  return { open, close, onArtLoaded, onArtCleared, getAuraRgb, applyAll };
})();

window.Settings = Settings;