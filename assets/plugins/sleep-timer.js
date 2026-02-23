// ═══════════════════════════════════════════════════════════════
// MACAN PLUGIN — Sleep Timer  v1.0.0
//
// Proof-of-concept plugin built with the Bridge Adapter.
// Demonstrates: overlay factory, nav menu injection, hook
// subscription, CSS injection, and bridge API usage.
//
// To enable: uncomment in plugins.config.js.
// ═══════════════════════════════════════════════════════════════

MacanBridge.register({
  id:      'sleep-timer',
  name:    'Sleep Timer',
  version: '1.0.0',

  // ── Nav menu item ─────────────────────────────────────────
  menu: {
    label: 'SLEEP TIMER',
    order: 200,   // appears after core items, before EXIT
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2">
             <circle cx="12" cy="12" r="10"/>
             <polyline points="12 6 12 12 16 14"/>
           </svg>`,
    action: () => SleepTimer.open(),
  },

  // ── CSS (injected once, scoped with plg-st- prefix) ──────
  styles: `
    .plg-sleep-timer-panel {
      padding: 28px;
      min-width: 320px;
    }
    .plg-st-title {
      font-family: 'Space Mono', monospace;
      font-size: 0.7rem;
      letter-spacing: 3px;
      color: rgba(255,255,255,0.5);
      margin-bottom: 20px;
    }
    .plg-st-countdown {
      font-family: 'Space Mono', monospace;
      font-size: 2.2rem;
      font-weight: 700;
      color: #E8FF00;
      text-align: center;
      margin: 16px 0;
      letter-spacing: 4px;
    }
    .plg-st-countdown.inactive { color: rgba(255,255,255,0.15); }
    .plg-st-presets {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }
    .plg-st-btn {
      flex: 1;
      min-width: 60px;
      padding: 8px 6px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      color: rgba(255,255,255,0.7);
      font-family: 'Space Mono', monospace;
      font-size: 0.6rem;
      letter-spacing: 1px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .plg-st-btn:hover {
      background: rgba(232,255,0,0.08);
      border-color: rgba(232,255,0,0.3);
      color: #E8FF00;
    }
    .plg-st-btn.active {
      background: rgba(232,255,0,0.12);
      border-color: rgba(232,255,0,0.5);
      color: #E8FF00;
    }
    .plg-st-cancel {
      width: 100%;
      padding: 10px;
      margin-top: 8px;
      background: rgba(255,60,60,0.06);
      border: 1px solid rgba(255,60,60,0.15);
      border-radius: 6px;
      color: rgba(255,100,100,0.7);
      font-family: 'Space Mono', monospace;
      font-size: 0.6rem;
      letter-spacing: 2px;
      cursor: pointer;
      transition: all 0.15s;
      display: none;
    }
    .plg-st-cancel:hover {
      background: rgba(255,60,60,0.12);
      color: #ff6060;
    }
    .plg-st-cancel.visible { display: block; }
    .plg-st-status {
      font-family: 'Space Mono', monospace;
      font-size: 0.55rem;
      letter-spacing: 1px;
      color: rgba(255,255,255,0.3);
      text-align: center;
      margin-top: 12px;
    }
  `,

  // ── Hook subscriptions ────────────────────────────────────
  on: {
    // Auto-cancel timer if user manually pauses before countdown ends
    'player:pause': () => {
      if (SleepTimer._source === 'timer') return; // we triggered the pause
      // If timer is running and user pauses manually, cancel timer
      if (SleepTimer._timerId) {
        SleepTimer.cancel();
        MacanBridge.api.showToast('SLEEP TIMER CANCELLED');
      }
    },
  },

  // ── Init ──────────────────────────────────────────────────
  init() {
    SleepTimer._buildUI();
  },
});

// ── Module ────────────────────────────────────────────────────
const SleepTimer = (() => {
  let _timerId     = null;
  let _intervalId  = null;
  let _remaining   = 0;
  let _source      = null;   // 'timer' when we trigger pause

  // Preset options in minutes
  const PRESETS = [5, 10, 15, 30, 45, 60, 90];

  let _overlay, _countdown, _cancelBtn, _statusEl, _presetBtns = [];

  function _buildUI() {
    _overlay = MacanBridge.api.createOverlay('sleep-timer', {
      html: `
        <div class="plg-st-title">⏱ SLEEP TIMER</div>
        <div class="plg-st-countdown inactive" id="plg-st-countdown">--:--</div>
        <div class="plg-st-presets" id="plg-st-presets"></div>
        <button class="plg-st-cancel" id="plg-st-cancel">✕ CANCEL TIMER</button>
        <div class="plg-st-status" id="plg-st-status">SELECT A DURATION</div>
      `,
    });

    const panel = _overlay.querySelector('.plg-panel');
    _countdown  = panel.querySelector('#plg-st-countdown');
    _cancelBtn  = panel.querySelector('#plg-st-cancel');
    _statusEl   = panel.querySelector('#plg-st-status');

    const presetsEl = panel.querySelector('#plg-st-presets');
    PRESETS.forEach(min => {
      const btn = document.createElement('button');
      btn.className   = 'plg-st-btn';
      btn.textContent = min >= 60 ? `${min/60}H` : `${min}M`;
      btn.dataset.min = min;
      btn.addEventListener('click', () => start(min));
      presetsEl.appendChild(btn);
      _presetBtns.push(btn);
    });

    _cancelBtn.addEventListener('click', () => {
      cancel();
      MacanBridge.api.showToast('SLEEP TIMER CANCELLED');
    });
  }

  function _fmt(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function start(minutes) {
    cancel(); // clear any existing timer

    _remaining = minutes * 60;
    _source    = null;

    _presetBtns.forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.min) === minutes);
    });
    _countdown.classList.remove('inactive');
    _cancelBtn.classList.add('visible');
    _statusEl.textContent = `PAUSING IN ${minutes} MINUTE${minutes !== 1 ? 'S' : ''}`;

    _countdown.textContent = _fmt(_remaining);

    _intervalId = setInterval(() => {
      _remaining--;
      _countdown.textContent = _fmt(_remaining);

      if (_remaining <= 0) {
        _source = 'timer';
        clearInterval(_intervalId);
        _intervalId = null;
        _timerId    = null;

        // Trigger pause via bridge API (uses existing togglePlayPause logic)
        if (MacanBridge.api.isPlaying()) {
          // Access togglePlayPause via window (it's a global in script.js)
          if (typeof togglePlayPause === 'function') togglePlayPause();
        }

        MacanBridge.api.showToast('SLEEP TIMER — PLAYBACK PAUSED', 4000);
        _reset();
      }
    }, 1000);
    _timerId = true;

    MacanBridge.api.showToast(`SLEEP TIMER SET — ${minutes} MIN`);
  }

  function cancel() {
    if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
    _timerId = null;
    _source  = null;
    _reset();
  }

  function _reset() {
    _remaining = 0;
    _countdown.textContent = '--:--';
    _countdown.classList.add('inactive');
    _cancelBtn.classList.remove('visible');
    _statusEl.textContent = 'SELECT A DURATION';
    _presetBtns.forEach(b => b.classList.remove('active'));
  }

  function open() {
    _overlay.classList.add('active');
  }

  return { open, start, cancel, get _timerId() { return _timerId; }, _source };
})();
