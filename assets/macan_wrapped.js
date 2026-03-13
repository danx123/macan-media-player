// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — MACAN WRAPPED 🎁
// Generates a visual "Wrapped" card (collage of cover art +
// listening stats) for Weekly / Monthly / Yearly periods.
// Reads data from the same localStorage key as listen-stats.js.
// Provides a "Save as Image" button via canvas → PNG download.
// ═══════════════════════════════════════════════════════════════

const MacanWrapped = (() => {

  // ── Storage key — must match listen-stats.js ────────────────
  // listen-stats.js stores daily data under 'macan_listen_daily'
  const LS_DAILY_KEY = 'macan_listen_daily';  // { 'YYYY-MM-DD': seconds }
  const TRACK_KEY    = 'macan_track_plays';   // { 'artist|||title': { plays, art, artist, title } }

  // ── Period definitions ──────────────────────────────────────
  const PERIODS = [
    { id: 'weekly',  label: 'WEEKLY',  days: 7  },
    { id: 'monthly', label: 'MONTHLY', days: 30 },
    { id: 'yearly',  label: 'YEARLY',  days: 365 },
  ];

  let _activePeriod = 'monthly';
  let _overlayEl    = null;
  let _canvasEl     = null;

  // ── Read listen-stats localStorage data ────────────────────
  function _getDailyData() {
    try {
      return JSON.parse(localStorage.getItem(LS_DAILY_KEY) || '{}');
    } catch { return {}; }
  }

  function _getTrackData() {
    try {
      return JSON.parse(localStorage.getItem(TRACK_KEY) || '{}');
    } catch { return {}; }
  }

  // ── Record a track play (called externally from script.js) ──
  function recordTrackPlay(track) {
    if (!track || !track.name) return;
    const key  = `${track.artist || ''}|||${track.name}`;
    const data = _getTrackData();
    const existing = data[key] || { plays: 0, artist: track.artist || '', title: track.name, art: null };
    existing.plays = (existing.plays || 0) + 1;
    // Store cover art if available in track object
    if (track.cover_art && !existing.art) {
      existing.art = track.cover_art;
    }
    data[key] = existing;
    try { localStorage.setItem(TRACK_KEY, JSON.stringify(data)); } catch {}
  }

  // ── Update art for a track (called when art is loaded) ──────
  function updateTrackArt(track, artSrc) {
    if (!track || !track.name || !artSrc) return;
    const key  = `${track.artist || ''}|||${track.name}`;
    const data = _getTrackData();
    if (data[key]) {
      data[key].art = artSrc;
      try { localStorage.setItem(TRACK_KEY, JSON.stringify(data)); } catch {}
    }
  }

  // ── Compute stats for a given period (last N days) ──────────
  function _computeStats(days) {
    const daily    = _getDailyData();   // { 'YYYY-MM-DD': seconds }
    const now      = new Date();
    const cutoff   = new Date(now - days * 86400000);

    let totalSecs = 0;
    let activeDays = 0;
    const dailyArr = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(cutoff.getTime() + i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const secs = daily[key] || 0;
      totalSecs += secs;
      if (secs > 0) activeDays++;
      dailyArr.push({ date: key, secs });
    }

    // Top tracks
    const trackData = _getTrackData();
    const topTracks = Object.entries(trackData)
      .map(([key, v]) => ({ ...v, key }))
      .sort((a, b) => (b.plays || 0) - (a.plays || 0))
      .slice(0, 6);

    // Longest day
    const peakEntry = dailyArr.reduce((best, d) => d.secs > (best?.secs || 0) ? d : best, null);

    return { totalSecs, activeDays, dailyArr, topTracks, peakEntry, days };
  }

  // ── Format seconds to readable ──────────────────────────────
  function _fmt(secs) {
    if (secs < 60)   return `${Math.round(secs)}s`;
    if (secs < 3600) return `${Math.round(secs/60)}m`;
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  // ── Fetch cover art from iTunes Search API ──────────────────
  async function _fetchItunesArt(artist, title) {
    if (!artist && !title) return null;
    const q = encodeURIComponent(`${artist} ${title}`.trim());
    try {
      const res = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&limit=1&entity=song`);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.results && data.results[0] && data.results[0].artworkUrl100) {
        // Use larger art (600px)
        return data.results[0].artworkUrl100.replace('100x100bb', '300x300bb');
      }
    } catch {}
    return null;
  }

  // ── Load image (with optional iTunes fallback) ───────────────
  async function _loadTrackArt(track) {
    // First try existing art from metadata
    if (track.art) {
      return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = track.art;
      });
    }
    // Fallback: fetch from iTunes
    const artUrl = await _fetchItunesArt(track.artist, track.title);
    if (artUrl) {
      // Cache art back to localStorage
      const key  = `${track.artist || ''}|||${track.title || ''}`;
      const data = _getTrackData();
      if (data[key]) {
        data[key].art = artUrl;
        try { localStorage.setItem(TRACK_KEY, JSON.stringify(data)); } catch {}
      }
      return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = artUrl;
      });
    }
    return null;
  }

  // ── Build the wrapped canvas ────────────────────────────────
  async function _drawCanvas(period, stats) {
    const W = 540, H = 760;
    const canvas = document.createElement('canvas');
    canvas.width  = W * 2; // retina
    canvas.height = H * 2;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    // ── Background ──────────────────────────────────────────
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0,   '#0a0a0a');
    bg.addColorStop(0.5, '#111108');
    bg.addColorStop(1,   '#0a0a0a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── Cover art collage (top 6, mosaic grid) ──────────────
    const COLLAGE_H = 280;
    const arts = stats.topTracks.slice(0, 6);

    // Load images (with iTunes fallback for missing art)
    const loadedImgs = await Promise.all(arts.map(t => _loadTrackArt(t)));
    const validImgs = loadedImgs.filter(Boolean);

    if (validImgs.length >= 3) {
      // 3 columns × up to 2 rows (max 6 images)
      const cols = 3;
      const rows = Math.min(2, Math.ceil(validImgs.length / cols));
      const cw = W / cols, ch = COLLAGE_H / rows;
      validImgs.slice(0, cols * rows).forEach((img, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.rect(col * cw, row * ch, cw, ch);
        ctx.clip();
        const scale = Math.max(cw / img.width, ch / img.height);
        const sw = img.width * scale, sh = img.height * scale;
        const sx = col * cw + (cw - sw) / 2;
        const sy = row * ch + (ch - sh) / 2;
        ctx.drawImage(img, sx, sy, sw, sh);
        ctx.restore();
      });
    } else if (validImgs.length === 2) {
      // 2 columns side by side
      const cw = W / 2, ch = COLLAGE_H;
      validImgs.forEach((img, i) => {
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.rect(i * cw, 0, cw, ch);
        ctx.clip();
        const scale = Math.max(cw / img.width, ch / img.height);
        const sw = img.width * scale, sh = img.height * scale;
        const sx = i * cw + (cw - sw) / 2;
        const sy = (ch - sh) / 2;
        ctx.drawImage(img, sx, sy, sw, sh);
        ctx.restore();
      });
    } else if (validImgs.length === 1) {
      // Single art — full width, sharp, centered cover-fit
      const img = validImgs[0];
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.rect(0, 0, W, COLLAGE_H);
      ctx.clip();
      const scale = Math.max(W / img.width, COLLAGE_H / img.height);
      const sw = img.width * scale, sh = img.height * scale;
      const sx = (W - sw) / 2;
      const sy = (COLLAGE_H - sh) / 2;
      ctx.drawImage(img, sx, sy, sw, sh);
      ctx.restore();
    } else {
      // No art — gradient placeholder
      const grd = ctx.createLinearGradient(0, 0, W, COLLAGE_H);
      grd.addColorStop(0, '#1a1a0a');
      grd.addColorStop(1, '#0f0f0f');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, COLLAGE_H);
    }

    // Gradient fade from collage into content
    const fade = ctx.createLinearGradient(0, COLLAGE_H - 80, 0, COLLAGE_H + 40);
    fade.addColorStop(0, 'rgba(10,10,10,0)');
    fade.addColorStop(1, '#0a0a0a');
    ctx.fillStyle = fade;
    ctx.fillRect(0, COLLAGE_H - 80, W, 120);

    // ── Header badge ────────────────────────────────────────
    const periodObj = PERIODS.find(p => p.id === period);
    const badge = periodObj.label + ' WRAPPED';
    ctx.save();
    ctx.fillStyle = '#E8FF00';
    ctx.font = 'bold 10px "Space Mono", monospace';
    const bw = ctx.measureText(badge).width + 20;
    ctx.fillStyle = 'rgba(232,255,0,0.15)';
    _roundRect(ctx, (W - bw) / 2, 14, bw, 22, 4);
    ctx.fill();
    ctx.fillStyle = '#E8FF00';
    ctx.textAlign = 'center';
    ctx.font = 'bold 9px "Space Mono", monospace';
    ctx.letterSpacing = '3px';
    ctx.fillText(badge, W / 2, 29);
    ctx.restore();

    let y = COLLAGE_H + 24;

    // ── Big headline stat ────────────────────────────────────
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#E8FF00';
    ctx.font = 'bold 52px "Bebas Neue", sans-serif';
    ctx.fillText(_fmt(stats.totalSecs), W / 2, y + 52);
    y += 58;

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px "Space Mono", monospace';
    ctx.fillText('TOTAL LISTENING TIME', W / 2, y + 12);
    y += 28;

    // Divider
    ctx.strokeStyle = 'rgba(232,255,0,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, y); ctx.lineTo(W - 40, y);
    ctx.stroke();
    y += 20;

    // ── Sub-stats row ────────────────────────────────────────
    const subStats = [
      { label: 'ACTIVE DAYS', value: `${stats.activeDays} / ${stats.days}` },
      { label: 'DAILY AVG',   value: stats.activeDays > 0 ? _fmt(stats.totalSecs / stats.activeDays) : '—' },
      { label: 'TOP TRACK',   value: stats.topTracks[0] ? _truncate(stats.topTracks[0].title || '—', 12) : '—' },
    ];

    const colW = W / 3;
    subStats.forEach((s, i) => {
      const cx = colW * i + colW / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px "Bebas Neue", sans-serif';
      ctx.fillText(s.value, cx, y + 18);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '7px "Space Mono", monospace';
      ctx.fillText(s.label, cx, y + 30);
    });
    y += 48;

    // Divider
    ctx.strokeStyle = 'rgba(232,255,0,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, y); ctx.lineTo(W - 40, y);
    ctx.stroke();
    y += 18;

    // ── Top tracks list ──────────────────────────────────────
    if (stats.topTracks.length > 0) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(232,255,0,0.6)';
      ctx.font = '8px "Space Mono", monospace';
      ctx.fillText('TOP TRACKS', 40, y + 10);
      y += 22;

      stats.topTracks.slice(0, 4).forEach((t, i) => {
        const tx = 40;
        // Number
        ctx.fillStyle = 'rgba(232,255,0,0.3)';
        ctx.font = 'bold 14px "Bebas Neue", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${i + 1}.`, tx, y + 13);
        // Title
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '10px "Space Mono", monospace';
        ctx.fillText(_truncate((t.title || t.key || '—').toUpperCase(), 26), tx + 22, y + 13);
        // Artist
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '8px "Space Mono", monospace';
        ctx.fillText(_truncate(t.artist || '', 30), tx + 22, y + 25);
        // Plays badge
        ctx.fillStyle = 'rgba(232,255,0,0.12)';
        _roundRect(ctx, W - 80, y + 2, 42, 16, 3);
        ctx.fill();
        ctx.fillStyle = '#E8FF00';
        ctx.font = '7px "Space Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${t.plays || 0} plays`, W - 59, y + 13);
        ctx.textAlign = 'left';

        y += 34;
      });
    }

    // ── Mini bar chart — last N days (compressed) ────────────
    const chartDays = Math.min(stats.days, 30);
    const slice     = stats.dailyArr.slice(-chartDays);
    const maxSecs   = Math.max(...slice.map(d => d.secs), 1);
    const chartH    = 36, chartW = W - 80;
    const barW      = Math.max(1, Math.floor(chartW / chartDays) - 1);
    const chartX    = 40;

    y += 6;
    ctx.fillStyle = 'rgba(232,255,0,0.4)';
    ctx.font = '7px "Space Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('LISTENING ACTIVITY', chartX, y);
    y += 10;

    slice.forEach((d, i) => {
      const bh  = d.secs > 0 ? Math.max(2, (d.secs / maxSecs) * chartH) : 2;
      const bx  = chartX + i * (barW + 1);
      const by  = y + chartH - bh;
      const alpha = d.secs > 0 ? 0.75 : 0.12;
      ctx.fillStyle = `rgba(232,255,0,${alpha})`;
      _roundRect(ctx, bx, by, barW, bh, 1);
      ctx.fill();
    });

    y += chartH + 20;

    // ── Motivational footer quote ────────────────────────────
    const QUOTES = [
      "Keep the music loud. 🎧",
      "Every track tells a story. 🐯",
      "Another week, another playlist. 🎵",
      "Your ears deserve only the best. 🔊",
      "The beat goes on. 🥁",
    ];
    const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = 'italic 10px "Space Mono", monospace';
    ctx.fillText(quote, W / 2, y);
    y += 22;

    // ── Branding watermark ───────────────────────────────────
    ctx.fillStyle = 'rgba(232,255,0,0.2)';
    ctx.font = 'bold 11px "Bebas Neue", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('MACAN MEDIA PLAYER', W / 2, H - 18);

    return canvas;
  }

  function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function _truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  // ── Render wrapped overlay ───────────────────────────────────
  async function _render(period) {
    _activePeriod = period;
    const periodObj = PERIODS.find(p => p.id === period);
    const stats     = _computeStats(periodObj.days);

    // Show loading state
    const canvasWrap = _overlayEl.querySelector('#mw-canvas-wrap');
    canvasWrap.innerHTML = '<div class="mw-loading">🎁 Generating your Wrapped...</div>';

    // Build canvas async
    const canvas = await _drawCanvas(period, stats);
    _canvasEl = canvas;
    canvas.className = 'mw-canvas';

    canvasWrap.innerHTML = '';
    canvasWrap.appendChild(canvas);
  }

  // ── Save as image ────────────────────────────────────────────
  function _save() {
    if (!_canvasEl) return;
    const period = PERIODS.find(p => p.id === _activePeriod);
    const date   = new Date().toISOString().slice(0, 10);
    const link   = document.createElement('a');
    link.download = `macan-wrapped-${period.id}-${date}.png`;
    link.href     = _canvasEl.toDataURL('image/png');
    link.click();
  }

  // ── Open overlay ─────────────────────────────────────────────
  function open(defaultPeriod = 'monthly') {
    if (_overlayEl) { _overlayEl.remove(); }

    const el = document.createElement('div');
    el.id        = 'mw-overlay';
    el.className = 'mw-overlay';
    el.innerHTML = `
      <div class="mw-panel">
        <div class="mw-header">
          <div class="mw-header-left">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#E8FF00" stroke-width="2">
              <polyline points="20 12 20 22 4 22 4 12"/>
              <rect x="2" y="7" width="20" height="5"/>
              <line x1="12" y1="22" x2="12" y2="7"/>
              <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/>
              <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>
            </svg>
            <h2>MACAN WRAPPED</h2>
          </div>
          <div class="mw-header-right">
            <button class="mw-save-btn" id="mw-save">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              SAVE IMAGE
            </button>
            <button class="mw-close-btn" id="mw-close">✕</button>
          </div>
        </div>

        <div class="mw-tabs">
          ${PERIODS.map(p => `
            <button class="mw-tab ${p.id === defaultPeriod ? 'mw-tab-active' : ''}"
                    data-period="${p.id}">${p.label}</button>
          `).join('')}
        </div>

        <div class="mw-canvas-wrap" id="mw-canvas-wrap">
          <div class="mw-loading">🎁 Generating your Wrapped...</div>
        </div>
      </div>`;

    document.body.appendChild(el);
    _overlayEl = el;
    requestAnimationFrame(() => el.classList.add('mw-visible'));

    // Wire tabs
    el.querySelectorAll('.mw-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        el.querySelectorAll('.mw-tab').forEach(t => t.classList.remove('mw-tab-active'));
        tab.classList.add('mw-tab-active');
        _render(tab.dataset.period);
      });
    });

    // Wire buttons
    el.querySelector('#mw-close').addEventListener('click', close);
    el.querySelector('#mw-save').addEventListener('click', _save);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    document.addEventListener('keydown', _escHandler);

    _render(defaultPeriod);
  }

  function close() {
    if (_overlayEl) {
      _overlayEl.classList.remove('mw-visible');
      setTimeout(() => { _overlayEl?.remove(); _overlayEl = null; }, 250);
    }
    document.removeEventListener('keydown', _escHandler);
  }

  function _escHandler(e) {
    if (e.key === 'Escape') close();
  }

  // ── Inject "WRAPPED" button into listen-stats panel ─────────
  function _injectButton() {
    const footer = document.querySelector('#listen-stats-overlay .ls-footer');
    if (!footer || document.getElementById('mw-open-btn')) return;

    const btn = document.createElement('button');
    btn.id        = 'mw-open-btn';
    btn.className = 'mw-open-btn';
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 12 20 22 4 22 4 12"/>
        <rect x="2" y="7" width="20" height="5"/>
        <line x1="12" y1="22" x2="12" y2="7"/>
        <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/>
        <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>
      </svg>
      🎁 WRAPPED`;
    btn.addEventListener('click', () => open('monthly'));
    footer.insertBefore(btn, footer.firstChild);
  }

  // Observe listen-stats open
  const _lsObserver = new MutationObserver(() => {
    const overlay = document.getElementById('listen-stats-overlay');
    if (overlay && overlay.classList.contains('active')) {
      setTimeout(_injectButton, 80);
    }
  });
  const _lsOverlay = document.getElementById('listen-stats-overlay');
  if (_lsOverlay) {
    _lsObserver.observe(_lsOverlay, { attributes: true, attributeFilter: ['class'] });
  }

  return { open, close, recordTrackPlay, updateTrackArt };
})();

window.MacanWrapped = MacanWrapped;
