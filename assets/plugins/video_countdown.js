// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — PLUGIN: Video Next-Track Countdown
// File   : assets/plugins/video_countdown.js
// Author : Macan Angkasa
// Version: 1.0.1
//
// Shows a countdown overlay in the bottom-right corner of the
// video player 10 seconds before playback advances to the next
// track. Displays the upcoming track name and a live countdown.
//
// Only active during video playback. Hidden automatically when:
//   - Shuffle mode is enabled (next track is unpredictable)
//   - Repeat-one mode is active (track will restart, not advance)
//   - There is no next track in the queue
//   - The current track is not a video
//   - The player is paused
//
// To install:
//   1. Drop this file into assets/plugins/
//   2. Add one line to plugins.config.js:
//        'plugins/video_countdown.js',
// ═══════════════════════════════════════════════════════════════

MacanBridge.register({
  id:      'video-countdown',
  name:    'Video Next-Track Countdown',
  version: '1.0.1',

  on: {
    // Hide overlay and restart polling on track change
    'track:load': () => {
      VideoCountdown._hide();
    },

    // Hide when paused — countdown should not show while paused
    'player:pause': () => {
      VideoCountdown._hide();
    },

    // player:seek fires ~1/sec (SMTC throttle) — use as secondary tick
    'player:seek': () => {
      VideoCountdown._tick();
    },

    // Hide when track ends naturally
    'player:end': () => {
      VideoCountdown._hide();
    },

    // Hide when queue is cleared
    'queue:clear': () => {
      VideoCountdown._hide();
    },
  },

  styles: `
    /* ── Video Countdown Overlay ─────────────────────────────
       Injected inside #video-controls so it participates in
       the controls autohide behaviour. Bottom-right, above seekbar.
    ──────────────────────────────────────────────────────── */
    #plg-video-countdown-el {
      position: absolute;
      right: 16px;
      bottom: 64px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 3px;
      background: rgba(10, 10, 8, 0.82);
      border: 1px solid rgba(232, 255, 0, 0.35);
      border-radius: 6px;
      padding: 8px 12px 7px;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      pointer-events: none;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 0.25s ease, transform 0.25s ease;
      z-index: 502;
      min-width: 140px;
      max-width: 240px;
    }
    #plg-video-countdown-el.active {
      opacity: 1;
      transform: translateY(0);
    }
    .plg-vcd-label {
      font-family: 'Space Mono', monospace;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 2px;
      color: rgba(232, 255, 0, 0.55);
      text-transform: uppercase;
      line-height: 1;
    }
    .plg-vcd-title {
      font-family: 'Space Mono', monospace;
      font-size: 10px;
      font-weight: 700;
      color: #E8FF00;
      letter-spacing: 0.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 216px;
      text-align: right;
      line-height: 1.3;
    }
    .plg-vcd-row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 5px;
      color: rgba(232, 255, 0, 0.7);
      margin-top: 1px;
    }
    .plg-vcd-secs {
      font-family: 'Space Mono', monospace;
      font-size: 20px;
      font-weight: 700;
      color: #E8FF00;
      line-height: 1;
      min-width: 26px;
      text-align: right;
    }
    .plg-vcd-unit {
      font-family: 'Space Mono', monospace;
      font-size: 8px;
      letter-spacing: 1.5px;
      color: rgba(232, 255, 0, 0.5);
      align-self: flex-end;
      padding-bottom: 2px;
    }
  `,

  init() {
    VideoCountdown._buildUI();
    VideoCountdown._startPoll();
  },
});

