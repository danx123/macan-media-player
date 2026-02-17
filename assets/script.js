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
// AUDIO CONTEXT & EQUALIZER INITIALIZATION
// ═══════════════════════════════════════════════════════════════

let audioContext;
let audioSource;
let equalizer;
let equalizerUI;
let playlistManager;

function initAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    equalizer = new Equalizer10Band(audioContext);
    equalizerUI = new EqualizerUI(equalizer);

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

    // FIX: Apply pending EQ bands that were restored before AudioContext existed
    if (S._pendingEqBands) {
      equalizer.setAllBands(S._pendingEqBands);
      if (equalizerUI) equalizerUI.syncSlidersFromEq(S._pendingEqPreset);
      S._pendingEqBands  = null;
      S._pendingEqPreset = null;
    }
  }
}

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

playlistManager.onSave((name) => {
  const tracks = S.playlist.map(item => ({
    path: item.path,
    name: item.name,
    artist: item.artist || 'Unknown Artist',
    album: item.album || '',
    duration: item.duration,
    duration_str: item.duration_str || '--:--',
    ext: item.ext || '',
    is_video: item.is_video || false,
    cover_art: item.cover_art || null
  }));
  playlistManager.saveCurrentPlaylist(name, tracks);
});

playlistManager.onLoad((name) => {
  const tracks = playlistManager.loadPlaylist(name);
  if (tracks && tracks.length > 0) {
    // FIX: Stop playback cleanly before replacing playlist
    const p = activePlayer();
    p.pause();
    p.src = '';
    S.currentIndex = -1;
    onPlayState(false);

    S.playlist = tracks;
    _seedThumbCache(S.playlist);
    renderPlaylist();
    updatePlaylistMeta();
    loadTrack(0);
  }
});

