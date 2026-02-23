/* ═══════════════════════════════════════════════════════════════
   MACAN MEDIA PLAYER — script.js
   Race Condition Fixes:
   1. Correct initialization order: S → DOM → modules (PlaylistManager/EQ)
   2. Event-driven state restore (no fragile setTimeout delay)
   3. Idempotent seekbar restore via seekPending flag
   4. Async-safe EQ band application with pendingEqBands guard
   5. Debounced & lock-guarded state persistence (no concurrent writes)
   6. pywebview readiness guard before restore
═══════════════════════════════════════════════════════════════ */
'use strict';

// ─── STATE ────────────────────────────────────────────────────
// MUST be declared first — all modules below reference S directly.
const S = {
  playlist:     [],
  currentIndex: -1,
  isPlaying:    false,
  isShuffle:    false,
  repeatMode:   'none',
  isMuted:      false,
  volume:       80,
  duration:     0,
  audioCtx:     null,
  analyser:     null,
  srcNode:      null,
  seekDragging: false,
  vcSeekDragging: false,
  vcHideTimer:  null,
  vcCursorTimer: null,  // auto-hide cursor timer in video fullscreen
  previewThrottle: null,
  lyricsOpen:   false,
  lyricsData:   null,     // { content, is_synced, lines }
  lyricsActiveLine: -1,
  // Fade & Normalization
  fadeEnabled:  true,
  fadeDuration: 1200,     // ms
  normEnabled:  false,    // ReplayGain normalization
  targetLUFS:   -14,      // target normalization level (dB)
  _fadeTimer:   null,
  _fadeGain:    null,     // Web Audio GainNode for fading
  _gainNode:    null,     // Web Audio GainNode for normalization
  // State persistence — debounce + in-flight lock
  _stateSaveTimer: null,
  _saveLock:    false,    // FIX: prevent concurrent save_app_state calls
  // Restore flags
  _pendingEqBands:   null,   // EQ bands to apply once AudioContext is ready
  _pendingEqPreset:  null,   // EQ preset name to restore in dropdown
  _seekPending:      null,   // { position } to apply once loadedmetadata fires
  _restoreComplete:  false,  // true after initial restore has finished
};

// ═══════════════════════════════════════════════════════════════
// THUMBNAIL CACHE + PERSIST HELPER
// ═══════════════════════════════════════════════════════════════
// thumbCache / videoThumbCache: path → dataUrl
// Survives clearPlaylist() + reload because it's in JS memory —
// so if Python returns cover_art from SQLite on re-add, _seedThumbCache
// warms the Map and renderPlaylist renders the img immediately.
// _persistArtToServer writes art back to Python playlist.json so
// it also survives full app restarts.
// ═══════════════════════════════════════════════════════════════
const thumbCache      = new Map();  // path → dataUrl
const videoThumbCache = new Map();  // path → dataUrl

// Debounced per-path persist — avoids hammering Python on rapid fetches
const _persistDebounce = new Map();
function _persistArtToServer(path, dataUrl, isVideo) {
  if (!pw() || !dataUrl) return;
  clearTimeout(_persistDebounce.get(path));
  _persistDebounce.set(path, setTimeout(() => {
    _persistDebounce.delete(path);
    const fn = isVideo
      ? pywebview.api.update_track_video_thumb(path, dataUrl)
      : pywebview.api.update_track_art(path, dataUrl);
    fn.catch(() => {});
  }, 1000));
}

// Seed caches from track array — call before renderPlaylist() whenever
// S.playlist is replaced so the first render is already cache-warm.
function _seedThumbCache(tracks) {
  for (const t of tracks) {
    if (t.cover_art   && !thumbCache.has(t.path))      thumbCache.set(t.path, t.cover_art);
    if (t.video_thumb && !videoThumbCache.has(t.path)) videoThumbCache.set(t.path, t.video_thumb);
  }
}

// ═══════════════════════════════════════════════════════════════
// LAZY THUMBNAIL LOADER
// Uses IntersectionObserver to fetch cover art / video thumbnails
// only when a playlist row scrolls into (or near) the viewport.
//
// How it works:
//   _buildPlaylistItem() renders a <div class="pl-thumb-placeholder"
//     data-lazy="audio|video" data-path="..."> for rows without art.
//   _lazyThumbObserver watches these placeholders with rootMargin 300px
//   so art is pre-fetched slightly before the row becomes visible.
//   On intersection → fetch → swap placeholder → <img>, persist to Python.
// ═══════════════════════════════════════════════════════════════

// _lazyThumbObserver is initialized lazily on first use so that
// #playlist-body is guaranteed to exist in the DOM.
let _lazyThumbObserver = null;
function _getLazyObserver() {
  if (_lazyThumbObserver) return _lazyThumbObserver;
  _lazyThumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      _lazyThumbObserver.unobserve(el);
      _fetchLazyThumb(el);
    }
  }, {
    root:       document.getElementById('playlist-body'),
    rootMargin: '300px 0px',
    threshold:  0,
  });
  return _lazyThumbObserver;
}

async function _fetchLazyThumb(placeholder) {
  if (!pw()) return;
  const path    = placeholder.dataset.path;
  const kind    = placeholder.dataset.lazy;   // 'audio' | 'video'
  const idx     = parseInt(placeholder.closest('.pl-item')?.dataset.index ?? '-1', 10);
  if (!path) return;

  try {
    let dataUrl = null;

    if (kind === 'video') {
      // Check in-memory cache first (populated by earlier loads)
      dataUrl = videoThumbCache.get(path) || null;
      if (!dataUrl) {
        dataUrl = await pywebview.api.get_video_thumbnail(path);
      }
      if (dataUrl) {
        videoThumbCache.set(path, dataUrl);
        const track = idx >= 0 ? S.playlist[idx] : null;
        if (track) {
          const wasNew = !track.video_thumb;
          track.video_thumb = dataUrl;
          if (!track.cover_art) {
            track.cover_art = dataUrl;
            thumbCache.set(path, dataUrl);
            if (idx === S.currentIndex) applyArt(dataUrl);
            if (wasNew) _persistArtToServer(path, dataUrl, true);
          }
          if (wasNew) _persistArtToServer(path, dataUrl, true);
        }
      }
    } else {
      // Audio: check memory cache → embedded tags → online fallback
      dataUrl = thumbCache.get(path) || null;
      if (!dataUrl) {
        dataUrl = await pywebview.api.get_cover_art(path);
      }
      if (dataUrl) {
        thumbCache.set(path, dataUrl);
        const track = idx >= 0 ? S.playlist[idx] : null;
        if (track) {
          const wasNew = !track.cover_art;
          track.cover_art = dataUrl;
          if (idx === S.currentIndex) applyArt(dataUrl);
          if (wasNew) _persistArtToServer(path, dataUrl, false);
        }
      }
    }

    if (!dataUrl) return;

    // Swap placeholder → img in the DOM (placeholder may be gone if row
    // was removed while fetch was in-flight — guard with isConnected)
    if (!placeholder.isConnected) return;
    const img = document.createElement('img');
    img.className  = kind === 'video'
      ? 'pl-thumb pl-thumb-video-img'
      : 'pl-thumb';
    img.src        = dataUrl;
    img.alt        = '';
    img.draggable  = false;
    img.loading    = 'lazy';
    placeholder.replaceWith(img);

  } catch (e) {
    // Silently ignore — placeholder stays, no crash
  }
}


let audioContext;
let audioSource;
let equalizer;
let equalizerUI;
let playlistManager;

// ── EQ UI bootstrap (no AudioContext needed) ──────────────────
// EqualizerUI is created immediately at script load so:
//   1. The EQ overlay is rendered and interactive from the start.
//   2. equalizerUI.currentPreset is always available for persistAppState,
//      even before the user has ever pressed Play.
//   3. Preset selection and scheduleStateSave() work without AudioContext.
//
// A lightweight stub equalizer (no BiquadFilters, no AudioContext) is used
// until initAudioContext() is called — at which point the real Equalizer10Band
// takes over and equalizerUI.eq is swapped to it.
const _eqStub = {
  // Preset table — duplicated here so UI can populate dropdown without AudioContext
  presets: {
    'Custom':        [0,0,0,0,0,0,0,0,0,0],
    'Flat':          [0,0,0,0,0,0,0,0,0,0],
    'Acoustic':      [4,4,3,1,2,2,3,4,3,2],
    'Bass Boost':    [9,7,5,2,0,0,0,0,0,0],
    'Bass Cut':      [-4,-3,-1,0,0,0,0,1,2,2],
    'Classical':     [5,4,3,2,-1,-1,0,2,3,4],
    'Dance':         [4,6,2,0,0,-2,-2,-2,4,4],
    'Electronic':    [5,4,1,0,-2,2,1,2,5,6],
    'Hip-Hop':       [6,5,1,2,-1,-1,1,-2,2,3],
    'Jazz':          [4,3,1,2,-2,-2,0,2,4,5],
    'Metal':         [5,4,4,2,0,-2,2,4,5,6],
    'Pop':           [-2,-1,2,4,5,4,2,0,-1,-1],
    'R&B':           [3,7,5,1,-2,-1,2,3,3,4],
    'Rock':          [5,4,3,1,-1,-1,1,3,4,5],
    'Small Speakers':[ 6,5,4,3,2,0,-2,-3,-4,-5],
    'Spoken Word':   [-2,-1,0,1,5,5,4,2,0,-3],
    'Treble Boost':  [0,0,0,0,0,1,3,5,7,9],
    'Vocal':         [-2,-3,-2,1,4,5,4,2,0,-1],
  },
  bandNames: ['31Hz','62Hz','125Hz','250Hz','500Hz','1kHz','2kHz','4kHz','8kHz','16kHz'],
  _pendingValues: null,
  _lastSavedPreset: 'Flat',
  applyPreset(name) {
    const v = this.presets[name];
    if (!v) return null;
    this._pendingValues = v.slice();
    if (typeof pywebview !== 'undefined') {
      pywebview.api.save_eq_preset_name(name).catch(() => {});
    }
    return v;
  },
  getCurrentValues() {
    return this._pendingValues ? this._pendingValues.slice() : Array(10).fill(0);
  },
  setBandGain() {},
  getBandGain(i) { return this._pendingValues?.[i] ?? 0; },
  setAllBands(vals) { if (vals) this._pendingValues = vals.slice(); },
  saveCustomPreset(vals) {
    this.presets['Custom'] = vals.slice();
    if (typeof pywebview !== 'undefined') {
      pywebview.api.save_eq_custom(vals).catch(() => {});
      pywebview.api.save_eq_preset_name('Custom').catch(() => {});
    }
  },
  async initFromPython() {
    if (typeof pywebview === 'undefined') return;
    try {
      const bands = await pywebview.api.get_eq_custom();
      if (Array.isArray(bands) && bands.length === 10) this.presets['Custom'] = bands;
    } catch (_) {}
    try {
      const name = await pywebview.api.get_eq_preset_name();
      if (name && this.presets[name]) {
        this._lastSavedPreset = name;
        this.applyPreset(name);
        if (equalizerUI) equalizerUI.syncSlidersFromEq(name);
      }
    } catch (_) {}
  },
};

// Build the UI immediately against the stub
equalizerUI = new EqualizerUI(_eqStub);

// As soon as pywebview is ready, load the saved preset into the stub UI
// (initFromPython is called again on the real equalizer after AudioContext init)
window.addEventListener('pywebviewready', () => {
  _eqStub.initFromPython();
}, { once: true });

function initAudioContext() {
  if (audioContext) return; // already initialized

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  equalizer    = new Equalizer10Band(audioContext);

  // Swap stub → real equalizer in the existing UI instance
  // (avoids destroying and rebuilding the DOM overlay)
  equalizerUI.eq = equalizer;

  // Copy preset state from stub to real equalizer
  equalizer.presets['Custom'] = _eqStub.presets['Custom'].slice();

  // GainNode for ReplayGain normalization
  S._gainNode = audioContext.createGain();
  S._gainNode.gain.value = 1.0;

  // GainNode for fade in/out
  S._fadeGain = audioContext.createGain();
  S._fadeGain.gain.value = 1.0;

  // Connect chain: source → EQ → normGain → fadeGain → destination
  if (!audioSource) {
    audioSource = audioContext.createMediaElementSource(audioPlayer);
    audioSource.connect(equalizer.input);
    equalizer.connect(S._gainNode);
    S._gainNode.connect(S._fadeGain);
    S._fadeGain.connect(audioContext.destination);
  }

  // Apply the preset that was selected in the stub (or restored from DB)
  // _pendingEqBands from _doStateRestore takes priority (exact band values)
  // over the stub's preset name (which may differ if user tweaked sliders).
  equalizer.initFromPython().then(() => {
    if (S._pendingEqBands) {
      equalizer.setAllBands(S._pendingEqBands);
      equalizerUI.syncSlidersFromEq(S._pendingEqPreset);
      S._pendingEqBands  = null;
      S._pendingEqPreset = null;
    } else {
      // No save_app_state bands — fall back to whatever initFromPython restored
      // (which is the eq_preset_name key), or the stub's pending values.
      const stubVals = _eqStub._pendingValues;
      if (stubVals) {
        equalizer.setAllBands(stubVals);
        equalizerUI.syncSlidersFromEq(equalizerUI.currentPreset);
      }
    }
  });
}


// ═══════════════════════════════════════════════════════════════
// SMTC — System Media Transport Controls
// Uses the W3C Media Session API (navigator.mediaSession).
//
// EdgeWebView2 requires these Chromium flags to be set BEFORE start:
//   --enable-features=HardwareMediaKeyHandling,MediaSessionService
// This is done in main.py via WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
//
// Cover art: EdgeWebView2 rejects data: URLs in MediaMetadata.artwork.
// Fix: convert data: → blob: URL via fetch()+URL.createObjectURL().
// Blob URLs are revoked and recreated each track change to avoid leaks.
// ═══════════════════════════════════════════════════════════════

let _smtcArtBlobUrl = null; // current blob: URL for cover art (revoked on next update)

async function _dataUrlToBlobUrl(dataUrl) {
  // Convert base64 data: URL → blob: URL (accepted by mediaSession artwork)
  try {
    const res  = await fetch(dataUrl);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch (e) {
    console.warn('[SMTC] blob conversion failed:', e.message);
    return null;
  }
}

function _detectMime(dataUrl) {
  // Extract mime type from data URL header e.g. "data:image/png;base64,..."
  const m = dataUrl && dataUrl.match(/^data:([^;]+);/);
  return m ? m[1] : 'image/jpeg';
}

async function updateMediaSession(track, artSrc) {
  if (!('mediaSession' in navigator)) return;

  const title  = track.name   || '—';
  const artist = track.artist || 'Macan Media Player';
  const album  = track.album  || track.ext || 'MACAN';

  // Revoke previous blob URL to avoid memory leak
  if (_smtcArtBlobUrl) {
    URL.revokeObjectURL(_smtcArtBlobUrl);
    _smtcArtBlobUrl = null;
  }

  let artwork = [];
  if (artSrc) {
    if (artSrc.startsWith('data:')) {
      // Convert data: → blob: because EdgeWebView2 rejects data: in artwork
      const mime    = _detectMime(artSrc);
      const blobUrl = await _dataUrlToBlobUrl(artSrc);
      if (blobUrl) {
        _smtcArtBlobUrl = blobUrl;
        artwork = [
          { src: blobUrl, sizes: '512x512', type: mime },
          { src: blobUrl, sizes: '256x256', type: mime },
        ];
      }
    } else if (artSrc.startsWith('http') || artSrc.startsWith('blob:')) {
      // Already a usable URL
      artwork = [
        { src: artSrc, sizes: '512x512', type: 'image/jpeg' },
        { src: artSrc, sizes: '256x256', type: 'image/jpeg' },
      ];
    }
  }

  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });
    navigator.mediaSession.playbackState = S.isPlaying ? 'playing' : 'paused';
    console.log(`[SMTC] Updated: ${artist} — ${title} | art=${artwork.length > 0}`);
  } catch (e) {
    console.warn('[SMTC] MediaMetadata error:', e.message);
  }
}

function syncMediaSessionState() {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.playbackState = S.isPlaying ? 'playing' : 'paused';

  if (S.duration > 0 && Number.isFinite(S.duration)) {
    try {
      navigator.mediaSession.setPositionState({
        duration:     S.duration,
        playbackRate: activePlayer().playbackRate || 1,
        position:     Math.min(activePlayer().currentTime, S.duration),
      });
    } catch (e) { /* setPositionState not supported on all builds */ }
  }
}

function initMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) {
    console.warn('[SMTC] navigator.mediaSession not available');
    return;
  }

  const handlers = {
    'play':          () => { if (activePlayer().paused) doPlay(activePlayer()); },
    'pause':         () => { if (!activePlayer().paused) activePlayer().pause(); },
    'previoustrack': () => prevTrack(),
    'nexttrack':     () => nextTrack(),
    'seekto':        details => {
      if (details.seekTime !== undefined && S.duration > 0) {
        activePlayer().currentTime = Math.min(details.seekTime, S.duration);
        syncMediaSessionState();
      }
    },
    'seekbackward':  details => {
      activePlayer().currentTime = Math.max(0, activePlayer().currentTime - (details.seekOffset || 10));
      syncMediaSessionState();
    },
    'seekforward':   details => {
      activePlayer().currentTime = Math.min(S.duration, activePlayer().currentTime + (details.seekOffset || 10));
      syncMediaSessionState();
    },
  };

  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (e) {
      // Some actions may not be supported in this WebView build
      console.warn(`[SMTC] Handler not supported: ${action}`);
    }
  }

  console.log('[SMTC] Media Session handlers registered');
}


