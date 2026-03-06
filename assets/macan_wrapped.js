// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — MACAN WRAPPED 🎁
// Generates a visual "Wrapped" card (collage of cover art +
// listening stats) for Weekly / Monthly / Yearly periods.
// Reads data from the same localStorage key as listen-stats.js.
// Provides a "Save as Image" button via canvas → PNG download.
// ═══════════════════════════════════════════════════════════════

const MacanWrapped = (() => {

  // ── Storage key — must match listen-stats.js ────────────────
  // listen-stats.js stores: { daily: { 'YYYY-MM-DD': seconds }, tracks: { 'artist - title': { plays, art } } }
  const LS_KEY    = 'macan_listen_data';
  const TRACK_KEY = 'macan_track_plays';   // { 'artist|||title': { plays, art, artist, title } }

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
  function _getListenData() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    } catch { return {}; }
  }

  function _getTrackData() {
    try {
      return JSON.parse(localStorage.getItem(TRACK_KEY) || '{}');
    } catch { return {}; }
  }

  // ── Compute stats for a given period (last N days) ──────────
  function _computeStats(days) {
    const data     = _getListenData();
    const daily    = data.daily || {};
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
    const arts = stats.topTracks.filter(t => t.art).slice(0, 6);

    if (arts.length >= 3) {
      // 3 columns × 2 rows
      const cw = W / 3, ch = COLLAGE_H / 2;
      await Promise.all(arts.map((t, i) => {
        return new Promise(resolve => {
          const img = new Image();
          img.onload = () => {
            const col = i % 3, row = Math.floor(i / 3);
            ctx.save();
            ctx.globalAlpha = 0.85;
            // Cover-fit
            const scale = Math.max(cw / img.width, ch / img.height);
            const sw = img.width * scale, sh = img.height * scale;
            const sx = col * cw + (cw - sw) / 2;
            const sy = row * ch + (ch - sh) / 2;
            ctx.drawImage(img, sx, sy, sw, sh);
            ctx.restore();
            resolve();
          };
          img.onerror = resolve;
          img.src = t.art;
        });
      }));
    } else if (arts.length === 1) {
      // Single art, full width blurred bg
      await new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          ctx.save();
          ctx.filter = 'blur(12px)';
          ctx.globalAlpha = 0.5;
          ctx.drawImage(img, -20, -20, W + 40, COLLAGE_H + 40);
          ctx.filter = 'none';
          ctx.globalAlpha = 1;
          ctx.restore();
          resolve();
        };
        img.onerror = resolve;
        img.src = arts[0].art;
      });
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

  return { open, close };
})();

window.MacanWrapped = MacanWrapped;