btnEqualizer.addEventListener('click', () => {
  initAudioContext();
  equalizerUI.toggle();
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

// Close on overlay background click
lyricsOverlay.addEventListener('click', e => {
  if (e.target === lyricsOverlay) closeLyrics();
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
  btnPlay.onclick            = togglePlayPause;
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
  $('vc-play').onclick    = togglePlayPause;
  $('vc-prev').onclick    = prevTrack;
  $('vc-next').onclick    = nextTrack;
  $('vc-close').onclick   = closeVideo;
  $('vc-mute').onclick    = toggleMute;
  $('vc-fullscreen').onclick = () => pw() && pywebview.api.toggle_fullscreen();

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
          // AudioContext already exists — apply right away
          equalizer.setAllBands(state.eqBands);
          if (equalizerUI) equalizerUI.syncSlidersFromEq(state.eqPreset || null);
        } else {
          // Defer until initAudioContext() is called
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

// ─── MINI VISUALIZER (Enhanced) ──────────────────────────────
let miniAnimId = null;

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

    const bc = 48, bw = W / bc;
    for (let i = 0; i < bc; i++) {
      const target = S.isPlaying
        ? (Math.abs(Math.sin(i / bc * Math.PI * 3 + ph)) * 0.65 +
           Math.abs(Math.sin(i / bc * Math.PI * 7 + ph * 1.3)) * 0.35)
        : Math.abs(Math.sin(i / bc * Math.PI * 2 + ph)) * 0.2;

      smoothed[i] += (target - smoothed[i]) * (S.isPlaying ? 0.15 : 0.05);
      const h = smoothed[i] * H;

      // Gradient bar
      const g = ctx.createLinearGradient(0, H, 0, H - h);
      g.addColorStop(0, S.isPlaying ? 'rgba(232,255,0,0.8)' : 'rgba(232,255,0,0.15)');
      g.addColorStop(1, S.isPlaying ? 'rgba(150,255,200,0.4)' : 'rgba(232,255,0,0.05)');
      ctx.fillStyle = g;
      ctx.fillRect(i * bw + 0.5, H - h, bw - 1.5, h);

      // Peak dot
      if (S.isPlaying && h > 3) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillRect(i * bw + 0.5, H - h - 1.5, bw - 1.5, 1.5);
      }
    }
    ph += S.isPlaying ? 0.18 : 0.025;
  }
  frame();
}

function initLiveMiniVis() {
  if (miniAnimId) cancelAnimationFrame(miniAnimId);
  const ctx = miniCanvas.getContext('2d');
  let smoothed = new Float32Array(48).fill(0);
  let peaks = new Float32Array(48).fill(0);
  let peakDecay = new Float32Array(48).fill(0);

  function frame() {
    miniAnimId = requestAnimationFrame(frame);
    if (!S.analyser) { initIdleMiniVis(); return; }
    const W = miniCanvas.width, H = miniCanvas.height;
    const raw = new Uint8Array(S.analyser.frequencyBinCount);
    S.analyser.getByteFrequencyData(raw);
    ctx.clearRect(0, 0, W, H);

    const bc = 48, bw = W / bc;
    for (let i = 0; i < bc; i++) {
      const idx = Math.floor(i / bc * raw.length * 0.75);
      const target = raw[idx] / 255;
      smoothed[i] += (target - smoothed[i]) * 0.22;
      const h = smoothed[i] * H;

      // Update falling peak
      if (h > peaks[i]) { peaks[i] = h; peakDecay[i] = 0; }
      else { peakDecay[i] += 0.4; peaks[i] = Math.max(0, peaks[i] - peakDecay[i] * 0.012); }

      // Bar gradient
      const a = 0.4 + smoothed[i] * 0.6;
      const g = ctx.createLinearGradient(0, H, 0, H - h);
      g.addColorStop(0, `rgba(232,255,0,${a})`);
      g.addColorStop(0.7, `rgba(180,255,120,${a * 0.7})`);
      g.addColorStop(1, `rgba(80,255,200,${a * 0.4})`);
      ctx.fillStyle = g;
      ctx.fillRect(i * bw + 0.5, H - h, bw - 1.5, h);

      // Falling peak indicator
      if (peaks[i] > 2) {
        ctx.fillStyle = `rgba(255,255,255,${0.5 + smoothed[i] * 0.5})`;
        ctx.fillRect(i * bw + 0.5, H - peaks[i] - 1.5, bw - 1.5, 1.5);
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
    if (!err) return; // Ignore if no error (e.g., src cleared)
    const codes = {1:'ABORTED',2:'NETWORK',3:'DECODE ERROR',4:'FORMAT NOT SUPPORTED'};
    const msg = codes[err.code] || `UNKNOWN (${err.code})`;
    console.error('[MACAN] Audio error:', err.code, err.message);
    setStatus(`AUDIO ERROR — ${msg}: ${err.message || ''}`);
    onPlayState(false);
  });
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
    const codes = {1:'ABORTED',2:'NETWORK',3:'DECODE ERROR',4:'FORMAT NOT SUPPORTED'};
    const msg = codes[err.code] || `UNKNOWN (${err.code})`;
    console.error('[MACAN] Video error:', err.code, err.message);
    setStatus(`VIDEO ERROR — ${msg}: ${err.message || ''}`);
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
  // Show controls on mouse move, hide after 3s idle
  videoLayer.addEventListener('mousemove', () => {
    videoControls.style.opacity = '1';
    videoControls.style.pointerEvents = 'all';
    clearTimeout(S.vcHideTimer);
    S.vcHideTimer = setTimeout(hideVcControls, 3000);
  });

  videoLayer.addEventListener('mouseleave', () => {
    if (!S.vcSeekDragging) hideVcControls();
  });

  // FIX: Guard both click handlers — if a context menu is open, clicks
  // on its items should not also trigger play/pause via event bubbling.
  video.addEventListener('dblclick', e => {
    if (document.getElementById('macan-ctx-menu')) return;
    togglePlayPause();
  });
  video.addEventListener('click', e => {
    if (document.getElementById('macan-ctx-menu')) return;
    togglePlayPause();
  });
}

function hideVcControls() {
  if (S.vcSeekDragging) return;
  videoControls.style.opacity = '0';
  videoControls.style.pointerEvents = 'none';
}

function pinVcControls(on) {
  if (on) {
    videoControls.classList.add('pinned');
  } else {
    videoControls.classList.remove('pinned');
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

  // Stop both players first
  audio.pause(); video.pause();

  // Reset src cleanly
  audio.src = '';
  video.src = '';

  updateTrackInfo(track);
  updatePlaylistHighlight(index);
  setStatus(`LOADING — ${track.name}`);

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
  } else {
    videoLayer.classList.remove('active');
    $('main-layout').style.display = '';
    audio.src = srcUrl;
    audio.load();
    if (autoplay) doPlay(audio);
  }

  scheduleStateSave();
}

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
  }

  // Auto-fetch lyrics if panel is open
  if (S.lyricsOpen && !track.is_video) {
    fetchLyrics(track);
  }
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
      // FIX: If AudioContext/equalizer hasn't been initialized yet (user hasn't
      // interacted with EQ), fall back to the pending values from restore so we
      // don't overwrite a valid saved EQ state with null.
      eqBands:  equalizer ? equalizer.getCurrentValues() : (S._pendingEqBands || null),
      eqPreset: equalizerUI ? equalizerUI.currentPreset  : (S._pendingEqPreset || null),
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
  video.pause(); video.src = '';
  videoLayer.classList.remove('active');
  $('main-layout').style.display = '';
  onPlayState(false);
  setStatus('VIDEO CLOSED');
}