// ═══════════════════════════════════════════════════════════════
// MINI PLAYER — Floating draggable/resizable PiP video overlay
// ═══════════════════════════════════════════════════════════════

const MiniPlayer = (() => {
  let active  = false;
  let mpEl    = null;
  let mpVideo = null;

  // Drag state
  let dragging = false, dragStartX = 0, dragStartY = 0, elStartX = 0, elStartY = 0;
  // Resize state
  let resizing = false, resStartX = 0, resStartW = 0, resStartH = 0;

  const MARGIN   = 12;
  const MIN_W    = 240;
  const MIN_H    = 135;
  const DEFAULT_W = 320;
  const DEFAULT_H = 180;

  function init() {
    mpEl    = document.getElementById('mini-player');
    mpVideo = document.getElementById('mp-video');
    if (!mpEl || !mpVideo) return;

    // Wire buttons
    document.getElementById('mp-play').onclick   = () => togglePlayPause();
    document.getElementById('mp-prev').onclick   = () => prevTrack();
    document.getElementById('mp-next').onclick   = () => nextTrack();
    document.getElementById('mp-expand').onclick = () => expandBack();
    document.getElementById('mp-close').onclick  = () => closeFromMini();

    // Drag via handle
    const handle = document.getElementById('mp-drag-handle');
    handle.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup',   stopDrag);

    // Resize via bottom-right handle
    const rh = document.getElementById('mp-resize-handle');
    rh.addEventListener('mousedown', startResize);
    document.addEventListener('mousemove', onResize);
    document.addEventListener('mouseup',   stopResize);

    // Position — bottom-right by default
    resetPosition();
  }

  function resetPosition() {
    if (!mpEl) return;
    mpEl.style.width  = DEFAULT_W + 'px';
    mpEl.style.height = DEFAULT_H + 'px';
    mpEl.style.right  = MARGIN + 'px';
    mpEl.style.bottom = MARGIN + 'px';
    mpEl.style.left   = '';
    mpEl.style.top    = '';
  }

  // ── DRAG ──────────────────────────────────────────────────────
  function startDrag(e) {
    e.preventDefault();
    dragging  = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const rect = mpEl.getBoundingClientRect();
    elStartX   = rect.left;
    elStartY   = rect.top;
    mpEl.style.right  = '';
    mpEl.style.bottom = '';
  }
  function onDrag(e) {
    if (!dragging) return;
    const dx  = e.clientX - dragStartX;
    const dy  = e.clientY - dragStartY;
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;
    const w   = mpEl.offsetWidth;
    const h   = mpEl.offsetHeight;
    const newX = Math.max(MARGIN, Math.min(vw - w - MARGIN, elStartX + dx));
    const newY = Math.max(MARGIN, Math.min(vh - h - MARGIN, elStartY + dy));
    mpEl.style.left = newX + 'px';
    mpEl.style.top  = newY + 'px';
  }
  function stopDrag()   { dragging = false; }

  // ── RESIZE ────────────────────────────────────────────────────
  function startResize(e) {
    e.preventDefault();
    resizing  = true;
    resStartX = e.clientX;
    resStartW = mpEl.offsetWidth;
    resStartH = mpEl.offsetHeight;
  }
  function onResize(e) {
    if (!resizing) return;
    const dx  = e.clientX - resStartX;
    const newW = Math.max(MIN_W, resStartW + dx);
    const newH = Math.round(newW * (9/16)); // maintain 16:9
    mpEl.style.width  = newW + 'px';
    mpEl.style.height = Math.max(MIN_H, newH) + 'px';
  }
  function stopResize() { resizing = false; }

  // ── OPEN / CLOSE ──────────────────────────────────────────────
  function open() {
    if (!mpEl || !mpVideo) return;
    if (active) return; // already open

    const mainVideo = document.getElementById('video-player');
    if (!mainVideo || !mainVideo.src) return;

    active = true;

    // Hide fullscreen video layer, show mini player
    videoLayer.classList.remove('active');
    document.getElementById('main-layout').style.display = '';

    // Mirror the video src and time to mpVideo
    mpVideo.src          = mainVideo.src;
    mpVideo.currentTime  = mainVideo.currentTime;
    mpVideo.volume       = mainVideo.volume;
    mpVideo.muted        = mainVideo.muted;
    mpVideo.playbackRate = mainVideo.playbackRate;

    // Pause the main video — mpVideo takes over output
    mainVideo.pause();
    mainVideo.muted = true;  // silence but keep src for expand-back

    resetPosition();
    mpEl.style.display = 'flex';

    if (!S.isPlaying) {
      mpVideo.pause();
    } else {
      mpVideo.play().catch(() => {});
    }

    updateMiniInfo();
    syncMiniPlayState(S.isPlaying);
    console.log('[MACAN] Mini player opened');
  }

  function expandBack() {
    if (!mpEl || !active) return;

    const mainVideo = document.getElementById('video-player');
    if (mainVideo) {
      // Sync position back from mpVideo
      mainVideo.currentTime = mpVideo.currentTime;
      mainVideo.muted       = false;
      if (!mpVideo.paused) {
        mainVideo.play().catch(() => {});
      }
    }

    mpVideo.pause();
    mpVideo.src = '';
    mpEl.style.display = 'none';
    active = false;

    // Restore fullscreen video layer
    videoLayer.classList.add('active');
    document.getElementById('main-layout').style.display = 'none';
    console.log('[MACAN] Mini player expanded back');
  }

  function closeFromMini() {
    if (!mpEl) return;

    // Stop everything
    mpVideo.pause();
    mpVideo.src = '';

    const mainVideo = document.getElementById('video-player');
    if (mainVideo) { mainVideo.muted = false; mainVideo.pause(); mainVideo.src = ''; }

    mpEl.style.display = 'none';
    active = false;

    // Return to main layout (not fullscreen)
    videoLayer.classList.remove('active');
    document.getElementById('main-layout').style.display = '';
    onPlayState(false);
    setStatus('VIDEO CLOSED');
    // Restore cursor when exiting video
    if (S._showCursor) S._showCursor();
    clearTimeout(S.vcCursorTimer);
  }

  function updateMiniInfo() {
    const titleEl = document.getElementById('mp-title');
    if (titleEl && S.currentIndex >= 0 && S.playlist[S.currentIndex]) {
      titleEl.textContent = S.playlist[S.currentIndex].name;
    }
  }

  function syncMiniPlayState(playing) {
    const pi = document.getElementById('mp-icon-play');
    const pa = document.getElementById('mp-icon-pause');
    if (pi) pi.style.display = playing ? 'none'  : 'block';
    if (pa) pa.style.display = playing ? 'block' : 'none';
    if (active && mpVideo) {
      if (playing && mpVideo.paused)  mpVideo.play().catch(() => {});
      if (!playing && !mpVideo.paused) mpVideo.pause();
    }
  }

  function syncMiniVolume(vol) {
    if (mpVideo) {
      mpVideo.volume = vol / 100;
      mpVideo.muted  = S.isMuted;
    }
  }

  function isActive() { return active; }

  return { init, open, expandBack, closeFromMini, updateMiniInfo, syncMiniPlayState, syncMiniVolume, isActive };
})();

// ─── DOM ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const audio         = $('audio-player');
const video         = $('video-player');
const videoLayer    = $('video-layer');
const videoControls = $('video-controls');
const albumArt      = $('album-art');
const artPlaceholder= $('album-art-placeholder');
const artBlurBg     = $('art-blur-bg');
const trackTitle    = $('track-title');
const trackArtist   = $('track-artist');
const trackFormat   = $('track-format');
const trackType     = $('track-type');
const progressBar   = $('progress-bar');
const progressFill  = $('progress-fill');
const progressThumb = $('progress-thumb');
const progressTrack = $('progress-track');
const timeCurrent   = $('time-current');
const timeTotal     = $('time-total');
const iconPlay      = $('icon-play');
const iconPause     = $('icon-pause');
const btnPlay       = $('btn-play');
const btnShuffle    = $('btn-shuffle');
const btnRepeat     = $('btn-repeat');
const repeatBadge   = $('repeat-badge');
const marqueeText   = $('marquee-text');
const marqueeClone  = $('marquee-text-clone');
const marqueeTrack  = $('marquee-track');
const playlistList  = $('playlist-list');
const playlistEmpty = $('playlist-empty');
const plCount       = $('pl-count');
const plDuration    = $('pl-duration-total');
const plStatus      = $('pl-status-text');
const volumeSlider  = $('volume-slider');
const volumeVal     = $('volume-val');
const miniCanvas    = $('mini-canvas');
const visCanvas     = $('vis-canvas');
const noiseCanvas   = $('noise-canvas');
// Video controls
const vcSeekbar     = $('vc-seekbar');
const vcSeekFill    = $('vc-seek-fill');
const vcSeekThumb   = $('vc-seek-thumb');
const vcTimeCur     = $('vc-time-current');
const vcTimeTotal   = $('vc-time-total');
const vcIconPlay    = $('vc-icon-play');
const vcIconPause   = $('vc-icon-pause');
const vcVolSlider   = $('vc-vol-slider');

const vcPreviewTooltip = $('vc-preview-tooltip');
const vcPreviewImg     = $('vc-preview-img');
const vcPreviewTime    = $('vc-preview-time');

// ═══════════════════════════════════════════════════════════════
// EQUALIZER & PLAYLIST MANAGER BUTTONS
// ═══════════════════════════════════════════════════════════════

const btnEqualizer = document.getElementById('btn-equalizer');
const btnPlaylistManager = document.getElementById('btn-playlist-manager');

// ─────────────────────────────────────────────────────────────────
// FIX: PlaylistManager and callbacks MUST be initialized AFTER S and
// DOM are defined. Moved here from the top of the file to prevent:
//   - ReferenceError: S is not defined
//   - ReferenceError: renderPlaylist/loadTrack/updatePlaylistMeta not defined
// ─────────────────────────────────────────────────────────────────
playlistManager = new PlaylistManager();

playlistManager.onSave(async (name) => {
  const tracks = S.playlist.map(item => ({
    path:     item.path,
    name:     item.name,
    artist:   item.artist   || '',
    album:    item.album    || '',
    duration: item.duration || 0,
    ext:      item.ext      || '',
    is_video: item.is_video || false,
  }));
  await playlistManager.saveCurrentPlaylist(name, tracks);
  setStatus(`PLAYLIST "${name}" SAVED`);
});

playlistManager.onLoad(async (name) => {
  if (!pw()) return;

  setStatus(`LOADING "${name}"…`);

  // Step 1: get file paths from the .m3u8 (fast Python call, no metadata)
  let paths;
  try {
    paths = await pywebview.api.get_playlist_paths(name);
  } catch (e) {
    console.error('[MACAN] get_playlist_paths error:', e);
    setStatus('ERROR READING PLAYLIST');
    return;
  }

  if (!paths || paths.length === 0) {
    setStatus('PLAYLIST IS EMPTY OR NOT FOUND');
    return;
  }

  // Step 2: stop current playback
  const p = activePlayer();
  p.pause();
  p.src = '';
  S.currentIndex = -1;
  onPlayState(false);

  // Step 3: clear Python queue, then add_tracks — identical to openFiles() flow
  try {
    await pywebview.api.clear_playlist();
    const playlist = await pywebview.api.add_tracks(paths);
    if (!playlist || playlist.length === 0) {
      setStatus('NO VALID TRACKS IN PLAYLIST');
      return;
    }
    S.playlist = playlist;
    _seedThumbCache(S.playlist);
    renderPlaylist();
    _rebuildTotalDuration();
    updatePlaylistMeta();
    setStatus(`LOADED "${name}" — ${playlist.length} TRACK(S)`);
    loadTrack(0);
  } catch (e) {
    console.error('[MACAN] onLoad error:', e);
    setStatus('ERROR LOADING PLAYLIST');
  }
});

btnEqualizer.addEventListener('click', () => {
  // AudioContext init deferred to actual playback — UI is already available
  equalizerUI.toggle();
  if (window.AchievementSystem) AchievementSystem.record('eqOpened');
});

btnPlaylistManager.addEventListener('click', () => {
  playlistManager.toggle();
});

// ─── ONLINE ART CALLBACK (called from Python via evaluate_js) ─────────────
window.onOnlineArtReady = function(path, dataUrl) {
  if (!dataUrl) return;
  thumbCache.set(path, dataUrl);

  const idx = S.playlist.findIndex(t => t.path === path);
  if (idx >= 0) {
    const wasNew = !S.playlist[idx].cover_art;
    S.playlist[idx].cover_art = dataUrl;
    // FIX: placeholder is a <div>, not <img>
    const item = playlistList.querySelector(`.pl-item[data-index="${idx}"]`);
    if (item) {
      const placeholder = item.querySelector('.pl-thumb-placeholder');
      if (placeholder) {
        const img = document.createElement('img');
        img.className = 'pl-thumb';
        img.src = dataUrl; img.alt = ''; img.draggable = false; img.loading = 'lazy';
        placeholder.replaceWith(img);
      }
    }
    if (wasNew) _persistArtToServer(path, dataUrl, false);
  }
  if (S.currentIndex >= 0 && S.playlist[S.currentIndex]?.path === path) {
    applyArt(dataUrl);
  }
};

// ═══════════════════════════════════════════════════════════════
// LYRICS MANAGER
// ═══════════════════════════════════════════════════════════════

const lyricsOverlay  = document.getElementById('lyrics-overlay');
const lyricsBody     = document.getElementById('lyrics-body');
const lyricsSyncBadge= document.getElementById('lyrics-sync-badge');
const lyricsTrackName= document.getElementById('lyrics-track-name');
const lyricsArtistName=document.getElementById('lyrics-artist-name');
const lyricsStatus   = document.getElementById('lyrics-status');
const lyricsRefetch  = document.getElementById('lyrics-refetch');
const btnLyrics      = document.getElementById('btn-lyrics');

btnLyrics.addEventListener('click', () => toggleLyrics());
document.getElementById('lyrics-close').addEventListener('click', () => closeLyrics());