// ── Plugin Module ─────────────────────────────────────────────
const VideoCountdown = (() => {

  const COUNTDOWN_SECS = 10;  // seconds before end to activate overlay
  const POLL_INTERVAL  = 500; // ms — self-poll independent of bridge events

  let _el      = null;
  let _titleEl = null;
  let _secsEl  = null;
  let _visible = false;
  let _pollId  = null;

  // ── Build the overlay DOM and attach to #video-controls ──────
  function _buildUI() {
    _el = document.createElement('div');
    _el.id = 'plg-video-countdown-el';
    _el.innerHTML = [
      '<div class="plg-vcd-label">UP NEXT</div>',
      '<div class="plg-vcd-title" id="plg-vcd-title"></div>',
      '<div class="plg-vcd-row">',
      '  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"',
      '    stroke="currentColor" stroke-width="2.5"',
      '    style="opacity:.65;flex-shrink:0">',
      '    <polygon points="5,4 15,12 5,20"/>',
      '    <line x1="19" y1="4" x2="19" y2="20"/>',
      '  </svg>',
      '  <span class="plg-vcd-secs" id="plg-vcd-secs">10</span>',
      '  <span class="plg-vcd-unit">SEC</span>',
      '</div>',
    ].join('');

    // Wait for #video-controls to exist before appending
    const controls = document.getElementById('video-controls');
    if (controls) {
      controls.appendChild(_el);
    } else {
      const obs = new MutationObserver(() => {
        const c = document.getElementById('video-controls');
        if (c) { c.appendChild(_el); obs.disconnect(); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }

    _titleEl = document.getElementById('plg-vcd-title');
    _secsEl  = document.getElementById('plg-vcd-secs');
  }

  // ── Self-polling every 500ms — independent of bridge emit rate ──
  // This is the primary driver. player:seek is used as a secondary
  // trigger. Using setInterval on the actual video element avoids
  // any throttling or timing gaps in the bridge event bus.
  function _startPoll() {
    if (_pollId) clearInterval(_pollId);
    _pollId = setInterval(_tick, POLL_INTERVAL);
  }

  // ── Resolve index of the next track, or -1 if none ──────────
  function _nextIndex() {
    if (typeof S === 'undefined') return -1;
    if (S.isShuffle)            return -1; // unpredictable
    if (S.repeatMode === 'one') return -1; // restarts same track

    const next = S.currentIndex + 1;
    if (next >= S.playlist.length) {
      return S.repeatMode === 'all' ? 0 : -1;
    }
    return next;
  }

  // ── Main tick — called by poll and by player:seek event ─────
  function _tick() {
    if (!_el) return;

    // Must be playing
    if (!MacanBridge.api.isPlaying()) { _hide(); return; }

    // Must be a video track
    const track = MacanBridge.api.getCurrentTrack();
    if (!track || !track.is_video) { _hide(); return; }

    // Video layer must be visible
    const videoLayer = document.getElementById('video-layer');
    if (!videoLayer || !videoLayer.classList.contains('active')) {
      _hide(); return;
    }

    // Read position directly from the video element — most accurate,
    // not subject to S.duration not yet being set after track load.
    // Support both 'video' and 'video-player' element IDs
    const videoEl = document.getElementById('video-player')
                 || document.getElementById('video');
    if (!videoEl) { _hide(); return; }

    const cur      = videoEl.currentTime;
    const dur      = videoEl.duration;

    // Guard: duration not yet available (stream not loaded yet)
    if (!dur || !isFinite(dur) || dur <= 0) { _hide(); return; }

    const remaining = dur - cur;
    const nextIdx   = _nextIndex();

    if (remaining > 0 && remaining <= COUNTDOWN_SECS && nextIdx >= 0) {
      const nextName = S.playlist[nextIdx]?.name || '';
      _show(Math.ceil(remaining), nextName);
    } else {
      _hide();
    }
  }

  // ── Show overlay with updated values ────────────────────────
  function _show(secsLeft, nextName) {
    if (!_el) return;
    if (_titleEl) {
      _titleEl.textContent = nextName;
      _titleEl.title       = nextName;
    }
    if (_secsEl) {
      _secsEl.textContent = Math.max(0, secsLeft);
    }
    if (!_visible) {
      _el.classList.add('active');
      _visible = true;
    }
  }

  // ── Hide overlay ─────────────────────────────────────────────
  function _hide() {
    if (!_el || !_visible) return;
    _el.classList.remove('active');
    _visible = false;
  }

  return { _buildUI, _startPoll, _tick, _hide };

})();