// ─── PLAYLIST ─────────────────────────────────────────────────
async function openFiles() {
  if (!pw()) { setStatus('pywebview required'); return; }
  setStatus('OPENING FILE DIALOG...');
  try {
    // browse_files() returns raw file path strings
    const paths = await pywebview.api.browse_files();
    if (paths?.length) {
      // add_tracks() accepts raw paths, builds metadata, returns updated playlist
      const playlist = await pywebview.api.add_tracks(paths);
      S.playlist = playlist;
      _seedThumbCache(S.playlist);
      renderPlaylist(); updatePlaylistMeta();
      setStatus(`ADDED ${paths.length} TRACK(S)`);
      if (S.currentIndex < 0) loadTrack(0);
    } else { setStatus('NO FILES SELECTED'); }
  } catch(e) { console.error(e); setStatus('ERROR — SEE CONSOLE'); }
}

async function openFolder() {
  if (!pw()) { setStatus('pywebview required'); return; }
  setStatus('SCANNING FOLDER...');
  try {
    // browse_folder() returns raw file path strings
    const paths = await pywebview.api.browse_folder();
    if (paths?.length) {
      // add_tracks() accepts raw paths, builds metadata, returns updated playlist
      const playlist = await pywebview.api.add_tracks(paths);
      S.playlist = playlist;
      _seedThumbCache(S.playlist);
      renderPlaylist(); updatePlaylistMeta();
      setStatus(`LOADED ${paths.length} TRACK(S)`);
      if (S.currentIndex < 0) loadTrack(0);
    } else { setStatus('NO MEDIA FOUND'); }
  } catch(e) { console.error(e); setStatus('ERROR — SEE CONSOLE'); }
}