// ── Converter button ─────────────────────────────────────────────────────
// Auto-inject the CONVERT button next to the clock if it doesn't exist in HTML
(function _injectConverterBtn() {
  if (document.getElementById('btn-converter')) {
    // Already exists in HTML — just bind it
    document.getElementById('btn-converter').addEventListener('click', () => {
      if (typeof openConverter === 'function') openConverter();
    });
    return;
  }

  // Not found in HTML — create and inject next to clock
  const btn = document.createElement('button');
  btn.id        = 'btn-converter';
  btn.title     = 'Converter';
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
    <span>CONVERT</span>`;

  Object.assign(btn.style, {
    display:       'flex',
    alignItems:    'center',
    gap:           '6px',
    background:    'rgba(200,255,0,0.10)',
    border:        '1px solid rgba(200,255,0,0.45)',
    color:         '#E8FF00',
    padding:       '6px 12px',
    borderRadius:  '4px',
    fontFamily:    "'Space Mono', monospace",
    fontSize:      '9px',
    fontWeight:    '700',
    letterSpacing: '1px',
    cursor:        'pointer',
    whiteSpace:    'nowrap',
    flexShrink:    '0',
    transition:    'all 0.2s ease',
  });

  btn.addEventListener('mouseenter', () => {
    btn.style.background   = 'rgba(200,255,0,0.22)';
    btn.style.borderColor  = '#c8ff00';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background   = btn.classList.contains('active')
      ? 'rgba(200,255,0,0.22)' : 'rgba(200,255,0,0.10)';
    btn.style.borderColor  = btn.classList.contains('active')
      ? '#c8ff00' : 'rgba(200,255,0,0.45)';
  });

  btn.addEventListener('click', () => {
    if (typeof openConverter === 'function') openConverter();
  });

  // Insert before the wm-controls (minimize/close buttons) inside .header-right
  const headerRight = document.querySelector('.header-right');
  const wmControls  = document.querySelector('.wm-controls');
  if (headerRight && wmControls) {
    headerRight.insertBefore(btn, wmControls);
  } else if (headerRight) {
    headerRight.appendChild(btn);
  } else {
    // Last resort: append to top-bar
    const topBar = document.getElementById('top-bar');
    if (topBar) topBar.appendChild(btn);
  }
})();

// ── Cache Manager ─────────────────────────────────────────────────────────
(function _initCacheManager() {
  const overlay   = document.getElementById('cache-manager-overlay');
  const btnOpen   = document.getElementById('btn-cache-manager');
  const btnClose  = document.getElementById('cm-close');
  const btnRefresh = document.getElementById('cm-refresh');
  const btnClearAll = document.getElementById('cm-clear-all');
  if (!overlay || !btnOpen) return;

  // Size element refs
  const sizeEls = {
    webview2:   document.getElementById('cm-size-webview2'),
    albumart:   document.getElementById('cm-size-albumart'),
    lyrics:     document.getElementById('cm-size-lyrics'),
    videothumb: document.getElementById('cm-size-videothumb'),
  };
  const totalEl = document.getElementById('cm-total-size');

  // Individual clear buttons
  const clearBtns = {
    webview2:   document.getElementById('cm-clear-webview2'),
    albumart:   document.getElementById('cm-clear-albumart'),
    lyrics:     document.getElementById('cm-clear-lyrics'),
    videothumb: document.getElementById('cm-clear-videothumb'),
  };

  async function loadSizes() {
    // Set all to loading state
    Object.values(sizeEls).forEach(el => {
      if (el) { el.textContent = '…'; el.className = 'cm-entry-size loading'; }
    });
    if (totalEl) totalEl.textContent = '…';

    if (!pw()) {
      Object.values(sizeEls).forEach(el => {
        if (el) { el.textContent = 'N/A'; el.className = 'cm-entry-size'; }
      });
      if (totalEl) totalEl.textContent = 'N/A';
      return;
    }

    try {
      const data = await pywebview.api.get_cache_sizes();
      let totalBytes = 0;
      for (const [key, info] of Object.entries(data)) {
        const el = sizeEls[key];
        if (el) {
          el.textContent = info.size_str;
          el.className = 'cm-entry-size';
        }
        totalBytes += info.size_bytes || 0;
      }
      // Format total
      let t = totalBytes;
      let unit = 'B';
      if (t >= 1073741824) { t /= 1073741824; unit = 'GB'; }
      else if (t >= 1048576) { t /= 1048576; unit = 'MB'; }
      else if (t >= 1024) { t /= 1024; unit = 'KB'; }
      if (totalEl) totalEl.textContent = unit === 'B' ? `${t} B` : `${t.toFixed(1)} ${unit}`;
    } catch (e) {
      console.warn('[CacheManager] get_cache_sizes error:', e);
      Object.values(sizeEls).forEach(el => {
        if (el) { el.textContent = 'ERR'; el.className = 'cm-entry-size'; }
      });
    }
  }

  async function doClear(target, btn) {
    if (!pw()) return;
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const result = await pywebview.api.clear_cache(target);
      if (!result.ok) console.warn('[CacheManager]', result.message);
    } catch (e) {
      console.warn('[CacheManager] clear_cache error:', e);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
      await loadSizes();
    }
  }

  // Wire individual clear buttons
  for (const [key, btn] of Object.entries(clearBtns)) {
    if (btn) btn.addEventListener('click', () => doClear(key, btn));
  }

  // Clear all
  if (btnClearAll) {
    btnClearAll.addEventListener('click', async () => {
      if (!confirm('Clear ALL caches? This cannot be undone.')) return;
      btnClearAll.disabled = true;
      btnClearAll.textContent = 'CLEARING…';
      try {
        if (pw()) await pywebview.api.clear_cache('all');
      } catch (e) {
        console.warn('[CacheManager] clear_cache all error:', e);
      } finally {
        btnClearAll.disabled = false;
        btnClearAll.textContent = '🗑 CLEAR ALL';
        await loadSizes();
      }
    });
  }

  if (btnRefresh) btnRefresh.addEventListener('click', loadSizes);

  function openCacheManager() {
    overlay.classList.add('active');
    loadSizes();
  }
  function closeCacheManager() {
    overlay.classList.remove('active');
  }

  btnOpen.addEventListener('click', openCacheManager);
  if (btnClose) btnClose.addEventListener('click', closeCacheManager);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeCacheManager(); });
})();
let _lyricsFullscreen = false;
let _lyricsEscHintTimer = null;

function _showLyricsEscHint() {
  let hint = document.getElementById('lyrics-esc-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'lyrics-esc-hint';
    hint.className = 'lyrics-esc-hint';
    hint.textContent = 'ESC — EXIT FULLSCREEN';
    document.body.appendChild(hint);
  }
  hint.classList.remove('hidden');
  clearTimeout(_lyricsEscHintTimer);
  // Auto-fade after 3s
  _lyricsEscHintTimer = setTimeout(() => hint.classList.add('hidden'), 3000);
}

function _hideLyricsEscHint() {
  const hint = document.getElementById('lyrics-esc-hint');
  if (hint) { hint.classList.add('hidden'); clearTimeout(_lyricsEscHintTimer); }
}

function _enterLyricsFullscreen() {
  _lyricsFullscreen = true;
  lyricsOverlay.classList.add('lyrics-fullscreen');
  const fsBtn = document.getElementById('lyrics-fullscreen');
  if (fsBtn) { fsBtn.classList.add('active'); fsBtn.textContent = 'EXIT FULLSCREEN'; }
  _showLyricsEscHint();
}

function _exitLyricsFullscreen() {
  _lyricsFullscreen = false;
  lyricsOverlay.classList.remove('lyrics-fullscreen');
  const fsBtn = document.getElementById('lyrics-fullscreen');
  if (fsBtn) { fsBtn.classList.remove('active'); fsBtn.textContent = 'FULLSCREEN MODE'; }
  _hideLyricsEscHint();
}

document.getElementById('lyrics-fullscreen').addEventListener('click', () => {
  _lyricsFullscreen ? _exitLyricsFullscreen() : _enterLyricsFullscreen();
});

// Close on overlay background click
lyricsOverlay.addEventListener('click', e => {
  if (e.target === lyricsOverlay) {
    // In fullscreen, background click exits fullscreen (not close)
    if (_lyricsFullscreen) { _exitLyricsFullscreen(); return; }
    closeLyrics();
  }
});

// Re-show ESC hint on mouse move while in lyrics fullscreen
lyricsOverlay.addEventListener('mousemove', () => {
  if (_lyricsFullscreen) _showLyricsEscHint();
});

// Refetch button
lyricsRefetch.addEventListener('click', () => {
  if (S.currentIndex >= 0) {
    fetchLyrics(S.playlist[S.currentIndex], true);
  }
});

function toggleLyrics() {
  if (S.lyricsOpen) {
    closeLyrics();
  } else {
    openLyrics();
  }
}

function openLyrics() {
  lyricsOverlay.classList.add('active');
  if (window.AchievementSystem) AchievementSystem.record('lyricsOpened');
  S.lyricsOpen = true;
  btnLyrics.classList.add('active');

  const track = S.currentIndex >= 0 ? S.playlist[S.currentIndex] : null;
  if (track && !track.is_video) {
    fetchLyrics(track);
  } else {
    showLyricsIdle();
  }
}

function closeLyrics() {
  lyricsOverlay.classList.remove('active');
  S.lyricsOpen = false;
  btnLyrics.classList.remove('active');
  // Exit fullscreen if active
  if (_lyricsFullscreen) _exitLyricsFullscreen();
}

function showLyricsIdle() {
  lyricsTrackName.textContent = '—';
  lyricsArtistName.textContent = '—';
  lyricsSyncBadge.style.display = 'none';
  lyricsRefetch.style.display = 'none';
  lyricsStatus.textContent = 'IDLE';
  lyricsBody.innerHTML = `
    <div class="lyrics-idle">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#E8FF00" stroke-width="1" opacity="0.2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <p>PLAY A TRACK TO LOAD LYRICS</p>
    </div>`;
}

function showLyricsLoading(track) {
  lyricsTrackName.textContent  = track.name;
  lyricsArtistName.textContent = track.artist ? track.artist.toUpperCase() : '—';
  lyricsSyncBadge.style.display = 'none';
  lyricsRefetch.style.display   = 'none';
  lyricsStatus.textContent      = 'SEARCHING...';
  lyricsBody.innerHTML = `
    <div class="lyrics-loading">
      <div class="lyrics-spinner"></div>
      <span>FETCHING LYRICS</span>
    </div>`;
}

function showLyricsNotFound(track) {
  lyricsStatus.textContent    = 'NOT FOUND';
  lyricsRefetch.style.display = 'inline-block';
  lyricsBody.innerHTML = `
    <div class="lyrics-not-found">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#E8FF00" stroke-width="1" opacity="0.2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <p>NO LYRICS FOUND</p>
      <small style="font-size:9px;color:var(--text-lo);">TRY REFETCH OR CHECK ARTIST/TITLE TAGS</small>
    </div>`;
}

function renderLyrics(data, track) {
  S.lyricsData = data;
  S.lyricsActiveLine = -1;
  lyricsSyncBadge.style.display = data.is_synced ? 'inline-block' : 'none';
  lyricsRefetch.style.display   = 'inline-block';
  lyricsStatus.textContent      = data.is_synced ? 'SYNCED (LRC)' : 'PLAIN TEXT';

  if (data.is_synced) {
    // Parse LRC lines: [mm:ss.xx] text
    const lrcLines = parseLRC(data.content);
    S.lyricsData.lines = lrcLines;
    let html = '<div class="lyrics-synced">';
    lrcLines.forEach((line, i) => {
      const txt = esc(line.text) || '&nbsp;';
      html += `<div class="lyric-line" data-index="${i}" data-time="${line.time}">${txt}</div>`;
    });
    html += '</div>';
    lyricsBody.innerHTML = html;

    // Click on line to seek
    lyricsBody.querySelectorAll('.lyric-line').forEach(el => {
      el.addEventListener('click', () => {
        const t = parseFloat(el.dataset.time);
        if (!isNaN(t)) {
          activePlayer().currentTime = t;
          if (activePlayer().paused) doPlay(activePlayer());
        }
      });
    });

    // Highlight current line
    highlightCurrentLyricLine();
  } else {
    lyricsBody.innerHTML = `<pre class="lyrics-plain">${esc(data.content)}</pre>`;
  }
}

function parseLRC(lrc) {
  const lines = [];
  const re = /\[(\d{1,3}):(\d{2})(?:[.:,](\d+))?\]\s*(.*)/;
  lrc.split('\n').forEach(rawLine => {
    const m = rawLine.match(re);
    if (m) {
      const min = parseInt(m[1]);
      const sec = parseInt(m[2]);
      const ms  = m[3] ? parseFloat('0.' + m[3]) : 0;
      lines.push({ time: min * 60 + sec + ms, text: (m[4] || '').trim() });
    }
  });
  return lines.sort((a, b) => a.time - b.time);
}

function highlightCurrentLyricLine() {
  if (!S.lyricsData?.is_synced || !S.lyricsData.lines) return;
  const cur = activePlayer().currentTime;
  const lines = S.lyricsData.lines;

  let activeIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (cur >= lines[i].time) { activeIdx = i; break; }
  }

  if (activeIdx === S.lyricsActiveLine) return;
  S.lyricsActiveLine = activeIdx;

  lyricsBody.querySelectorAll('.lyric-line').forEach((el, i) => {
    el.classList.toggle('active', i === activeIdx);
  });

  // Auto-scroll to active line
  if (activeIdx >= 0) {
    const el = lyricsBody.querySelector(`.lyric-line[data-index="${activeIdx}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

async function fetchLyrics(track, forceRefetch = false) {
  if (!track || track.is_video) { showLyricsIdle(); return; }
  showLyricsLoading(track);

  if (!pw()) {
    showLyricsNotFound(track);
    return;
  }

  try {
    const result = await pywebview.api.get_lyrics(
      track.path,
      track.artist || '',
      track.name,
      track.duration || 0
    );
    if (result && result.content) {
      renderLyrics(result, track);
    } else {
      showLyricsNotFound(track);
    }
  } catch(e) {
    console.error('[Lyrics] Error:', e);
    showLyricsNotFound(track);
  }
}

// Initialize audio context on first user interaction
btnPlay.addEventListener('click', () => {
  initAudioContext();
}, { once: true });

// ─── ACTIVE PLAYER helper ─────────────────────────────────────
function activePlayer() {
  return S.currentIndex >= 0 && S.playlist[S.currentIndex]?.is_video ? video : audio;
}

function pw() { return typeof pywebview !== 'undefined'; }

// ─── INIT ─────────────────────────────────────────────────────
window.addEventListener('load', () => {
  initNoise();
  initClock();
  initBgVis();
  initIdleMiniVis();
  setupAudioEvents();
  setupVideoEvents();
  setupSeekbar();
  setupVcSeekbar();
  setupVideoControls();
  setupVideoContextMenu();

  // Set default CORS settings just in case
  //audio.crossOrigin = "anonymous";
  //video.crossOrigin = "anonymous";

  audio.volume = S.volume / 100;
  video.volume = S.volume / 100;
  updateVolumeUI(S.volume);
  syncVcVolume(S.volume);

  // Bind buttons
  $('btn-close').onclick     = () => { if(pw()) pywebview.api.close_app(); else window.close(); };
  $('btn-minimize').onclick  = () => pw() && pywebview.api.minimize_app();
  btnPlay.onclick            = () => {
    const wasPaused = activePlayer().paused;
    togglePlayPause();
    if (videoLayer.classList.contains('active')) {
      flashCenterOverlay(wasPaused ? 'play' : 'pause');
    }
  };
  $('btn-prev').onclick      = prevTrack;
  $('btn-next').onclick      = nextTrack;
  btnShuffle.onclick         = toggleShuffle;
  btnRepeat.onclick          = cycleRepeat;
  $('btn-mute').onclick      = toggleMute;
  $('btn-add-files').onclick = openFiles;
  $('btn-add-folder').onclick= openFolder;
  $('btn-clear').onclick     = clearPlaylist;
  $('search-input').oninput  = e => filterPlaylist(e.target.value);
  volumeSlider.oninput       = e => setVolume(+e.target.value);
  vcVolSlider.oninput        = e => setVolume(+e.target.value);

  // Video overlay buttons
  $('vc-play').onclick        = () => {
    const wasPaused = activePlayer().paused;
    togglePlayPause();
    flashCenterOverlay(wasPaused ? 'play' : 'pause');
  };
  $('vc-prev').onclick        = prevTrack;
  $('vc-next').onclick        = nextTrack;
  $('vc-close').onclick       = closeVideo;
  $('vc-mute').onclick        = toggleMute;
  $('vc-fullscreen').onclick  = () => pw() && pywebview.api.toggle_fullscreen();
  $('vc-miniplayer').onclick  = () => MiniPlayer.open();

  // Init mini player drag/resize/controls
  MiniPlayer.init();

  // Init SMTC (Media Session API) handlers
  initMediaSessionHandlers();

  // ─── STATE RESTORE ──────────────────────────────────────────
  // FIX: Use event-driven readiness instead of a fragile setTimeout.
  // pywebview fires window.pywebviewready when the JS bridge is ready.
  // We also check pw() synchronously in case it fired before this ran.
  if (pw()) {
    _doStateRestore();
  } else {
    window.addEventListener('pywebviewready', () => _doStateRestore(), { once: true });
  }
});

// ─── STATE RESTORE (event-driven, called once pywebview is ready) ──────────
async function _doStateRestore() {
  try {
    setStatus('RESTORING SESSION...');

    // FIX: Both calls in parallel — avoids sequential await waterfall latency
    const [saved, state] = await Promise.all([
      pywebview.api.get_playlist().catch(() => []),
      pywebview.api.get_app_state().catch(() => ({}))
    ]);

    // ── 1. Restore playlist ──────────────────────────────────
    if (Array.isArray(saved) && saved.length) {
      S.playlist = saved;
      _seedThumbCache(S.playlist);
      renderPlaylist();
      _rebuildTotalDuration();
      updatePlaylistMeta();
    }

    // ── 2. Restore settings ─────────────────────────────────
    if (state && typeof state === 'object') {
      if (state.volume !== undefined) {
        S.volume = state.volume;
        audio.volume = video.volume = S.volume / 100;
        updateVolumeUI(S.volume);
        syncVcVolume(S.volume);
      }
      if (state.isShuffle !== undefined) {
        S.isShuffle = state.isShuffle;
        btnShuffle.classList.toggle('active', S.isShuffle);
      }
      if (state.repeatMode !== undefined) {
        S.repeatMode = state.repeatMode;
        btnRepeat.classList.toggle('active', S.repeatMode !== 'none');
        repeatBadge.style.display = S.repeatMode === 'one' ? 'flex' : 'none';
      }
      if (state.fadeEnabled  !== undefined) S.fadeEnabled  = state.fadeEnabled;
      if (state.fadeDuration !== undefined) S.fadeDuration = state.fadeDuration;
      if (state.normEnabled  !== undefined) S.normEnabled  = state.normEnabled;

      // FIX: Store EQ bands as pending — AudioContext may not exist yet.
      // If AudioContext is already initialized (e.g. user had interacted before
      // this restore path runs), apply immediately so audio effect is live.
      // Otherwise applied in initAudioContext() on first user interaction.
      if (Array.isArray(state.eqBands) && state.eqBands.length === 10) {
        if (equalizer && audioContext) {
          equalizer.setAllBands(state.eqBands);
          if (equalizerUI) equalizerUI.syncSlidersFromEq(state.eqPreset || null);
        } else {
          S._pendingEqBands  = state.eqBands;
          S._pendingEqPreset = state.eqPreset || null;
        }
      }

      // ── 3. Restore last track + seek position ──────────────
      const savedIdx = typeof state.currentIndex === 'number' ? state.currentIndex : -1;
      const savedPos = typeof state.seekPosition  === 'number' ? state.seekPosition : 0;

      if (savedIdx >= 0 && savedIdx < S.playlist.length) {
        S.currentIndex = savedIdx;
        const track = S.playlist[savedIdx];

        updateTrackInfo(track);
        updatePlaylistHighlight(savedIdx);
        applyNormalization(track);
        setStatus(`PAUSED — ${track.name}`);

        // Resolve the streamable http:// URL from Python media server
        let srcUrl = '';
        try {
          const resolved = await pywebview.api.get_file_url(track.path);
          if (resolved) { srcUrl = resolved; track.url = resolved; }
        } catch(e) {
          console.warn('[MACAN] URL resolve failed on restore:', e);
          srcUrl = track.url || '';
        }

        if (!srcUrl) {
          setStatus('READY (could not resolve last track URL)');
          S._restoreComplete = true;
          return;
        }

        const player = track.is_video ? video : audio;

        if (track.is_video) {
          videoLayer.classList.add('active');
          $('main-layout').style.display = 'none';
          $('vc-title-text').textContent = track.name.toUpperCase();
        } else {
          videoLayer.classList.remove('active');
          $('main-layout').style.display = '';
        }

        // FIX: Store seek target BEFORE setting src so onMeta() (which fires
        // on loadedmetadata) can consume it. This eliminates the race between
        // addEventListener('loadedmetadata', fn) and player.load().
        if (savedPos > 0) {
          S._seekPending = { position: savedPos };
        }

        player.src = srcUrl;
        player.load(); // triggers loadedmetadata → onMeta → seek applied there
      } else {
        setStatus('READY');
      }
    } else {
      setStatus('READY');
    }
  } catch(e) {
    console.warn('[MACAN] State restore failed:', e);
    setStatus('READY');
  } finally {
    S._restoreComplete = true;
  }
}

// ─── CLOCK ────────────────────────────────────────────────────
function initClock() {
  const DAYS = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  function tick() {
    const n = new Date();
    const H = String(n.getHours()).padStart(2,'0');
    const M = String(n.getMinutes()).padStart(2,'0');
    const Sc= String(n.getSeconds()).padStart(2,'0');
    $('clock-time').textContent = `${H}:${M}:${Sc}`;
    $('clock-date').textContent = `${DAYS[n.getDay()]} ${String(n.getDate()).padStart(2,'0')}`;
  }
  tick(); setInterval(tick, 1000);
}

// ─── NOISE ────────────────────────────────────────────────────
function initNoise() {
  const ctx = noiseCanvas.getContext('2d');
  function resize() { noiseCanvas.width = innerWidth; noiseCanvas.height = innerHeight; }
  resize();
  window.addEventListener('resize', resize);
  function drawNoise() {
    const img = ctx.createImageData(noiseCanvas.width, noiseCanvas.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i+1] = img.data[i+2] = v;
      img.data[i+3] = 25;
    }
    ctx.putImageData(img, 0, 0);
    requestAnimationFrame(drawNoise);
  }
  drawNoise();
}

// ─── BG VISUALIZER ────────────────────────────────────────────
// ─── BG VISUALIZER (Enhanced) ────────────────────────────────
// Multi-layer: floating particles + spectrum bars + circular rings
function initBgVis() {
  const ctx = visCanvas.getContext('2d');
  function resize() { visCanvas.width = innerWidth; visCanvas.height = innerHeight; }
  resize();
  window.addEventListener('resize', resize);

  // Particle system
  const PARTICLE_COUNT = 55;
  const particles = Array.from({ length: PARTICLE_COUNT }, () => ({
    x: Math.random() * innerWidth,
    y: Math.random() * innerHeight,
    vx: (Math.random() - 0.5) * 0.4,
    vy: (Math.random() - 0.5) * 0.4,
    r: Math.random() * 1.8 + 0.5,
    alpha: Math.random() * 0.4 + 0.1,
    pulse: Math.random() * Math.PI * 2,
    pulseSpeed: Math.random() * 0.02 + 0.005,
    freq: Math.floor(Math.random() * 60),  // which freq bin drives this particle
  }));

  let phase = 0;
  let smoothData = new Float32Array(128).fill(0);

  function getFreqData() {
    if (S.analyser && S.isPlaying) {
      const raw = new Uint8Array(S.analyser.frequencyBinCount);
      S.analyser.getByteFrequencyData(raw);
      // Smooth with exponential moving average
      for (let i = 0; i < smoothData.length; i++) {
        const target = raw[i] / 255;
        smoothData[i] += (target - smoothData[i]) * 0.18;
      }
    } else if (S.isPlaying) {
      // Simulated: sine waves per band
      for (let i = 0; i < smoothData.length; i++) {
        const target = Math.abs(Math.sin(i * 0.18 + phase * 1.8)) * 0.45 *
                       Math.abs(Math.sin(i * 0.07 + phase * 0.7));
        smoothData[i] += (target - smoothData[i]) * 0.12;
      }
    } else {
      // Idle: gentle breathing
      for (let i = 0; i < smoothData.length; i++) {
        const target = Math.abs(Math.sin(i * 0.12 + phase * 0.5)) * 0.12;
        smoothData[i] += (target - smoothData[i]) * 0.06;
      }
    }
    return smoothData;
  }

  function draw() {
    const W = visCanvas.width, H = visCanvas.height;
    const data = getFreqData();
    const bass = (data[1] + data[2] + data[3]) / 3;
    const mid  = (data[10] + data[15] + data[20]) / 3;
    const isActive = S.isPlaying;

    ctx.clearRect(0, 0, W, H);

    // ── Layer 1: bottom spectrum bars ──────────────────────────
    const bars = 72, bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const t = i / bars;
      const di = Math.floor(t * data.length * 0.65);
      const amp = data[di];
      const h = isActive
        ? amp * H * 0.42 + 4
        : Math.abs(Math.sin(t * Math.PI * 2.5 + phase)) * 28 + 4;

      // Multi-colour gradient: acid yellow → cyan tint at peaks
      const g = ctx.createLinearGradient(0, H, 0, H - h);
      g.addColorStop(0, `rgba(232,255,0,${isActive ? amp * 0.5 + 0.05 : 0.08})`);
      g.addColorStop(0.6, `rgba(200,255,80,${isActive ? amp * 0.3 : 0.04})`);
      g.addColorStop(1, `rgba(100,255,220,${isActive ? amp * 0.15 : 0.02})`);
      ctx.fillStyle = g;

      const x = i * bw;
      const rr = 1;
      ctx.beginPath();
      ctx.moveTo(x + rr, H);
      ctx.lineTo(x + bw - rr - 2, H);
      ctx.lineTo(x + bw - rr - 2, H - h + rr);
      ctx.arcTo(x + bw - rr - 2, H - h, x + bw - rr - 2 - rr, H - h, rr);
      ctx.lineTo(x + rr, H - h);
      ctx.arcTo(x, H - h, x, H - h + rr, rr);
      ctx.closePath();
      ctx.fill();
    }

    // ── Layer 2: mid-screen waveform ribbon ───────────────────
    if (isActive) {
      ctx.beginPath();
      const wy = H * 0.62;
      const wamp = mid * H * 0.08 + 6;
      for (let x = 0; x <= W; x += 3) {
        const t = x / W;
        const di = Math.floor(t * data.length * 0.8);
        const y = wy + Math.sin(t * Math.PI * 8 + phase * 3) * wamp * (data[di] + 0.1) * 1.4;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(232,255,0,${0.08 + mid * 0.18})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ── Layer 3: floating particles ───────────────────────────
    for (const p of particles) {
      p.pulse += p.pulseSpeed * (1 + bass * 3);
      const freqAmp = data[p.freq] || 0;
      const boost = isActive ? freqAmp * 2.5 : 0;
      const alpha = p.alpha * (0.5 + 0.5 * Math.sin(p.pulse)) + boost * 0.3;
      const radius = p.r * (1 + boost * 1.2);

      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(232,255,0,${Math.min(alpha, 0.85)})`;
      ctx.fill();

      // Particle connections (nearby only)
      for (const q of particles) {
        if (q === p) continue;
        const dx = q.x - p.x, dy = q.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 90) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = `rgba(232,255,0,${(1 - dist / 90) * 0.06 * (1 + bass)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }

      // Move + wrap
      p.x += p.vx * (1 + bass * 2);
      p.y += p.vy * (1 + bass * 2);
      if (p.x < -10) p.x = W + 10;
      if (p.x > W + 10) p.x = -10;
      if (p.y < -10) p.y = H + 10;
      if (p.y > H + 10) p.y = -10;
    }

    // ── Layer 4: top scanline / grid accent ───────────────────
    if (isActive && bass > 0.3) {
      ctx.strokeStyle = `rgba(232,255,0,${(bass - 0.3) * 0.12})`;
      ctx.lineWidth = 1;
      for (let y = 0; y < H; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y); ctx.lineTo(W, y);
        ctx.stroke();
      }
    }

    phase += 0.008;
    requestAnimationFrame(draw);
  }
  draw();
}

// ─── MINI VISUALIZER (Multi-mode) ──────────────────────────────
// Modes: bars | wave | scope | mirror | dots
let miniAnimId = null;
const VIS_MODES = ['bars', 'wave', 'scope', 'mirror', 'dots'];
const VIS_MODE_LABELS = {
  bars:   'BAR SPECTRUM',
  wave:   'WAVEFORM',
  scope:  'OSCILLOSCOPE',
  mirror: 'MIRROR BARS',
  dots:   'DOT STORM',
};
let currentVisMode = 0; // index into VIS_MODES

function cycleVisMode() {
  currentVisMode = (currentVisMode + 1) % VIS_MODES.length;
  const label = document.getElementById('vis-mode-label');
  if (label) {
    label.textContent = VIS_MODE_LABELS[VIS_MODES[currentVisMode]];
    label.classList.add('show');
    clearTimeout(label._hideTimer);
    label._hideTimer = setTimeout(() => label.classList.remove('show'), 1800);
  }
  if (S.analyser) initLiveMiniVis();
  else initIdleMiniVis();
}

// Attach click handler to mini-vis div
document.addEventListener('DOMContentLoaded', () => {
  const mv = document.getElementById('mini-vis');
  if (mv) mv.addEventListener('click', cycleVisMode);
});
// Also attach immediately if DOM already ready
(function attachMiniVisClick() {
  const mv = document.getElementById('mini-vis');
  if (mv) mv.addEventListener('click', cycleVisMode);
})();

function initIdleMiniVis() {
  if (miniAnimId) cancelAnimationFrame(miniAnimId);
  const ctx = miniCanvas.getContext('2d');
  let ph = 0;
  let smoothed = new Float32Array(48).fill(0);

  function frame() {
    if (S.analyser) { initLiveMiniVis(); return; }
    miniAnimId = requestAnimationFrame(frame);
    const W = miniCanvas.width, H = miniCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const mode = VIS_MODES[currentVisMode];

    if (mode === 'wave' || mode === 'scope') {
      // Idle wave
      ctx.beginPath();
      ctx.strokeStyle = S.isPlaying ? 'rgba(232,255,0,0.5)' : 'rgba(232,255,0,0.15)';
      ctx.lineWidth = 1.5;
      for (let x = 0; x < W; x++) {
        const t = x / W;
        const y = H/2 + Math.sin(t * Math.PI * 4 + ph) * (S.isPlaying ? H * 0.28 : H * 0.06);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (mode === 'dots') {
      const bc = 48;
      for (let i = 0; i < bc; i++) {
        const target = S.isPlaying
          ? Math.abs(Math.sin(i / bc * Math.PI * 3 + ph)) * 0.65
          : Math.abs(Math.sin(i / bc * Math.PI * 2 + ph)) * 0.15;
        smoothed[i] += (target - smoothed[i]) * 0.1;
        const x = (i / bc) * W + W / bc / 2;
        const y = H/2 - smoothed[i] * H * 0.4;
        const r = 2 + smoothed[i] * 3;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(232,255,0,${0.2 + smoothed[i] * 0.5})`;
        ctx.fill();
      }
    } else {
      // bars / mirror — idle bars
      const bc = 48, bw = W / bc;
      for (let i = 0; i < bc; i++) {
        const target = S.isPlaying
          ? (Math.abs(Math.sin(i / bc * Math.PI * 3 + ph)) * 0.65 +
             Math.abs(Math.sin(i / bc * Math.PI * 7 + ph * 1.3)) * 0.35)
          : Math.abs(Math.sin(i / bc * Math.PI * 2 + ph)) * 0.2;
        smoothed[i] += (target - smoothed[i]) * (S.isPlaying ? 0.15 : 0.05);
        const h = smoothed[i] * H;
        const g = ctx.createLinearGradient(0, H, 0, H - h);
        g.addColorStop(0, S.isPlaying ? 'rgba(232,255,0,0.8)' : 'rgba(232,255,0,0.15)');
        g.addColorStop(1, S.isPlaying ? 'rgba(150,255,200,0.4)' : 'rgba(232,255,0,0.05)');
        ctx.fillStyle = g;
        if (mode === 'mirror') {
          // mirror: draw from center up and down
          const hh = h / 2;
          ctx.fillRect(i * bw + 0.5, H/2 - hh, bw - 1.5, hh);
          ctx.fillRect(i * bw + 0.5, H/2, bw - 1.5, hh);
        } else {
          ctx.fillRect(i * bw + 0.5, H - h, bw - 1.5, h);
          if (S.isPlaying && h > 3) {
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.fillRect(i * bw + 0.5, H - h - 1.5, bw - 1.5, 1.5);
          }
        }
      }
    }
    ph += S.isPlaying ? 0.18 : 0.025;
  }
  frame();
}

function initLiveMiniVis() {
  if (miniAnimId) cancelAnimationFrame(miniAnimId);
  const ctx = miniCanvas.getContext('2d');
  let smoothed  = new Float32Array(48).fill(0);
  let peaks     = new Float32Array(48).fill(0);
  let peakDecay = new Float32Array(48).fill(0);
  let waveSm    = new Float32Array(256).fill(128);

  function frame() {
    miniAnimId = requestAnimationFrame(frame);
    if (!S.analyser) { initIdleMiniVis(); return; }
    const W = miniCanvas.width, H = miniCanvas.height;
    const mode = VIS_MODES[currentVisMode];
    ctx.clearRect(0, 0, W, H);

    if (mode === 'scope' || mode === 'wave') {
      // Time-domain waveform
      const timeDomain = new Uint8Array(S.analyser.fftSize);
      S.analyser.getByteTimeDomainData(timeDomain);
      ctx.beginPath();
      const accent = mode === 'scope' ? 'rgba(80,255,200,0.85)' : 'rgba(232,255,0,0.75)';
      ctx.strokeStyle = accent;
      ctx.lineWidth = mode === 'scope' ? 1 : 1.5;
      const step = timeDomain.length / W;
      for (let x = 0; x < W; x++) {
        const idx  = Math.floor(x * step);
        const v    = (timeDomain[idx] / 128.0) - 1.0;
        const y    = (v * H * 0.42) + H / 2;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (mode === 'scope') {
        // center line
        ctx.strokeStyle = 'rgba(80,255,200,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
      }
    } else if (mode === 'dots') {
      const raw = new Uint8Array(S.analyser.frequencyBinCount);
      S.analyser.getByteFrequencyData(raw);
      const bc = 48;
      for (let i = 0; i < bc; i++) {
        const idx = Math.floor(i / bc * raw.length * 0.75);
        const target = raw[idx] / 255;
        smoothed[i] += (target - smoothed[i]) * 0.22;
        const x = (i / bc) * W + W / bc / 2;
        const y = H/2 - smoothed[i] * H * 0.4;
        const r = 1.5 + smoothed[i] * 4;
        const a = 0.3 + smoothed[i] * 0.7;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
        g.addColorStop(0, `rgba(232,255,0,${a})`);
        g.addColorStop(1, `rgba(80,255,200,0)`);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        // mirror dot below center
        const y2 = H/2 + smoothed[i] * H * 0.4;
        const g2 = ctx.createRadialGradient(x, y2, 0, x, y2, r * 2);
        g2.addColorStop(0, `rgba(150,255,200,${a * 0.6})`);
        g2.addColorStop(1, `rgba(80,255,200,0)`);
        ctx.beginPath();
        ctx.arc(x, y2, r * 0.7, 0, Math.PI * 2);
        ctx.fillStyle = g2;
        ctx.fill();
      }
    } else {
      // bars / mirror
      const raw = new Uint8Array(S.analyser.frequencyBinCount);
      S.analyser.getByteFrequencyData(raw);
      const bc = 48, bw = W / bc;

      for (let i = 0; i < bc; i++) {
        const idx = Math.floor(i / bc * raw.length * 0.75);
        const target = raw[idx] / 255;
        smoothed[i] += (target - smoothed[i]) * 0.22;
        const h = smoothed[i] * H;
        if (peaks[i] < h) { peaks[i] = h; peakDecay[i] = 0; }
        else { peakDecay[i] += 0.4; peaks[i] = Math.max(0, peaks[i] - peakDecay[i] * 0.012); }

        const a = 0.4 + smoothed[i] * 0.6;
        const g = ctx.createLinearGradient(0, H, 0, H - h);
        g.addColorStop(0, `rgba(232,255,0,${a})`);
        g.addColorStop(0.7, `rgba(180,255,120,${a * 0.7})`);
        g.addColorStop(1, `rgba(80,255,200,${a * 0.4})`);
        ctx.fillStyle = g;

        if (mode === 'mirror') {
          const hh = h / 2;
          ctx.fillRect(i * bw + 0.5, H/2 - hh, bw - 1.5, hh);
          ctx.fillRect(i * bw + 0.5, H/2, bw - 1.5, hh);
          if (peaks[i] > 2) {
            ctx.fillStyle = `rgba(255,255,255,${0.4 + smoothed[i] * 0.5})`;
            ctx.fillRect(i * bw + 0.5, H/2 - peaks[i]/2 - 1, bw - 1.5, 1.5);
          }
        } else {
          ctx.fillRect(i * bw + 0.5, H - h, bw - 1.5, h);
          if (peaks[i] > 2) {
            ctx.fillStyle = `rgba(255,255,255,${0.5 + smoothed[i] * 0.5})`;
            ctx.fillRect(i * bw + 0.5, H - peaks[i] - 1.5, bw - 1.5, 1.5);
          }
        }
      }
    }
  }
  frame();
}

// NOTE: AudioContext MediaElementSource is intentionally DISABLED for local file:// playback.
// Connecting a MediaElementSource to a file:// URL triggers CORS errors in Chromium,
// which silently mutes the audio. The visualizer uses a simulated animation instead.
// If serving from http://localhost, you can re-enable the analyser connection below.
function ensureAudioCtx() {
  try {
    if (!S.audioCtx) {
      S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (S.audioCtx.state === 'suspended') {
      S.audioCtx.resume().catch(e => console.warn('[MACAN] AudioCtx resume:', e));
    }
    // Analyser connection disabled — see note above
    // Uncomment below only if running on http://localhost:
    /*
    if (!S.analyser) {
      S.analyser = S.audioCtx.createAnalyser();
      S.analyser.fftSize = 256;
    }
    if (S.srcNode) { try { S.srcNode.disconnect(); } catch(e){} }
    S.srcNode = S.audioCtx.createMediaElementSource(mediaEl);
    S.srcNode.connect(S.analyser);
    S.analyser.connect(S.audioCtx.destination);
    initLiveMiniVis();
    */
  } catch(e) { console.warn('[MACAN] AudioCtx init error:', e); }
}

// ─── AUDIO / VIDEO EVENTS ─────────────────────────────────────
function setupAudioEvents() {
  audio.addEventListener('timeupdate',    onTimeUpdate);
  audio.addEventListener('loadedmetadata',onMeta);
  audio.addEventListener('ended',         onEnded);
  audio.addEventListener('play',          () => onPlayState(true));
  audio.addEventListener('pause',         () => onPlayState(false));
  audio.addEventListener('canplay',       () => console.log('[MACAN] Audio: canplay fired'));
  audio.addEventListener('error', e => {
    const err = audio.error;
    if (!err) return;
    // Suppress spurious "Empty src" errors fired when src is cleared intentionally
    if (!audio.src || audio.src === window.location.href) return;
    if (err.message && err.message.toLowerCase().includes('empty')) return;
    const codes = {1:'ABORTED',2:'NETWORK',3:'DECODE ERROR',4:'FORMAT NOT SUPPORTED'};
    const msg = codes[err.code] || `UNKNOWN (${err.code})`;
    console.warn('[MACAN] Audio error:', err.code, err.message);
    setStatus(`AUDIO ERROR — ${msg}`);
    onPlayState(false);
  });
}


// ─── CENTER OVERLAY FLASH ──────────────────────────────────────
// Only triggered by explicit user play/pause actions:
// nav bar play button, vc-play button, or spacebar.
// NOT triggered by mouse movement over the video.
let _centerOverlayTimer = null;
function flashCenterOverlay(state) {
  // Only flash when video is active
  if (!videoLayer.classList.contains('active')) return;

  const overlay  = document.getElementById('video-center-overlay');
  const vcenterBtn = document.getElementById('video-center-btn');
  if (!overlay) return;

  // Update icon to reflect new state
  const iconPlay  = document.getElementById('vcenter-icon-play');
  const iconPause = document.getElementById('vcenter-icon-pause');
  if (iconPlay && iconPause) {
    iconPlay.style.display  = state === 'play'  ? '' : 'none';
    iconPause.style.display = state === 'pause' ? '' : 'none';
  }

  // Show overlay then auto-hide after animation
  overlay.classList.add('vc-visible');
  clearTimeout(_centerOverlayTimer);

  if (vcenterBtn) {
    vcenterBtn.classList.remove('flash');
    void vcenterBtn.offsetWidth;
    vcenterBtn.classList.add('flash');
  }

  _centerOverlayTimer = setTimeout(() => {
    overlay.classList.remove('vc-visible');
    if (vcenterBtn) vcenterBtn.classList.remove('flash');
  }, 650);
}
let _vcFeedbackTimer = null;
function showVideoClickFeedback(state) {
  let el = document.getElementById('vc-click-feedback');
  if (!el) {
    el = document.createElement('div');
    el.id = 'vc-click-feedback';
    videoLayer.appendChild(el);
  }

  // Reset animation by removing and re-adding class
  el.className = '';
  el.innerHTML = state === 'play'
    ? '<svg width="52" height="52" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>'
    : '<svg width="52" height="52" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';

  clearTimeout(_vcFeedbackTimer);
  // Force reflow so animation restarts cleanly
  void el.offsetWidth;
  el.className = 'vc-click-feedback-show';

  _vcFeedbackTimer = setTimeout(() => {
    el.className = '';
  }, 600);
}

function setupVideoEvents() {
  video.addEventListener('timeupdate',    onTimeUpdate);
  video.addEventListener('loadedmetadata',onMeta);
  video.addEventListener('ended',         onEnded);
  video.addEventListener('play',          () => onPlayState(true));
  video.addEventListener('pause',         () => onPlayState(false));
  video.addEventListener('canplay',       () => console.log('[MACAN] Video: canplay fired'));
  video.addEventListener('error', e => {
    const err = video.error;
    if (!err) return;
    // Suppress spurious "Empty src" errors fired when src is cleared intentionally
    if (!video.src || video.src === window.location.href) return;
    if (err.message && err.message.toLowerCase().includes('empty')) return;
    const codes = {1:'ABORTED',2:'NETWORK',3:'DECODE ERROR',4:'FORMAT NOT SUPPORTED'};
    const msg = codes[err.code] || `UNKNOWN (${err.code})`;
    console.warn('[MACAN] Video error:', err.code, err.message);
    setStatus(`VIDEO ERROR — ${msg}`);
    onPlayState(false);
  });
}

// ─── SEEKBAR (main panel) — drag + click ──────────────────────
function setupSeekbar() {
  function getPercent(e) {
    const r = progressTrack.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }
  function applySeek(pct) {
    if (!S.duration || isNaN(S.duration)) return;
    activePlayer().currentTime = pct * S.duration;
  }
  function setFill(pct) {
    progressFill.style.width = (pct * 100) + '%';
    progressThumb.style.left  = (pct * 100) + '%';
  }

  progressBar.addEventListener('mousedown', e => {
    e.preventDefault();
    S.seekDragging = true;
    progressBar.classList.add('dragging');
    const pct = getPercent(e);
    setFill(pct);
  });

  window.addEventListener('mousemove', e => {
    if (!S.seekDragging) return;
    e.preventDefault();
    const pct = getPercent(e);
    setFill(pct);
    if(S.duration) timeCurrent.textContent = formatTime(pct * S.duration);
  });

  window.addEventListener('mouseup', e => {
    if (!S.seekDragging) return;
    S.seekDragging = false;
    progressBar.classList.remove('dragging');
    applySeek(getPercent(e));
  });

  // Click on the bar (no drag)
  progressBar.addEventListener('click', e => {
    applySeek(getPercent(e));
  });
}

// ─── VIDEO SEEKBAR — drag + click ─────────────────────────────
function setupVcSeekbar() {
  function getPercent(e) {
    const track = vcSeekbar.querySelector('.vc-seek-track');
    const r = track.getBoundingClientRect();
    let x = e.clientX - r.left;
    return Math.max(0, Math.min(1, x / r.width));
  }

  function applySeek(pct) {
    if (!S.duration || isNaN(S.duration)) return;
    video.currentTime = pct * S.duration;
  }
  
  function setFill(pct) {
    const p = (pct * 100) + '%';
    vcSeekFill.style.width = p;
    vcSeekThumb.style.left = p;
  }

  // Mouse Move untuk Hover Preview + Dragging
  vcSeekbar.addEventListener('mousemove', e => {
    const pct = getPercent(e);
    
    // 1. Logic Dragging (Bawaan lama)
    if (S.vcSeekDragging) {
       setFill(pct);
       if(S.duration) vcTimeCur.textContent = formatTime(pct * S.duration);
    }

    // 2. Logic Preview Tooltip (BARU)
    if (S.duration && S.currentIndex >= 0 && S.playlist[S.currentIndex].is_video) {
        showVideoPreview(e, pct);
    }
  });

  // Mouse Leave untuk sembunyikan preview
  vcSeekbar.addEventListener('mouseleave', () => {
     vcPreviewTooltip.style.display = 'none';
     if (!S.vcSeekDragging) hideVcControls();
  });

  vcSeekbar.addEventListener('mousedown', e => {
    e.preventDefault();
    S.vcSeekDragging = true;
    setFill(getPercent(e));
    pinVcControls(true);
  });

  window.addEventListener('mouseup', e => {
    if (!S.vcSeekDragging) return;
    S.vcSeekDragging = false;
    applySeek(getPercent(e));
    pinVcControls(false);
  });
  
  window.addEventListener('mousemove', e => {
     // Global mouse move khusus untuk dragging (bila cursor keluar bar)
     if (S.vcSeekDragging) {
        const pct = getPercent(e); // Note: getPercent perlu disesuaikan jika mouse keluar elemen, tapi versi simple ok
        setFill(pct);
     }
  });

  vcSeekbar.addEventListener('click', e => { applySeek(getPercent(e)); });
}

// ─── HELPER BARU: VIDEO PREVIEW ───
function showVideoPreview(e, pct) {
    // Tampilkan tooltip
    vcPreviewTooltip.style.display = 'flex';
    
    // Posisikan tooltip mengikuti mouse X
    // Kita butuh posisi relatif terhadap seekbar
    const trackRect = vcSeekbar.getBoundingClientRect();
    const tooltipX = e.clientX - trackRect.left;
    vcPreviewTooltip.style.left = tooltipX + 'px';

    const targetTime = pct * S.duration;
    vcPreviewTime.textContent = formatTime(targetTime);

    // Throttle request ke Python (max 1 request per 150ms agar tidak lag)
    const now = Date.now();
    if (S.previewThrottle && now - S.previewThrottle < 150) {
        return; 
    }
    S.previewThrottle = now;

    // Panggil Python API
    if (window.pywebview) {
        // Ambil path asli file video saat ini
        const currentTrack = S.playlist[S.currentIndex];
        
        pywebview.api.get_video_preview(currentTrack.path, targetTime)
            .then(base64Img => {
                if (base64Img) {
                    vcPreviewImg.style.display = 'block';
                    vcPreviewImg.src = base64Img;
                } else {
                    // Jika gagal (misal file tidak support), sembunyikan gambar, tampilkan jam saja
                    vcPreviewImg.style.display = 'none';
                }
            })
            .catch(err => console.error(err));
    }
}

// ─── VIDEO CONTROLS AUTOHIDE ──────────────────────────────────
function setupVideoControls() {
  const vcenterOverlay = document.getElementById('video-center-overlay');
  const vcenterBtn     = document.getElementById('video-center-btn');

  // ── Cursor auto-hide (CSS class based, affects all children) ──
  // Using a CSS class with !important on #video-layer and all descendants
  // is the only reliable way — inline style on the container is overridden
  // by child elements (video, overlays) that have their own cursor rules.
  const CURSOR_HIDE_DELAY = 3000; // ms — same as controls autohide

  function _showCursor() {
    videoLayer.classList.remove('cursor-hidden');
  }

  function _hideCursor() {
    // Only hide cursor when video layer is actually in fullscreen (active)
    if (videoLayer.classList.contains('active')) {
      videoLayer.classList.add('cursor-hidden');
    }
  }

  function _scheduleCursorHide() {
    clearTimeout(S.vcCursorTimer);
    S.vcCursorTimer = setTimeout(_hideCursor, CURSOR_HIDE_DELAY);
  }

  // Attach mousemove to videoLayer — show cursor + restart hide timer.
  // This listener is SEPARATE from showAllVcControls so cursor logic
  // does NOT interfere with the click handler below.
  videoLayer.addEventListener('mousemove', () => {
    _showCursor();
    _scheduleCursorHide();
  });

  // Restore cursor immediately when mouse leaves video area
  videoLayer.addEventListener('mouseleave', () => {
    _showCursor();
    clearTimeout(S.vcCursorTimer);
  });

  // Store helpers on S so hideVcControls / pinVcControls / closeVideo
  // can also control cursor state from outside this function's scope.
  S._showCursor       = _showCursor;
  S._hideCursor       = _hideCursor;
  S._scheduleCursorHide = _scheduleCursorHide;

  // ── Unified show/hide helpers ──────────────────────────────────
  // Both #video-controls AND #video-center-overlay are shown/hidden together.
  function showAllVcControls() {
    videoControls.style.opacity = '1';
    videoControls.style.pointerEvents = 'all';
    // NOTE: vcenterOverlay is intentionally NOT shown here.
    // It only appears via flashCenterOverlay() triggered by explicit play/pause actions.
    clearTimeout(S.vcHideTimer);
    S.vcHideTimer = setTimeout(hideVcControls, 3000);
  }

  // Controls autohide: mousemove on videoLayer triggers BOTH cursor show
  // (via the listener above) AND controls show (via this separate listener).
  // Two listeners on the same element is fine — they don't conflict.
  videoLayer.addEventListener('mousemove', showAllVcControls);

  videoLayer.addEventListener('mouseleave', () => {
    if (!S.vcSeekDragging) hideVcControls();
  });

  // ── Click anywhere on video area → play/pause ────────────────
  // Listen on videoLayer (always receives events regardless of overlay visibility).
  // Guard against clicks on #video-controls buttons so they don't double-fire.
  let _clickTimer = null;

  videoLayer.addEventListener('click', e => {
    // Ignore clicks on the controls bar (prev/play/next/seek/etc.)
    if (videoControls && videoControls.contains(e.target)) return;
    if (document.getElementById('macan-ctx-menu')) return;

    clearTimeout(_clickTimer);
    const wasPaused = video.paused;

    _clickTimer = setTimeout(() => {
      togglePlayPause();
      showVideoClickFeedback(wasPaused ? 'play' : 'pause');

      // Flash the center overlay for explicit click feedback
      flashCenterOverlay(wasPaused ? 'play' : 'pause');

      // Reset autohide timer so controls stay briefly after click
      showAllVcControls();
    }, 180);
  });

  // Double-click cancels the single-click timer (prevent accidental play/pause on dblclick)
  videoLayer.addEventListener('dblclick', () => clearTimeout(_clickTimer));
}

function hideVcControls() {
  if (S.vcSeekDragging) return;
  videoControls.style.opacity = '0';
  videoControls.style.pointerEvents = 'none';
  // Hide cursor together with controls
  if (S._hideCursor) S._hideCursor();
}

function pinVcControls(on) {
  if (on) {
    videoControls.classList.add('pinned');
    // Show cursor and freeze hide timer during drag
    if (S._showCursor) S._showCursor();
    clearTimeout(S.vcCursorTimer);
  } else {
    videoControls.classList.remove('pinned');
    // Restart hide timer after drag ends
    if (S._scheduleCursorHide) S._scheduleCursorHide();
  }
}

// ─── LOAD & PLAY ──────────────────────────────────────────────
async function loadTrack(index, autoplay = true) {
  if (index < 0 || index >= S.playlist.length) return;

  // Fade out current track before switching
  if (S.fadeEnabled && S.isPlaying && S._fadeGain && audioContext) {
    await new Promise(resolve => {
      doFadeOut(resolve);
    });
  }

  S.currentIndex = index;
  const track = S.playlist[index];
  const isVid  = track.is_video;

  // Record play count for smart playlist
  if (track.path && window.SmartPlaylist) SmartPlaylist.recordPlay(track.path);

  // Record play for achievements
  if (window.AchievementSystem) {
    AchievementSystem.record('totalPlays');
    if (track.is_video) AchievementSystem.record('videosPlayed');
  }

  // Stop both players first
  audio.pause(); video.pause();

  // Reset src cleanly
  audio.src = '';
  video.src = '';

  updateTrackInfo(track);
  updatePlaylistHighlight(index);
  setStatus(`LOADING — ${track.name}`);

  // Update mini player title if it's currently showing
  if (MiniPlayer.isActive()) MiniPlayer.updateMiniInfo();

  // Apply ReplayGain normalization gain
  applyNormalization(track);

  // Start with whatever URL was stored in the playlist
  let srcUrl = track.url || '';

  if (pw() && track.path) {
    try {
      const resolvedUrl = await pywebview.api.get_file_url(track.path);
      if (resolvedUrl) {
        srcUrl = resolvedUrl;
        track.url = resolvedUrl;
      }
    } catch(e) {
      console.warn('[MACAN] get_file_url failed, using stored url:', e);
    }
  }

  if (!srcUrl) {
    setStatus('ERROR — NO VALID URL FOR TRACK');
    return;
  }

  if (isVid) {
    videoLayer.classList.add('active');
    $('main-layout').style.display = 'none';
    $('vc-title-text').textContent = track.name.toUpperCase();
    video.src = srcUrl;
    video.load();
    if (autoplay) doPlay(video);
    // Load .srt subtitle if available
    _loadSubtitle(track.path || '');
  } else {
    _clearSubtitleTracks();
    videoLayer.classList.remove('active');
    $('main-layout').style.display = '';
    audio.src = srcUrl;
    audio.load();
    if (autoplay) doPlay(audio);
  }

  scheduleStateSave();
}

// ─── SUBTITLE (SRT) SUPPORT ───────────────────────────────────

/** Convert SRT text → WebVTT text (browser-native format). */
function _srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')  // SRT comma → VTT dot
    .trim();
}

/** Remove any existing <track> elements from the video element. */
function _clearSubtitleTracks() {
  [...video.querySelectorAll('track')].forEach(t => t.remove());
  const btn = $('vc-subtitle');
  if (btn) btn.style.display = 'none';
}

/**
 * Try to find a .srt file for the current video path.
 * If found, convert SRT→VTT in-memory, create a Blob URL, and
 * inject a <track> element into the video player.
 */
async function _loadSubtitle(videoPath) {
  _clearSubtitleTracks();
  if (!pw() || !videoPath) return;

  try {
    const srtUrl = await pywebview.api.get_subtitle_url(videoPath);
    if (!srtUrl) return;  // no .srt found — silently ignore

    // Fetch the raw SRT text via the local media server
    const resp = await fetch(srtUrl);
    if (!resp.ok) return;
    const srtText = await resp.text();

    // Convert to WebVTT and create an in-memory Blob URL
    const vttText = _srtToVtt(srtText);
    const blob    = new Blob([vttText], { type: 'text/vtt' });
    const blobUrl = URL.createObjectURL(blob);

    // Inject <track> into the <video> element
    const trackEl    = document.createElement('track');
    trackEl.kind     = 'subtitles';
    trackEl.label    = 'Subtitle';
    trackEl.srclang  = 'id';
    trackEl.src      = blobUrl;
    trackEl.default  = true;
    video.appendChild(trackEl);

    // Enable the track and raise subtitle position off the bottom edge
    trackEl.addEventListener('load', () => {
      const tt = video.textTracks[0];
      if (!tt) return;
      tt.mode = 'showing';
      // Shift each cue upward: line -4 = 4 lines from bottom (clears the control bar)
      for (const cue of tt.cues) {
        cue.line        = -4;   // negative = counted from bottom
        cue.snapToLines = true;
      }
    });

    // Show the CC toggle button
    const btn = $('vc-subtitle');
    if (btn) {
      btn.style.display = '';
      btn.classList.add('active');
      btn.title = 'Subtitles ON — click to toggle';
    }

    console.log(`[MACAN] Subtitle loaded: ${videoPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '.srt')}`);
  } catch (e) {
    console.warn('[MACAN] _loadSubtitle error:', e);
  }
}

// Subtitle CC toggle button — wired directly (no DOMContentLoaded needed,
// the element already exists when this script runs at bottom of <body>).
(function _initSubtitleToggle() {
  const btn = $('vc-subtitle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const t = video.textTracks[0];
    if (!t) return;
    if (t.mode === 'showing') {
      t.mode = 'hidden';
      btn.classList.remove('active');
      btn.title = 'Subtitles OFF — click to toggle';
    } else {
      t.mode = 'showing';
      btn.classList.add('active');
      btn.title = 'Subtitles ON — click to toggle';
    }
  });
})();

// ─── PLAYBACK ─────────────────────────────────────────────────

function doPlay(player) {
  // Always try to resume AudioContext (browser policy)
  if (S.audioCtx && S.audioCtx.state === 'suspended') {
    S.audioCtx.resume().catch(e => console.warn('[MACAN] AudioCtx resume:', e));
  }
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }

  // Guard: don't try to play if src is empty
  if (!player.src || player.src === window.location.href) {
    console.warn('[MACAN] doPlay called with no src set');
    return;
  }

  const playPromise = player.play();
  if (playPromise !== undefined) {
    playPromise.then(() => {
      setStatus(`PLAYING — ${S.playlist[S.currentIndex]?.name || ''}`);
      // Fade in after playback starts
      if (S.fadeEnabled && S._fadeGain && audioContext && !player.isVideo) {
        doFadeIn();
      }
      // FIX: Re-push SMTC metadata + playing state AFTER play() resolves.
      // updateTrackInfo() fires before play() so mediaSession.playbackState
      // may still be 'paused' or stale from the previous track. Refreshing
      // here guarantees Windows SMTC (taskbar thumbnail, lock screen) shows
      // the correct track name and playing indicator immediately.
      if ('mediaSession' in navigator) {
        const track = S.playlist[S.currentIndex];
        if (track) {
          navigator.mediaSession.playbackState = 'playing';
          // Only re-push full metadata if title has changed (avoids redundant
          // blob URL creation on resume-after-pause of the same track).
          const currentTitle = navigator.mediaSession.metadata?.title;
          if (currentTitle !== (track.name || '—')) {
            updateMediaSession(track, track.cover_art || null);
          }
          syncMediaSessionState();
        }
      }
    }).catch(err => {
      if (err.name === 'AbortError') {
        console.log('[MACAN] Play aborted (track changed), ignoring.');
        return;
      }
      console.warn('[MACAN] Playback failed:', err.name, err.message);
      if (err.name === 'NotAllowedError') {
        setStatus('CLICK PLAY TO START (autoplay blocked)');
      } else if (err.name === 'NotSupportedError') {
        setStatus('ERROR — FORMAT NOT SUPPORTED: ' + (S.playlist[S.currentIndex]?.ext || ''));
      } else {
        setStatus(`PLAYBACK ERROR — ${err.message}`);
      }
      onPlayState(false);
    });
  }
}

// ─── FADE IN/OUT ──────────────────────────────────────────────
function doFadeIn() {
  if (!S._fadeGain || !audioContext) return;
  const now = audioContext.currentTime;
  const dur = S.fadeDuration / 1000;
  S._fadeGain.gain.cancelScheduledValues(now);
  S._fadeGain.gain.setValueAtTime(0.0001, now);
  S._fadeGain.gain.exponentialRampToValueAtTime(1.0, now + dur);
}

function doFadeOut(callback) {
  if (!S._fadeGain || !audioContext) { if (callback) callback(); return; }
  const now = audioContext.currentTime;
  const dur = S.fadeDuration / 1000;
  S._fadeGain.gain.cancelScheduledValues(now);
  S._fadeGain.gain.setValueAtTime(S._fadeGain.gain.value || 1.0, now);
  S._fadeGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  setTimeout(() => {
    if (callback) callback();
    // Reset gain so next fade-in works
    if (S._fadeGain) S._fadeGain.gain.setValueAtTime(1.0, audioContext.currentTime);
  }, S.fadeDuration + 50);
}

// ─── REPLAY GAIN / NORMALIZATION ──────────────────────────────
function applyNormalization(track) {
  if (!S._gainNode || !audioContext) return;
  if (!S.normEnabled || track.is_video) {
    S._gainNode.gain.setValueAtTime(1.0, audioContext.currentTime);
    return;
  }
  const rgDb = (track.replaygain_db !== undefined && track.replaygain_db !== null)
    ? parseFloat(track.replaygain_db) : 0;
  // Convert dB gain to linear multiplier
  const linearGain = Math.pow(10, rgDb / 20);
  // Clamp to prevent clipping (max 4x = +12dB)
  const clamped = Math.min(Math.max(linearGain, 0.1), 4.0);
  S._gainNode.gain.setValueAtTime(clamped, audioContext.currentTime);
  if (rgDb !== 0) {
    setStatus(`NORMALIZATION: ${rgDb > 0 ? '+' : ''}${rgDb.toFixed(1)} dB`);
  }
}

// ─── TRACK INFO UPDATE ────────────────────────────────────────
function updateTrackInfo(track) {
  // Scrolling title
  trackTitle.classList.remove('scrolling');
  trackTitle.textContent = track.name;
  void trackTitle.offsetWidth;
  if (trackTitle.scrollWidth > trackTitle.parentElement.offsetWidth - 20) {
    trackTitle.classList.add('scrolling');
  }

  // Artist (from metadata — if empty fall back to 'UNKNOWN ARTIST')
  trackArtist.textContent = track.artist ? track.artist.toUpperCase() : 'UNKNOWN ARTIST';

  trackFormat.textContent = track.ext || '—';
  trackType.textContent   = track.is_video ? 'VIDEO' : 'AUDIO';
  trackType.style.color   = track.is_video ? 'var(--red)' : '';

  const marqueeStr = track.artist
    ? `▶  ${track.artist.toUpperCase()} — ${track.name.toUpperCase()}  `
    : `▶  ${track.name.toUpperCase()}  `;
  marqueeText.textContent  = marqueeStr;
  marqueeClone.textContent = marqueeStr;
  marqueeTrack.style.animationDuration = Math.max(10, marqueeStr.length*0.30)+'s';

  // Clear old art
  albumArt.src = '';
  albumArt.classList.remove('loaded');
  artPlaceholder.classList.remove('hidden');
  artBlurBg.style.opacity = '0';

  // Try to get cover art: use already-fetched art first, then embedded, then online
  if (pw() && !track.is_video) {
    if (track.cover_art) {
      // Art already available (from Python _build_track_meta or previous session)
      applyArt(track.cover_art);
    } else {
      pywebview.api.get_cover_art(track.path).then(data => {
        if (data) {
          applyArt(data);
        } else {
          // Try online fallback (fires async; onOnlineArtReady callback handles result)
          pywebview.api.get_cover_art_with_online_fallback(track.path).then(online => {
            if (online) applyArt(online);
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  } else if (track.is_video) {
    // For video tracks: use cached thumbnail as cover art
    const cachedThumb = track.cover_art || track.video_thumb || videoThumbCache.get(track.path) || thumbCache.get(track.path);
    if (cachedThumb) {
      applyArt(cachedThumb);
    } else if (pw()) {
      // Fetch thumbnail async and use as cover art
      pywebview.api.get_video_thumbnail(track.path).then(thumb => {
        if (thumb) {
          track.video_thumb = thumb;
          track.cover_art   = thumb;
          videoThumbCache.set(track.path, thumb);
          thumbCache.set(track.path, thumb);
          applyArt(thumb);
          _persistArtToServer(track.path, thumb, true);
        }
      }).catch(() => {});
    }
  }

  // Auto-fetch lyrics if panel is open
  if (S.lyricsOpen && !track.is_video) {
    fetchLyrics(track);
  }

  // Update SMTC immediately with known info (art will follow via applyArt).
  // Set playbackState to 'none' temporarily to signal to Windows SMTC that
  // the track has changed — doPlay() will push 'playing' once resolved.
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = 'none'; } catch (_) {}
  }
  updateMediaSession(track, track.cover_art || null);
}

function applyArt(src) {
  albumArt.src = src;
  albumArt.onload = () => {
    albumArt.classList.add('loaded');
    artPlaceholder.classList.add('hidden');
    artBlurBg.style.backgroundImage = `url(${src})`;
    artBlurBg.style.opacity = '0.38';
  };

  // Cache art into track object so playlist thumbnails stay updated
  if (S.currentIndex >= 0 && S.playlist[S.currentIndex]) {
    const track = S.playlist[S.currentIndex];
    const wasNew = !track.cover_art;
    track.cover_art = src;
    thumbCache.set(track.path, src);

    // Update SMTC with newly received cover art
    updateMediaSession(track, src);
    // FIX: placeholder is a <div class="pl-thumb-placeholder">, not an img
    const activeItem = playlistList.querySelector(`.pl-item[data-index="${S.currentIndex}"]`);
    if (activeItem) {
      const placeholder = activeItem.querySelector('.pl-thumb-placeholder');
      if (placeholder) {
        const img = document.createElement('img');
        img.className = 'pl-thumb';
        img.src = src; img.alt = ''; img.draggable = false; img.loading = 'lazy';
        placeholder.replaceWith(img);
      }
    }
    // Persist newly-fetched art to Python so clear+reload and restarts keep it
    if (wasNew) _persistArtToServer(track.path, src, false);
  }
}

// ─── PLAY STATE ───────────────────────────────────────────────
function onPlayState(playing) {
  S.isPlaying = playing;
  iconPlay.style.display  = playing ? 'none'  : 'block';
  iconPause.style.display = playing ? 'block' : 'none';
  vcIconPlay.style.display  = playing ? 'none'  : 'block';
  vcIconPause.style.display = playing ? 'block' : 'none';

  const npp = document.getElementById('now-playing-panel');
  if (playing) npp.classList.add('playing');
  else         npp.classList.remove('playing');

  // Sync center overlay icon (shows the action that WILL happen on click:
  // pause icon when playing, play icon when paused)
  const cpPlay  = document.getElementById('vcenter-icon-play');
  const cpPause = document.getElementById('vcenter-icon-pause');
  if (cpPlay)  cpPlay.style.display  = playing ? 'none'  : 'block';
  if (cpPause) cpPause.style.display = playing ? 'block' : 'none';

  // Sync SMTC play state
  syncMediaSessionState();

  // Sync mini player play state
  MiniPlayer.syncMiniPlayState(playing);

  // ── Listen Statistics & Achievements ──────────────────────
  if (window.ListenStats) {
    if (playing) ListenStats.startTracking();
    else         ListenStats.stopTracking();
  }
}

// ─── METADATA / TIME ──────────────────────────────────────────
function onMeta() {
  const p = activePlayer();
  S.duration = p.duration;

  // Fix for Infinity/NaN durations (streams or corrupt files)
  if (!Number.isFinite(S.duration)) S.duration = 0;

  const str = formatTime(S.duration);
  timeTotal.textContent   = str;
  vcTimeTotal.textContent = str;
  if (S.currentIndex >= 0 && S.playlist[S.currentIndex]) {
    S.playlist[S.currentIndex].duration     = Math.floor(S.duration);
    S.playlist[S.currentIndex].duration_str = str;
    updatePlaylistMeta();
  }

  // FIX: Consume the pending seek that was stored in _doStateRestore().
  // By handling it here (inside loadedmetadata) we guarantee the duration
  // is known and avoid the race between addEventListener+load order.
  if (S._seekPending) {
    const { position } = S._seekPending;
    S._seekPending = null;
    if (S.duration > 0 && position > 0 && position < S.duration) {
      p.currentTime = position;
      const pct = position / S.duration;
      progressFill.style.width = (pct * 100) + '%';
      progressThumb.style.left = (pct * 100) + '%';
      timeCurrent.textContent  = formatTime(position);
    }
  }
}

function onTimeUpdate() {
  if (S.seekDragging || S.vcSeekDragging) return;
  const p   = activePlayer();
  const cur = p.currentTime;
  
  // Guard against division by zero
  const pct = (S.duration > 0) ? cur / S.duration : 0;
  const str = formatTime(cur);

  progressFill.style.width  = (pct*100)+'%';
  progressThumb.style.left  = (pct*100)+'%';
  timeCurrent.textContent   = str;
  vcSeekFill.style.width    = (pct*100)+'%';
  vcSeekThumb.style.left    = (pct*100)+'%';
  vcTimeCur.textContent     = str;

  // Sync lyrics highlight if panel is open
  if (S.lyricsOpen && S.lyricsData?.is_synced) {
    highlightCurrentLyricLine();
  }

  // FIX: Periodic state save every ~10s using wall-clock time (not
  // currentTime which can be 0 after a track change) to prevent
  // triggering a save while a previous one is still in-flight.
  const now = Date.now();
  if (!S._lastStateSaveWallMs || now - S._lastStateSaveWallMs > 10000) {
    if (!S._saveLock) {
      S._lastStateSaveWallMs = now;
      scheduleStateSave();
    }
  }

  // Sync SMTC position (throttled via ~1s wall-clock)
  if (!S._smtcSyncMs || now - S._smtcSyncMs > 1000) {
    S._smtcSyncMs = now;
    syncMediaSessionState();
  }
}

// ─── TRACK END ────────────────────────────────────────────────
function onEnded() {
  if (S.repeatMode === 'one') {
    const p = activePlayer(); p.currentTime = 0; doPlay(p); return;
  }
  if (S.isShuffle || S.repeatMode === 'all') { nextTrack(); return; }
  if (S.currentIndex < S.playlist.length - 1) { nextTrack(); return; }
  onPlayState(false);
  setStatus('QUEUE COMPLETE');
}

// ─── CONTROLS ─────────────────────────────────────────────────
function togglePlayPause() {
  if (S.playlist.length === 0) return;
  if (S.currentIndex < 0) { loadTrack(0); return; }

  // Initialize/resume AudioContext on user gesture (required by browser policy)
  ensureAudioCtx();

  const p = activePlayer();
  if (p.paused) doPlay(p);
  else p.pause();
}

function prevTrack() {
  if (!S.playlist.length) return;
  if (activePlayer().currentTime > 3) { activePlayer().currentTime = 0; return; }
  const next = (S.currentIndex - 1 + S.playlist.length) % S.playlist.length;
  loadTrack(next);
}

function nextTrack() {
  if (!S.playlist.length) return;
  let next;
  if (S.isShuffle) {
    const pool = [...Array(S.playlist.length).keys()].filter(i=>i!==S.currentIndex);
    next = pool.length ? pool[Math.floor(Math.random()*pool.length)] : S.currentIndex;
  } else {
    next = S.currentIndex + 1;
    if (next >= S.playlist.length) next = S.repeatMode==='all' ? 0 : S.playlist.length-1;
  }
  loadTrack(next);
}

function toggleShuffle() {
  S.isShuffle = !S.isShuffle;
  $('btn-shuffle').classList.toggle('active', S.isShuffle);
  setStatus(S.isShuffle ? 'SHUFFLE ON' : 'SHUFFLE OFF');
  scheduleStateSave();
}

function cycleRepeat() {
  const modes = ['none','all','one'];
  S.repeatMode = modes[(modes.indexOf(S.repeatMode)+1)%3];
  $('btn-repeat').classList.toggle('active', S.repeatMode !== 'none');
  repeatBadge.style.display = S.repeatMode==='one' ? 'flex' : 'none';
  setStatus({none:'REPEAT OFF',all:'REPEAT ALL',one:'REPEAT ONE'}[S.repeatMode]);
  scheduleStateSave();
}

// ─── STATE PERSISTENCE ────────────────────────────────────────
// FIX: Two-level guard against race conditions in state saving:
//   1. Debounce: collapse rapid successive changes into one write.
//   2. _saveLock: if a save is already in-flight (awaiting Python),
//      the next debounce fires after it completes, never in parallel.
function scheduleStateSave() {
  clearTimeout(S._stateSaveTimer);
  S._stateSaveTimer = setTimeout(persistAppState, 800);
}

async function persistAppState() {
  if (!pw()) return;
  // FIX: Skip if a save is already in-flight — reschedule for after it lands.
  if (S._saveLock) {
    clearTimeout(S._stateSaveTimer);
    S._stateSaveTimer = setTimeout(persistAppState, 400);
    return;
  }
  S._saveLock = true;
  try {
    const state = {
      currentIndex:  S.currentIndex,
      seekPosition:  S.currentIndex >= 0 ? (activePlayer().currentTime || 0) : 0,
      volume:        S.volume,
      isShuffle:     S.isShuffle,
      repeatMode:    S.repeatMode,
      fadeEnabled:   S.fadeEnabled,
      fadeDuration:  S.fadeDuration,
      normEnabled:   S.normEnabled,
      // equalizerUI is always available (created at script load against the stub).
      // equalizer (real Web Audio) may still be null if user hasn't played yet —
      // fall back to stub values so we don't overwrite a valid saved EQ state.
      eqBands:  equalizer ? equalizer.getCurrentValues()
                           : (_eqStub._pendingValues || S._pendingEqBands || null),
      eqPreset: equalizerUI.currentPreset || S._pendingEqPreset || 'Flat',
    };
    await pywebview.api.save_app_state(state);
  } catch(e) {
    console.warn('[MACAN] State save failed:', e);
  } finally {
    S._saveLock = false;
  }
}

function setVolume(val) {
  S.volume = parseInt(val);
  audio.volume = video.volume = S.volume / 100;
  if (S.volume > 0) S.isMuted = false;
  updateVolumeUI(S.volume);
  syncVcVolume(S.volume);
  scheduleStateSave();
}

function updateVolumeUI(val) {
  volumeVal.textContent = val;
  volumeSlider.value = val;
  volumeSlider.style.background =
    `linear-gradient(90deg, var(--accent) ${val}%, var(--elevated) ${val}%)`;
}

function syncVcVolume(val) {
  vcVolSlider.value = val;
  vcVolSlider.style.background =
    `linear-gradient(90deg, var(--accent) ${val}%, rgba(255,255,255,0.2) ${val}%)`;

  // Sync mini player volume
  MiniPlayer.syncMiniVolume(val);
}

function toggleMute() {
  S.isMuted = !S.isMuted;
  audio.muted = video.muted = S.isMuted;
  $('vol-icon-on').style.display  = S.isMuted ? 'none'  : 'block';
  $('vol-icon-off').style.display = S.isMuted ? 'block' : 'none';
  $('vc-vol-on').style.display    = S.isMuted ? 'none'  : 'block';
  $('vc-vol-off').style.display   = S.isMuted ? 'block' : 'none';
}

function closeVideo() {
  // If mini player is active, close it fully
  if (MiniPlayer.isActive()) {
    MiniPlayer.closeFromMini();
    return;
  }
  video.pause(); video.src = '';
  videoLayer.classList.remove('active');
  $('main-layout').style.display = '';
  onPlayState(false);
  setStatus('VIDEO CLOSED');
  // Always restore cursor when leaving fullscreen video
  if (S._showCursor) S._showCursor();
  clearTimeout(S.vcCursorTimer);
}

// ─── PLAYLIST ─────────────────────────────────────────────────
async function openFiles() {
  if (!pw()) { setStatus('pywebview required'); return; }
  setStatus('OPENING FILE DIALOG...');
  try {
    const paths = await pywebview.api.browse_files();
    if (paths?.length) {
      setStatus(`SCANNING ${paths.length} FILE(S)...`);
      await pywebview.api.add_tracks_stream(paths);
      // Rendering happens progressively via onTrackBatchReady
    } else { setStatus('NO FILES SELECTED'); }
  } catch(e) { console.error(e); setStatus('ERROR — SEE CONSOLE'); }
}

async function openFolder() {
  if (window.AchievementSystem) AchievementSystem.record('foldersOpened');
  if (!pw()) { setStatus('pywebview required'); return; }
  setStatus('SCANNING FOLDER...');
  try {
    const paths = await pywebview.api.browse_folder();
    if (paths?.length) {
      setStatus(`SCANNING ${paths.length} FILE(S)...`);
      await pywebview.api.add_tracks_stream(paths);
      // Rendering happens progressively via onTrackBatchReady
    } else { setStatus('NO MEDIA FOUND'); }
  } catch(e) { console.error(e); setStatus('ERROR — SEE CONSOLE'); }
}

// ── Streaming batch receiver — called from Python via evaluate_js ──────────
// Receives batches of 12 tracks as Python finishes scanning them,
// appends to S.playlist, and re-renders only the new rows (not the full list).
window.onTrackBatchReady = function(tracks, done) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    if (done) {
      _seedThumbCache(S.playlist);
      updatePlaylistMeta();
      if (S.currentIndex < 0 && S.playlist.length > 0) loadTrack(0);
      setStatus(`LOADED ${S.playlist.length} TRACK(S)`);
    }
    return;
  }

  // Dedup against existing playlist (Python already deduped but be safe)
  const known = new Set(S.playlist.map(t => t.path));
  const newTracks = tracks.filter(t => !known.has(t.path));
  if (!newTracks.length) {
    if (done) { updatePlaylistMeta(); }
    return;
  }

  const startIdx = S.playlist.length;
  S.playlist.push(...newTracks);

  // Update cached total duration incrementally (no full reduce needed)
  for (const t of newTracks) _cachedTotalDuration += (t.duration || 0);

  // Seed caches for the new tracks only
  for (const t of newTracks) {
    if (t.cover_art)    thumbCache.set(t.path, t.cover_art);
    if (t.video_thumb)  videoThumbCache.set(t.path, t.video_thumb);
  }

  // Append only the new rows (no full re-render)
  _appendPlaylistRows(newTracks, startIdx);

  playlistEmpty.classList.add('hidden');
  plCount.textContent = `${S.playlist.length} TRACK${S.playlist.length !== 1 ? 'S' : ''}`;

  if (done) {
    updatePlaylistMeta();
    if (S.currentIndex < 0 && S.playlist.length > 0) loadTrack(0);
    setStatus(`LOADED ${S.playlist.length} TRACK(S)`);
  } else {
    setStatus(`LOADING... ${S.playlist.length} tracks`);
  }
};

async function removeTrack(path, e) {
  e.stopPropagation();
  if (pw()) {
    S.playlist = await pywebview.api.remove_track(path);
  } else {
    S.playlist = S.playlist.filter(t => t.path !== path);
  }
  if (S.currentIndex >= S.playlist.length) S.currentIndex = S.playlist.length - 1;
  _rebuildTotalDuration();
  renderPlaylist(); updatePlaylistMeta();
}

async function clearPlaylist() {
  audio.pause(); audio.src = '';
  video.pause(); video.src = '';
  videoLayer.classList.remove('active');
  $('main-layout').style.display = '';
  S.currentIndex = -1; onPlayState(false);
  if (pw()) await pywebview.api.clear_playlist();
  S.playlist = [];
  _cachedTotalDuration = 0;
  renderPlaylist(); updatePlaylistMeta();

  trackTitle.textContent = '—';
  trackArtist.textContent = 'UNKNOWN ARTIST';
  trackFormat.textContent = '—';
  trackType.textContent = 'AUDIO';
  progressFill.style.width = '0%';
  timeCurrent.textContent = '0:00';
  timeTotal.textContent = '0:00';
  albumArt.src = ''; albumArt.classList.remove('loaded');
  artPlaceholder.classList.remove('hidden');
  artBlurBg.style.opacity = '0';
  marqueeText.textContent = marqueeClone.textContent = '— SELECT A TRACK TO BEGIN PLAYBACK —';
  S.lyricsData = null;
  if (S.lyricsOpen) showLyricsIdle();
  setStatus('QUEUE CLEARED');
}

let filterQ = '';
let _filterTimer = null;
function filterPlaylist(q) {
  filterQ = q.trim().toLowerCase();
  clearTimeout(_filterTimer);
  _filterTimer = setTimeout(() => renderPlaylist(), 120); // 120ms debounce
}

// ─── DRAG-AND-DROP STATE ──────────────────────────────────────
const DND = {
  dragIndex:  -1,
  overIndex:  -1,
  indicator:  null,
};

function _buildPlaylistItem(track, realIdx) {
  const isActive = realIdx === S.currentIndex;
  const div = document.createElement('div');
  div.className = 'pl-item' + (isActive ? ' active' : '');
  div.dataset.index = realIdx;
  div.draggable = !filterQ;

  // ── thumbnail ──────────────────────────────────────────────
  // If art is already in cache/track object → render immediately.
  // Otherwise render a placeholder with data-lazy so _lazyThumbObserver
  // fetches it when the row scrolls into view (300px lookahead).
  let thumbHtml = '';
  if (track.is_video) {
    if (!track.video_thumb && videoThumbCache.has(track.path))
      track.video_thumb = videoThumbCache.get(track.path);

    if (track.video_thumb) {
      thumbHtml = `<img class="pl-thumb pl-thumb-video-img" src="${track.video_thumb}" alt="" loading="lazy" draggable="false">`;
    } else {
      // Lazy placeholder — observer will fetch when visible
      thumbHtml = `
        <div class="pl-thumb pl-thumb-placeholder pl-thumb-video"
             data-lazy="video" data-path="${esc(track.path)}" title="Video">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.6">
            <polygon points="23,7 16,12 23,17"/>
            <rect x="1" y="5" width="15" height="14" rx="2"/>
          </svg>
        </div>`;
    }
  } else {
    if (!track.cover_art && thumbCache.has(track.path))
      track.cover_art = thumbCache.get(track.path);
    if (track.cover_art && !thumbCache.has(track.path))
      thumbCache.set(track.path, track.cover_art);

    if (track.cover_art) {
      thumbHtml = `<img class="pl-thumb" src="${track.cover_art}" alt="" loading="lazy" draggable="false">`;
    } else {
      // Lazy placeholder — observer will fetch when visible
      thumbHtml = `
        <div class="pl-thumb pl-thumb-placeholder"
             data-lazy="audio" data-path="${esc(track.path)}" title="No art">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.35">
            <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
          </svg>
        </div>`;
    }
  }

  div.innerHTML = `
    <div class="pl-drag-handle" title="Drag to reorder">
      <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
        <circle cx="3" cy="2.5" r="1.5"/><circle cx="7" cy="2.5" r="1.5"/>
        <circle cx="3" cy="7"   r="1.5"/><circle cx="7" cy="7"   r="1.5"/>
        <circle cx="3" cy="11.5" r="1.5"/><circle cx="7" cy="11.5" r="1.5"/>
      </svg>
    </div>
    <div class="pl-idx">${realIdx + 1}</div>
    <div class="pl-playing-indicator"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>
    ${thumbHtml}
    <div class="pl-item-info">
      <span class="pl-item-name">${esc(track.name)}</span>
      <span class="pl-item-artist">${track.artist ? esc(track.artist) : ''}</span>
      <span class="pl-item-ext">${track.ext || ''}</span>
    </div>
    <span class="pl-item-duration">${track.duration_str || '--:--'}</span>
    <span class="pl-item-type ${track.is_video ? 'video' : ''}">
      ${track.is_video
        ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="margin-right:3px;opacity:.7"><polygon points="23,7 16,12 23,17"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>VIDEO'
        : 'AUDIO'}
    </span>
    <button class="pl-remove-btn" title="Remove">✕</button>`;

  div.querySelector('.pl-remove-btn').addEventListener('click', e => removeTrack(track.path, e));
  div.addEventListener('click', () => loadTrack(realIdx));
  div.addEventListener('dblclick', () => loadTrack(realIdx, true));
  div.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, track);
  });

  if (!filterQ) {
    div.addEventListener('dragstart', e => {
      DND.dragIndex = realIdx;
      div.classList.add('pl-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(realIdx));
      const ghost = div.cloneNode(true);
      ghost.style.cssText = 'position:fixed;top:-200px;left:0;width:300px;opacity:.8;pointer-events:none;';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 20, 20);
      setTimeout(() => ghost.remove(), 0);
    });
    div.addEventListener('dragend', () => {
      div.classList.remove('pl-dragging');
      _dndCleanup();
    });
    div.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (DND.dragIndex === realIdx) return;
      const rect = div.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      const targetIdx = after ? realIdx + 1 : realIdx;
      if (DND.overIndex !== targetIdx) {
        DND.overIndex = targetIdx;
        _dndShowIndicator(div, after);
      }
    });
    div.addEventListener('dragleave', e => {
      if (!playlistList.contains(e.relatedTarget)) _dndCleanup(false);
    });
    div.addEventListener('drop', e => {
      e.preventDefault();
      if (DND.dragIndex < 0 || DND.dragIndex === DND.overIndex) { _dndCleanup(); return; }
      _doPlaylistReorder(DND.dragIndex, DND.overIndex);
      _dndCleanup();
    });
  }

  return div;
}

// Register all lazy placeholders in a container with the IntersectionObserver.
// Call AFTER the container is inserted into the live DOM.
function _observeLazyThumbs(container) {
  const obs = _getLazyObserver();
  container.querySelectorAll('.pl-thumb-placeholder[data-lazy]').forEach(el => {
    obs.observe(el);
  });
}

// Append only new rows to the list — used by streaming loader
function _appendPlaylistRows(tracks, startIdx) {
  const frag = document.createDocumentFragment();
  tracks.forEach((track, i) => {
    frag.appendChild(_buildPlaylistItem(track, startIdx + i));
  });
  playlistList.appendChild(frag);
  // Observe after insertion so IntersectionObserver has real layout positions
  _observeLazyThumbs(playlistList);
}

function renderPlaylist() {
  const list = filterQ
    ? S.playlist.filter(t => t.name.toLowerCase().includes(filterQ))
    : S.playlist;

  playlistEmpty.classList.toggle('hidden', list.length > 0);

  // Disconnect existing observations before rebuilding the list
  _getLazyObserver().disconnect();

  // Build all items into a DocumentFragment — single DOM insertion,
  // eliminates per-item reflow that caused jank with 100+ tracks.
  const frag = document.createDocumentFragment();
  list.forEach((track) => {
    const realIdx = S.playlist.indexOf(track);
    frag.appendChild(_buildPlaylistItem(track, realIdx));
  });

  // Single DOM write — replaces the entire list in one operation
  playlistList.replaceChildren(frag);

  // Observe all lazy placeholders now that they're in the live DOM
  _observeLazyThumbs(playlistList);

  plCount.textContent = `${S.playlist.length} TRACK${S.playlist.length !== 1 ? 'S' : ''}`;
}

function _dndShowIndicator(refEl, insertAfter) {
  if (!DND.indicator) {
    DND.indicator = document.createElement('div');
    DND.indicator.className = 'pl-drop-indicator';
  }
  if (insertAfter) refEl.after(DND.indicator);
  else refEl.before(DND.indicator);
}

function _dndCleanup(resetOver = true) {
  if (DND.indicator) DND.indicator.remove();
  if (resetOver) { DND.dragIndex = -1; DND.overIndex = -1; }
  document.querySelectorAll('.pl-dragging').forEach(el => el.classList.remove('pl-dragging'));
}

function _doPlaylistReorder(fromIdx, toIdx) {
  if (fromIdx === toIdx || fromIdx < 0) return;
  let insertAt = toIdx;
  if (fromIdx < toIdx) insertAt--;
  if (insertAt === fromIdx) return;

  const item = S.playlist.splice(fromIdx, 1)[0];
  S.playlist.splice(insertAt, 0, item);

  if (S.currentIndex === fromIdx) {
    S.currentIndex = insertAt;
  } else if (fromIdx < S.currentIndex && insertAt >= S.currentIndex) {
    S.currentIndex--;
  } else if (fromIdx > S.currentIndex && insertAt <= S.currentIndex) {
    S.currentIndex++;
  }

  renderPlaylist();
  updatePlaylistMeta();
  if (pw()) pywebview.api.reorder_playlist(fromIdx, insertAt).catch(() => {});
  scheduleStateSave();
}


// ─── CONTEXT MENU ─────────────────────────────────────────────
function showContextMenu(x, y, track) {
  // Remove existing context menus
  closeContextMenu();

  const isAudio = !track.is_video;

  const menu = document.createElement('div');
  menu.id = 'macan-ctx-menu';
  menu.className = 'macan-ctx-menu';
  menu.innerHTML = `
    <div class="ctx-item ctx-properties" data-action="properties">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      File Properties
    </div>
    <div class="ctx-item ctx-play" data-action="play">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5,3 19,12 5,21"/>
      </svg>
      Play Now
    </div>
    ${isAudio ? `
    <div class="ctx-separator"></div>
    <div class="ctx-item ctx-edittags" data-action="edittags">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>
      Edit Tags / Metadata
    </div>` : ''}
    <div class="ctx-separator"></div>
    <div class="ctx-item ctx-remove" data-action="remove">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>
      Remove from Queue
    </div>`;

  document.body.appendChild(menu);

  // Position — keep within viewport
  const menuW = 200, menuH = isAudio ? 160 : 110;
  const left = Math.min(x, window.innerWidth - menuW - 8);
  const top  = Math.min(y, window.innerHeight - menuH - 8);
  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';

  menu.querySelector('[data-action="properties"]').addEventListener('click', () => {
    showFileProperties(track);
    closeContextMenu();
  });
  menu.querySelector('[data-action="play"]').addEventListener('click', () => {
    const idx = S.playlist.indexOf(track);
    if (idx >= 0) loadTrack(idx, true);
    closeContextMenu();
  });
  if (isAudio) {
    menu.querySelector('[data-action="edittags"]').addEventListener('click', () => {
      showTagEditor(track);
      closeContextMenu();
    });
  }
  menu.querySelector('[data-action="remove"]').addEventListener('click', () => {
    const fakeEvent = { stopPropagation: () => {} };
    removeTrack(track.path, fakeEvent);
    closeContextMenu();
  });

  // FIX: Prevent right-click context menu from closing itself immediately.
  // In pywebview/Chromium the contextmenu event can still be bubbling when
  // setTimeout(0) fires, causing the "close on outside contextmenu" listener
  // to catch the same event that opened the menu.
  // Solution: block all contextmenu events on the menu element itself,
  // and attach the document-level close listeners after a reliable delay.
  menu.addEventListener('contextmenu', e => e.preventDefault());

  // Close on click outside — setTimeout(0) is safe for click events
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);

  // Close on right-click outside — use longer delay so the originating
  // contextmenu event has fully finished bubbling before we listen.
  setTimeout(() => {
    document.addEventListener('contextmenu', e => {
      // Don't close if the right-click was inside the menu itself
      if (!menu.contains(e.target)) {
        closeContextMenu();
      }
    }, { once: true });
  }, 150);
}

function closeContextMenu() {
  const m = document.getElementById('macan-ctx-menu');
  if (m) m.remove();
}

// Context menu for video layer
function setupVideoContextMenu() {
  videoLayer.addEventListener('contextmenu', e => {
    e.preventDefault();
    // FIX: stopPropagation prevents this contextmenu event from bubbling up
    // to the document-level "close on outside contextmenu" listener that
    // showContextMenu attaches with a 150ms delay. Without this, the same
    // event that opens the menu immediately triggers closeContextMenu.
    e.stopPropagation();
    const track = S.currentIndex >= 0 ? S.playlist[S.currentIndex] : null;
    if (!track) return;
    showContextMenu(e.clientX, e.clientY, track);
  });
}

// ─── FILE PROPERTIES MODAL ────────────────────────────────────
async function showFileProperties(track) {
  let info = null;
  if (pw() && track.path) {
    try {
      info = await pywebview.api.get_file_info(track.path);
    } catch(e) {
      console.error('[MACAN] get_file_info error:', e);
    }
  }

  // Fallback: use track object data
  if (!info) {
    info = {
      name:      track.name || '—',
      path:      track.path || '—',
      size:      '—',
      duration_str: track.duration_str || '—',
      is_video:  track.is_video,
      ext:       track.ext || '—',
      artist:    track.artist || '',
      album:     track.album || '',
      resolution: track.video_resolution || null,
    };
  }

  // Remove existing modal
  const existing = document.getElementById('macan-file-props');
  if (existing) existing.remove();

  const modDate = info.modified ? new Date(info.modified * 1000).toLocaleString() : '—';

  let rows = '';
  rows += `<tr><td>File Name</td><td>${esc(info.name)}</td></tr>`;
  rows += `<tr><td>Path</td><td class="fp-path" title="${esc(info.path)}">${esc(info.path)}</td></tr>`;
  rows += `<tr><td>Size</td><td>${info.size || '—'}</td></tr>`;
  rows += `<tr><td>Format</td><td>${info.ext || '—'}</td></tr>`;
  rows += `<tr><td>Duration</td><td>${info.duration_str || track.duration_str || '—'}</td></tr>`;
  rows += `<tr><td>Modified</td><td>${modDate}</td></tr>`;

  if (info.is_video) {
    rows += `<tr><td>Resolution</td><td>${info.resolution || track.video_resolution || '—'}</td></tr>`;
    if (info.fps) rows += `<tr><td>Frame Rate</td><td>${info.fps} fps</td></tr>`;
  } else {
    if (info.artist || track.artist) rows += `<tr><td>Artist</td><td>${esc(info.artist || track.artist || '—')}</td></tr>`;
    if (info.album  || track.album)  rows += `<tr><td>Album</td><td>${esc(info.album  || track.album  || '—')}</td></tr>`;
    if (info.replaygain_db !== undefined && info.replaygain_db !== null) {
      const rg = parseFloat(info.replaygain_db);
      rows += `<tr><td>ReplayGain</td><td>${rg > 0 ? '+' : ''}${rg.toFixed(2)} dB</td></tr>`;
    }
  }

  const modal = document.createElement('div');
  modal.id = 'macan-file-props';
  modal.className = 'macan-file-props-overlay';
  modal.innerHTML = `
    <div class="fp-panel">
      <div class="fp-header">
        <span class="fp-icon">${info.is_video ? '🎬' : '🎵'}</span>
        <h3>FILE PROPERTIES</h3>
        <button class="fp-close" id="fp-close-btn">✕</button>
      </div>
      <table class="fp-table">
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#fp-close-btn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ─── TAG EDITOR ───────────────────────────────────────────────
async function showTagEditor(track) {
  if (!pw()) { setStatus('pywebview required for tag editing'); return; }

  // Remove any existing tag editor
  const existing = document.getElementById('macan-tag-editor');
  if (existing) existing.remove();

  // Create modal skeleton with loading state
  const modal = document.createElement('div');
  modal.id = 'macan-tag-editor';
  modal.className = 'tag-editor-overlay';
  modal.innerHTML = `
    <div class="te-panel">
      <div class="te-header">
        <div class="te-header-left">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          <h2>TAG EDITOR</h2>
        </div>
        <button class="te-close-btn" id="te-close">✕</button>
      </div>
      <div class="te-filename" id="te-filename">${esc(track.name)}</div>
      <div class="te-body" id="te-body">
        <div class="te-loading">
          <div class="te-spinner"></div>
          <span>READING TAGS...</span>
        </div>
      </div>
      <div class="te-footer">
        <span class="te-status" id="te-status"></span>
        <div class="te-footer-btns">
          <button class="te-btn te-btn-cancel" id="te-cancel">CANCEL</button>
          <button class="te-btn te-btn-save" id="te-save" disabled>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
            SAVE TAGS
          </button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);

  const teClose  = modal.querySelector('#te-close');
  const teCancel = modal.querySelector('#te-cancel');
  const teSave   = modal.querySelector('#te-save');
  const teStatus = modal.querySelector('#te-status');
  const teBody   = modal.querySelector('#te-body');

  function closeModal() { modal.remove(); }
  teClose.addEventListener('click', closeModal);
  teCancel.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // ── Fetch tags from Python ──────────────────────────────────────
  let tags = null;
  try {
    tags = await pywebview.api.get_tags(track.path);
  } catch(e) {
    tags = null;
  }

  if (!tags) {
    teBody.innerHTML = `
      <div class="te-error">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p>CANNOT READ TAGS</p>
        <small>Format may not be supported or file is inaccessible.</small>
      </div>`;
    return;
  }

  // ── Build form ──────────────────────────────────────────────────
  const FIELDS = [
    { key: 'title',       label: 'TITLE',        type: 'text',     col: 'full' },
    { key: 'artist',      label: 'ARTIST',        type: 'text',     col: 'half' },
    { key: 'albumartist', label: 'ALBUM ARTIST',  type: 'text',     col: 'half' },
    { key: 'album',       label: 'ALBUM',         type: 'text',     col: 'half' },
    { key: 'date',        label: 'YEAR',          type: 'text',     col: 'quarter', placeholder: '2024' },
    { key: 'genre',       label: 'GENRE',         type: 'text',     col: 'quarter' },
    { key: 'tracknumber', label: 'TRACK #',       type: 'text',     col: 'quarter', placeholder: '1/12' },
    { key: 'discnumber',  label: 'DISC #',        type: 'text',     col: 'quarter', placeholder: '1/1' },
    { key: 'composer',    label: 'COMPOSER',      type: 'text',     col: 'half' },
    { key: 'comment',     label: 'COMMENT',       type: 'text',     col: 'half' },
    { key: 'lyrics',      label: 'LYRICS',        type: 'textarea', col: 'full' },
  ];

  const formHtml = `
    <div class="te-form">
      ${FIELDS.map(f => `
        <div class="te-field te-col-${f.col}">
          <label class="te-label">${f.label}</label>
          ${f.type === 'textarea'
            ? `<textarea class="te-input te-textarea" data-key="${f.key}" rows="5">${esc(tags[f.key] || '')}</textarea>`
            : `<input  class="te-input" type="text" data-key="${f.key}" value="${esc(tags[f.key] || '')}" placeholder="${f.placeholder || ''}">`
          }
        </div>`).join('')}
    </div>`;

  teBody.innerHTML = formHtml;
  teSave.disabled = false;

  // ── Save handler ────────────────────────────────────────────────
  teSave.addEventListener('click', async () => {
    teSave.disabled = true;
    teStatus.textContent = 'SAVING...';
    teStatus.style.color = 'var(--text-lo)';

    // Collect form values
    const newTags = {};
    modal.querySelectorAll('[data-key]').forEach(el => {
      newTags[el.dataset.key] = el.value.trim();
    });

    try {
      const result = await pywebview.api.save_tags(track.path, newTags);
      if (result.ok) {
        teStatus.textContent = '✓ SAVED SUCCESSFULLY';
        teStatus.style.color = 'var(--accent)';

        // Update track in playlist and refresh UI
        if (result.updated_track) {
          const idx = S.playlist.findIndex(t => t.path === track.path);
          if (idx >= 0) {
            S.playlist[idx].name   = result.updated_track.name   || S.playlist[idx].name;
            S.playlist[idx].artist = result.updated_track.artist || S.playlist[idx].artist;
            S.playlist[idx].album  = result.updated_track.album  || S.playlist[idx].album;
            renderPlaylist();
            // If currently playing, refresh track info display
            if (idx === S.currentIndex) updateTrackInfo(S.playlist[idx]);
          }
        }
        setStatus(`TAGS SAVED — ${newTags.title || track.name}`);

        setTimeout(() => closeModal(), 1200);
      } else {
        teStatus.textContent = `ERROR: ${result.error || 'Unknown error'}`;
        teStatus.style.color = 'var(--red)';
        teSave.disabled = false;
      }
    } catch(e) {
      teStatus.textContent = `ERROR: ${e.message || e}`;
      teStatus.style.color = 'var(--red)';
      teSave.disabled = false;
    }
  });
}

function updatePlaylistHighlight(idx) {
  // Remove active from previous — track via data attribute lookup (O(1))
  const prev = playlistList.querySelector('.pl-item.active');
  if (prev) prev.classList.remove('active');
  // Add active to new
  const next = playlistList.querySelector(`.pl-item[data-index="${idx}"]`);
  if (next) next.classList.add('active');
}

// Cached total duration — updated incrementally to avoid O(n) reduce on every call
let _cachedTotalDuration = 0;
function _rebuildTotalDuration() {
  _cachedTotalDuration = S.playlist.reduce((a, t) => a + (t.duration || 0), 0);
}

function updatePlaylistMeta() {
  const total = _cachedTotalDuration;
  plDuration.textContent = total > 0 ? `Total: ${formatTime(total)}` : 'Total: —';
  plCount.textContent = `${S.playlist.length} TRACK${S.playlist.length !== 1 ? 'S' : ''}`;
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────
document.addEventListener('keydown', e => {
  // Block all playback shortcuts when user is typing in any input or textarea
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  // ESC priority: 1) exit lyrics fullscreen  2) close lyrics  3) close video
  if (e.code === 'Escape') {
    e.preventDefault();
    if (_lyricsFullscreen) {
      _exitLyricsFullscreen();
    } else if (S.lyricsOpen) {
      closeLyrics();
    } else if (videoLayer.classList.contains('active')) {
      closeVideo();
    }
    return;
  }

  const p = activePlayer();
  switch(e.code) {
    case 'Space':
      e.preventDefault();
      { const wasPaused = activePlayer().paused;
        togglePlayPause();
        if (videoLayer.classList.contains('active')) {
          flashCenterOverlay(wasPaused ? 'play' : 'pause');
        }
      }
      break;
    case 'ArrowRight': e.shiftKey ? nextTrack() : (p.currentTime=Math.min(S.duration,p.currentTime+10)); break;
    case 'ArrowLeft':  e.shiftKey ? prevTrack() : (p.currentTime=Math.max(0,p.currentTime-10)); break;
    case 'ArrowUp':    e.preventDefault(); setVolume(Math.min(100,S.volume+5)); break;
    case 'ArrowDown':  e.preventDefault(); setVolume(Math.max(0,S.volume-5)); break;
    case 'KeyS': toggleShuffle(); break;
    case 'KeyR': cycleRepeat(); break;
    case 'KeyM': toggleMute(); break;
    case 'KeyN': nextTrack(); break;
    case 'KeyP': prevTrack(); break;
  }
});

// ─── DRAG & DROP ──────────────────────────────────────────────
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  const EXTS = ['.mp3','.mp4','.wav','.flac','.ogg','.aac','.mkv','.avi','.webm','.m4a','.opus','.mov'];
  const files = [...e.dataTransfer.files].filter(f => EXTS.some(x=>f.name.toLowerCase().endsWith(x)));
  if (!files.length) return;
  const tracks = files.map(f => {
    const ext = f.name.split('.').pop().toUpperCase();
    const isV = ['MP4','MKV','AVI','WEBM','MOV'].includes(ext);
    return { name:f.name.replace(/\.[^/.]+$/,''), path:f.path||f.name, url:URL.createObjectURL(f), ext, is_video:isV, duration:0, duration_str:'--:--', cover_art: null };
  });
  S.playlist.push(...tracks);
  renderPlaylist(); updatePlaylistMeta();
  if (S.currentIndex < 0) loadTrack(0);
  setStatus(`DROPPED ${tracks.length} FILE(S)`);

  // Async fetch cover art for dropped audio tracks (pywebview only)
  if (pw()) {
    tracks.forEach(async (track, i) => {
      if (track.is_video) return;
      try {
        const art = await pywebview.api.get_cover_art(track.path);
        if (art) {
          track.cover_art = art;
          thumbCache.set(track.path, art);
          const idx = S.playlist.indexOf(track);
          const item = playlistList.querySelector(`.pl-item[data-index="${idx}"]`);
          if (item) {
            // FIX: placeholder is a <div>, not <img>
            const placeholder = item.querySelector('.pl-thumb-placeholder');
            if (placeholder) {
              const img = document.createElement('img');
              img.className = 'pl-thumb';
              img.src = art; img.alt = ''; img.draggable = false; img.loading = 'lazy';
              placeholder.replaceWith(img);
            }
          }
          _persistArtToServer(track.path, art, false);
        }
      } catch(e) { /* no art available */ }
    });
  }
});

// ─── UTILS ────────────────────────────────────────────────────
function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  s = Math.floor(s);
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function setStatus(msg) { plStatus.textContent = msg; }
