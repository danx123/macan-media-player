// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — LISTEN STATISTICS MODULE
// Tracks listening time: current session, today, monthly totals.
// Data stored in localStorage, keyed by date (YYYY-MM-DD).
// ═══════════════════════════════════════════════════════════════

const ListenStats = (() => {
  const SK_DAILY   = 'macan_listen_daily';   // { 'YYYY-MM-DD': seconds }
  const SK_SESSION = 'macan_listen_session'; // seconds this session (runtime only)

  let _sessionSec  = 0;   // seconds accumulated this session
  let _ticker      = null; // setInterval handle
  let isOpen       = false;

  // ── Storage helpers ────────────────────────────────────────
  function _today() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }
  function _loadDaily() {
    try { return JSON.parse(localStorage.getItem(SK_DAILY)) || {}; }
    catch { return {}; }
  }
  function _saveDaily(data) {
    try { localStorage.setItem(SK_DAILY, JSON.stringify(data)); } catch {}
  }

  // ── Tick: called every second while playing ─────────────────
  function _tick() {
    _sessionSec += 1;
    const daily = _loadDaily();
    const key   = _today();
    daily[key]  = (daily[key] || 0) + 1;
    _saveDaily(daily);
    if (isOpen) _updateLiveCounters();
  }

  // ── Start / Stop ticker (called from script.js hooks) ───────
  function startTracking() {
    if (_ticker) return;
    _ticker = setInterval(_tick, 1000);
  }
  function stopTracking() {
    if (!_ticker) return;
    clearInterval(_ticker);
    _ticker = null;
  }

  // ── Computed values ─────────────────────────────────────────
  function _todaySec() {
    const d = _loadDaily();
    return d[_today()] || 0;
  }
  function _monthlySec() {
    const d = _loadDaily();
    const prefix = _today().slice(0, 7); // YYYY-MM
    return Object.entries(d)
      .filter(([k]) => k.startsWith(prefix))
      .reduce((s, [, v]) => s + v, 0);
  }
  function _last7Days() {
    const d = _loadDaily();
    const result = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const key = date.toISOString().slice(0, 10);
      result.push({ label: ['SUN','MON','TUE','WED','THU','FRI','SAT'][date.getDay()], sec: d[key] || 0 });
    }
    return result;
  }

  // ── Format helpers ──────────────────────────────────────────
  function _fmt(sec) {
    sec = Math.floor(sec);
    if (sec < 60)   return sec + 's';
    if (sec < 3600) return Math.floor(sec/60) + 'm ' + (sec%60) + 's';
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
    return h + 'h ' + m + 'm';
  }
  function _fmtLong(sec) {
    sec = Math.floor(sec);
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    return (h ? h+'h ' : '') + (m ? m+'m ' : '') + s+'s';
  }

  // ── Live counter update (panel open) ───────────────────────
  function _updateLiveCounters() {
    const el = (id) => document.getElementById(id);
    if (el('ls-session'))  el('ls-session').textContent  = _fmtLong(_sessionSec);
    if (el('ls-today'))    el('ls-today').textContent    = _fmtLong(_todaySec());
    if (el('ls-monthly'))  el('ls-monthly').textContent  = _fmtLong(_monthlySec());
  }

  // ── Bar chart ───────────────────────────────────────────────
  function _renderChart() {
    const canvas = document.getElementById('ls-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const days = _last7Days();
    const maxSec = Math.max(...days.map(d => d.sec), 60);
    const barW = 24, gap = (W - days.length * barW) / (days.length + 1);
    const chartH = H - 36; // leave room for labels

    ctx.clearRect(0, 0, W, H);

    days.forEach((day, i) => {
      const x = gap + i * (barW + gap);
      const barH = Math.max(2, (day.sec / maxSec) * chartH);
      const y = chartH - barH;
      const isToday = i === 6;

      // Bar glow
      if (day.sec > 0) {
        const grd = ctx.createLinearGradient(0, y, 0, chartH);
        grd.addColorStop(0, isToday ? 'rgba(232,255,0,0.9)' : 'rgba(232,255,0,0.45)');
        grd.addColorStop(1, isToday ? 'rgba(232,255,0,0.4)' : 'rgba(232,255,0,0.1)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
        ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.beginPath();
        ctx.roundRect(x, chartH - 3, barW, 3, [1, 1, 0, 0]);
        ctx.fill();
      }

      // Time label on hover — always show duration above bar if > 0
      if (day.sec > 0) {
        ctx.fillStyle = isToday ? '#E8FF00' : 'rgba(255,255,255,0.4)';
        ctx.font = `700 ${dpr > 1 ? 8 : 7}px "Space Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(_fmt(day.sec), x + barW/2, Math.max(y - 4, 10));
      }

      // Day label
      ctx.fillStyle = isToday ? '#E8FF00' : 'rgba(255,255,255,0.3)';
      ctx.font = `700 ${dpr > 1 ? 9 : 8}px "Space Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(day.label, x + barW/2, H - 4);
    });
  }

  // ── Reset ───────────────────────────────────────────────────
  function reset() {
    if (!confirm('Reset all listening statistics? This cannot be undone.')) return;
    localStorage.removeItem(SK_DAILY);
    _sessionSec = 0;
    render();
    if (window.AchievementSystem) AchievementSystem._onStatsReset();
  }

  // ── Full render ─────────────────────────────────────────────
  function render() {
    _updateLiveCounters();
    setTimeout(_renderChart, 60); // slight delay so canvas has layout
  }

  // ── Open / Close ────────────────────────────────────────────
  function open() {
    isOpen = true;
    document.getElementById('listen-stats-overlay').classList.add('active');
    render();
  }
  function close() {
    isOpen = false;
    document.getElementById('listen-stats-overlay').classList.remove('active');
  }

  // ── Events ──────────────────────────────────────────────────
  document.getElementById('ls-close').addEventListener('click', close);
  document.getElementById('listen-stats-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('listen-stats-overlay')) close();
  });
  document.getElementById('ls-reset-btn').addEventListener('click', reset);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) close(); });

  // ── Window resize → redraw chart ─────────────────────────────
  window.addEventListener('resize', () => { if (isOpen) setTimeout(_renderChart, 100); });

  return { open, close, startTracking, stopTracking, render, _todaySec, _monthlySec };
})();

window.ListenStats = ListenStats;