async function removeTrack(path, e) {
  e.stopPropagation();
  if (pw()) {
    S.playlist = await pywebview.api.remove_track(path);
  } else {
    S.playlist = S.playlist.filter(t => t.path !== path);
  }
  if (S.currentIndex >= S.playlist.length) S.currentIndex = S.playlist.length - 1;
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
function filterPlaylist(q) { filterQ = q.trim().toLowerCase(); renderPlaylist(); }

// ─── DRAG-AND-DROP STATE ──────────────────────────────────────
const DND = {
  dragIndex:  -1,
  overIndex:  -1,
  indicator:  null,
};

function renderPlaylist() {
  playlistList.innerHTML = '';
  const list = filterQ
    ? S.playlist.filter(t => t.name.toLowerCase().includes(filterQ))
    : S.playlist;

  playlistEmpty.classList.toggle('hidden', list.length > 0);

  list.forEach((track) => {
    const realIdx = S.playlist.indexOf(track);
    const isActive = realIdx === S.currentIndex;
    const div = document.createElement('div');
    div.className = 'pl-item' + (isActive ? ' active' : '');
    div.dataset.index = realIdx;
    div.draggable = !filterQ;

    // ── thumbnail ──────────────────────────────────────────────
    let thumbHtml = '';
    if (track.is_video) {
      // Merge cache → track object so render is instant on re-add after clear
      if (!track.video_thumb && videoThumbCache.has(track.path))
        track.video_thumb = videoThumbCache.get(track.path);

      if (track.video_thumb) {
        thumbHtml = `<img class="pl-thumb pl-thumb-video-img" src="${track.video_thumb}" alt="" loading="lazy" draggable="false">`;
      } else {
        thumbHtml = `
          <div class="pl-thumb pl-thumb-placeholder pl-thumb-video" title="Video">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.6">
              <polygon points="23,7 16,12 23,17"/>
              <rect x="1" y="5" width="15" height="14" rx="2"/>
            </svg>
          </div>`;
        if (pw()) {
          (async (t, idx) => {
            try {
              const thumb = await pywebview.api.get_video_thumbnail(t.path);
              if (thumb) {
                const wasNew = !t.video_thumb;
                t.video_thumb = thumb;
                videoThumbCache.set(t.path, thumb);
                // FIX: placeholder is a <div>, not <img>
                const el = playlistList.querySelector(`.pl-item[data-index="${idx}"] .pl-thumb-placeholder`);
                if (el) {
                  const img = document.createElement('img');
                  img.className = 'pl-thumb pl-thumb-video-img';
                  img.src = thumb; img.alt = ''; img.draggable = false; img.loading = 'lazy';
                  el.replaceWith(img);
                }
                if (wasNew) _persistArtToServer(t.path, thumb, true);
              }
            } catch(e) {}
          })(track, realIdx);
        }
      }
    } else {
      // Merge cache → track object so render is instant on re-add after clear
      if (!track.cover_art && thumbCache.has(track.path))
        track.cover_art = thumbCache.get(track.path);
      // Merge track object → cache (seed from Python-fetched embedded art)
      if (track.cover_art && !thumbCache.has(track.path))
        thumbCache.set(track.path, track.cover_art);

      if (track.cover_art) {
        thumbHtml = `<img class="pl-thumb" src="${track.cover_art}" alt="" loading="lazy" draggable="false">`;
      } else {
        thumbHtml = `
          <div class="pl-thumb pl-thumb-placeholder" title="No art">
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
      <div class="pl-idx">${realIdx+1}</div>
      <div class="pl-playing-indicator"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>
      ${thumbHtml}
      <div class="pl-item-info">
        <span class="pl-item-name">${esc(track.name)}</span>
        <span class="pl-item-artist">${track.artist ? esc(track.artist) : ''}</span>
        <span class="pl-item-ext">${track.ext||''}</span>
      </div>
      <span class="pl-item-duration">${track.duration_str||'--:--'}</span>
      <span class="pl-item-type ${track.is_video?'video':''}">
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

    playlistList.appendChild(div);
  });

  plCount.textContent = `${S.playlist.length} TRACK${S.playlist.length!==1?'S':''}`;
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
    <div class="ctx-separator"></div>
    <div class="ctx-item ctx-remove" data-action="remove">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>
      Remove from Queue
    </div>`;

  document.body.appendChild(menu);

  // Position — keep within viewport
  const menuW = 200, menuH = 130;
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

function updatePlaylistHighlight(idx) {
  document.querySelectorAll('.pl-item').forEach(el => {
    el.classList.toggle('active', +el.dataset.index === idx);
  });
}

function updatePlaylistMeta() {
  const total = S.playlist.reduce((a,t) => a+(t.duration||0), 0);
  plDuration.textContent = total>0 ? `Total: ${formatTime(total)}` : 'Total: —';
  plCount.textContent = `${S.playlist.length} TRACK${S.playlist.length!==1?'S':''}`;
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────
document.addEventListener('keydown', e => {
  if (document.activeElement === $('search-input')) return;
  const p = activePlayer();
  switch(e.code) {
    case 'Space':      e.preventDefault(); togglePlayPause(); break;
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
