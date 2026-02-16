/* ═══════════════════════════════════════════════════════════════
   MACAN MEDIA PLAYER — script.js (FIXED: AUDIO & SEEKBAR)
   Fixes:
   1. Disables AudioContext source connection for local files (Fixes Mute)
   2. Robust duration checking for Seekbar
   3. Force Resume AudioContext on interaction
═══════════════════════════════════════════════════════════════ */
'use strict';

// ─── STATE ────────────────────────────────────────────────────
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
};

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

  // Load saved playlist
  if (pw()) {
    setTimeout(async () => {
      try {
        const saved = await pywebview.api.get_playlist();
        if (saved?.length) { S.playlist = saved; renderPlaylist(); updatePlaylistMeta(); }
      } catch(e) { console.warn('Load playlist failed:', e); }
    }, 500);
  }
});

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
function initBgVis() {
  const ctx = visCanvas.getContext('2d');
  function resize() { visCanvas.width = innerWidth; visCanvas.height = innerHeight; }
  resize(); window.addEventListener('resize', resize);
  let phase = 0;
  function draw() {
    ctx.clearRect(0, 0, visCanvas.width, visCanvas.height);
    const bars = 80, bw = visCanvas.width / bars;
    
    // NOTE: Analyser data is intentionally disabled for local files to prevent muting
    // We use a simulated wave here if music is playing but no analyser
    const data = (S.analyser && S.isPlaying) ? (() => { const a = new Uint8Array(S.analyser.frequencyBinCount); S.analyser.getByteFrequencyData(a); return a; })() : null;
    
    for (let i = 0; i < bars; i++) {
      let h;
      if (data) {
         h = (data[Math.floor(i/bars*data.length*0.6)]/255)*visCanvas.height*0.55+8;
      } else if (S.isPlaying) {
         // Fake simulation when playing local files
         h = Math.abs(Math.sin(i/bars*Math.PI*5 + phase*2)) * 30 + 15 + (Math.random()*10);
      } else {
         // Idle animation
         h = Math.abs(Math.sin(i/bars*Math.PI*3+phase))*45+15;
      }
      
      const g = ctx.createLinearGradient(0,visCanvas.height,0,visCanvas.height-h);
      g.addColorStop(0,`rgba(232,255,0,${S.isPlaying?0.65:0.22})`);
      g.addColorStop(1,'rgba(232,255,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(i*bw+1,visCanvas.height-h,bw-2,h);
    }
    phase += 0.012;
    requestAnimationFrame(draw);
  }
  draw();
}

// ─── MINI VISUALIZER ──────────────────────────────────────────
let miniAnimId = null;
function initIdleMiniVis() {
  const ctx = miniCanvas.getContext('2d');
  let ph = 0;
  function idle() {
    // If we have an active analyser, switch to live mode (rare for local files)
    if (S.analyser) { initLiveMiniVis(); return; }
    
    miniAnimId = requestAnimationFrame(idle);
    ctx.clearRect(0,0,miniCanvas.width,miniCanvas.height);
    const bc = 48, bw = miniCanvas.width/bc;
    for (let i=0;i<bc;i++) {
      // Simulate activity if playing but no analyser
      let mag = S.isPlaying ? 25 : 10;
      let speed = S.isPlaying ? 0.2 : 0.04;
      const h = Math.abs(Math.sin(i/bc*Math.PI*2 + ph))*mag+3;
      
      ctx.fillStyle = S.isPlaying ? 'rgba(232,255,0,0.6)' : 'rgba(232,255,0,0.14)';
      ctx.fillRect(i*bw+1,miniCanvas.height-h,bw-2,h);
    }
    ph += (S.isPlaying ? 0.2 : 0.04);
  }
  idle();
}

function initLiveMiniVis() {
  if (miniAnimId) cancelAnimationFrame(miniAnimId);
  const ctx = miniCanvas.getContext('2d');
  function live() {
    miniAnimId = requestAnimationFrame(live);
    if (!S.analyser) { initIdleMiniVis(); return; }
    const data = new Uint8Array(S.analyser.frequencyBinCount);
    S.analyser.getByteFrequencyData(data);
    ctx.clearRect(0,0,miniCanvas.width,miniCanvas.height);
    const bc = 48, bw = miniCanvas.width/bc;
    for (let i=0;i<bc;i++) {
      const idx = Math.floor(i/bc*data.length*0.7);
      const h = (data[idx]/255)*miniCanvas.height;
      const a = 0.35+(data[idx]/255)*0.65;
      ctx.fillStyle = `rgba(232,255,0,${a})`;
      ctx.fillRect(i*bw+1,miniCanvas.height-h,bw-2,h);
    }
  }
  live();
}

// ─── AUDIO CONTEXT ────────────────────────────────────────────
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
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
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

  vcSeekbar.addEventListener('mousedown', e => {
    e.preventDefault();
    S.vcSeekDragging = true;
    setFill(getPercent(e));
    pinVcControls(true);
  });

  window.addEventListener('mousemove', e => {
    if (!S.vcSeekDragging) return;
    const pct = getPercent(e);
    setFill(pct);
    if(S.duration) vcTimeCur.textContent = formatTime(pct * S.duration);
  });

  window.addEventListener('mouseup', e => {
    if (!S.vcSeekDragging) return;
    S.vcSeekDragging = false;
    applySeek(getPercent(e));
    pinVcControls(false);
  });

  vcSeekbar.addEventListener('click', e => { applySeek(getPercent(e)); });
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

  // Double-click video to toggle play
  video.addEventListener('dblclick', togglePlayPause);
  // Single click toggles play
  video.addEventListener('click', togglePlayPause);
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
  S.currentIndex = index;
  const track = S.playlist[index];
  const isVid  = track.is_video;

  // Stop both players first
  audio.pause(); video.pause();

  // Reset src cleanly (empty string, not removeAttribute, avoids HTMLMediaElement errors)
  audio.src = '';
  video.src = '';

  updateTrackInfo(track);
  updatePlaylistHighlight(index);
  setStatus(`LOADING — ${track.name}`);

  // Start with whatever URL was stored in the playlist
  let srcUrl = track.url || '';

  // If running inside pywebview, verify the URL via Python API
  // Python returns a proper file:// URI via Path.as_uri() with correct encoding
  if (pw() && track.path) {
    try {
      const resolvedUrl = await pywebview.api.get_file_url(track.path);
      if (resolvedUrl) {
        srcUrl = resolvedUrl;
        // Also update stored url so next play doesn't need another round-trip
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

  // Show/hide video layer and assign src
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
}

function doPlay(player) {
  // Always try to resume AudioContext (browser policy)
  if (S.audioCtx && S.audioCtx.state === 'suspended') {
    S.audioCtx.resume().catch(e => console.warn('[MACAN] AudioCtx resume:', e));
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
    }).catch(err => {
      // AbortError = play() was interrupted by a new load/src change — not a real error
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

// ─── TRACK INFO UPDATE ────────────────────────────────────────
function updateTrackInfo(track) {
  // Scrolling title
  trackTitle.classList.remove('scrolling');
  trackTitle.textContent = track.name;
  void trackTitle.offsetWidth;
  if (trackTitle.scrollWidth > trackTitle.parentElement.offsetWidth - 20) {
    trackTitle.classList.add('scrolling');
  }

  trackFormat.textContent = track.ext || '—';
  trackType.textContent   = track.is_video ? 'VIDEO' : 'AUDIO';
  trackType.style.color   = track.is_video ? 'var(--red)' : '';

  const marqueeStr = `▶  ${track.name.toUpperCase()}  `;
  marqueeText.textContent  = marqueeStr;
  marqueeClone.textContent = marqueeStr;
  marqueeTrack.style.animationDuration = Math.max(10, track.name.length*0.38)+'s';

  // Clear old art
  albumArt.src = '';
  albumArt.classList.remove('loaded');
  artPlaceholder.classList.remove('hidden');
  artBlurBg.style.opacity = '0';

  // Try to get cover art
  if (pw() && !track.is_video) {
    pywebview.api.get_cover_art(track.path).then(data => {
      if (data) applyArt(data);
    }).catch(() => {});
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
  timeTotal.textContent    = str;
  vcTimeTotal.textContent  = str;
  if (S.currentIndex >= 0 && S.playlist[S.currentIndex]) {
    S.playlist[S.currentIndex].duration     = Math.floor(S.duration);
    S.playlist[S.currentIndex].duration_str = str;
    updatePlaylistMeta();
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
}

function cycleRepeat() {
  const modes = ['none','all','one'];
  S.repeatMode = modes[(modes.indexOf(S.repeatMode)+1)%3];
  $('btn-repeat').classList.toggle('active', S.repeatMode !== 'none');
  repeatBadge.style.display = S.repeatMode==='one' ? 'flex' : 'none';
  setStatus({none:'REPEAT OFF',all:'REPEAT ALL',one:'REPEAT ONE'}[S.repeatMode]);
}

function setVolume(val) {
  S.volume = parseInt(val);
  audio.volume = video.volume = S.volume / 100;
  if (S.volume > 0) S.isMuted = false;
  updateVolumeUI(S.volume);
  syncVcVolume(S.volume);
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
    const files = await pywebview.api.browse_files();
    if (files?.length) {
      const added = await pywebview.api.add_tracks(files);
      S.playlist = added;
      renderPlaylist(); updatePlaylistMeta();
      setStatus(`ADDED ${files.length} TRACK(S)`);
      if (S.currentIndex < 0) loadTrack(0);
    } else { setStatus('NO FILES SELECTED'); }
  } catch(e) { console.error(e); setStatus('ERROR — SEE CONSOLE'); }
}

async function openFolder() {
  if (!pw()) { setStatus('pywebview required'); return; }
  setStatus('SCANNING FOLDER...');
  try {
    const files = await pywebview.api.browse_folder();
    if (files?.length) {
      const added = await pywebview.api.add_tracks(files);
      S.playlist = added;
      renderPlaylist(); updatePlaylistMeta();
      setStatus(`LOADED ${files.length} TRACK(S)`);
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
  trackFormat.textContent = '—';
  trackType.textContent = 'AUDIO';
  progressFill.style.width = '0%';
  timeCurrent.textContent = '0:00';
  timeTotal.textContent = '0:00';
  albumArt.src = ''; albumArt.classList.remove('loaded');
  artPlaceholder.classList.remove('hidden');
  artBlurBg.style.opacity = '0';
  marqueeText.textContent = marqueeClone.textContent = '— SELECT A TRACK TO BEGIN PLAYBACK —';
  setStatus('QUEUE CLEARED');
}

let filterQ = '';
function filterPlaylist(q) { filterQ = q.trim().toLowerCase(); renderPlaylist(); }

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
    div.innerHTML = `
      <div class="pl-idx">${realIdx+1}</div>
      <div class="pl-playing-indicator"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>
      <div class="pl-item-info">
        <span class="pl-item-name">${esc(track.name)}</span>
        <span class="pl-item-ext">${track.ext||''}</span>
      </div>
      <span class="pl-item-duration">${track.duration_str||'--:--'}</span>
      <span class="pl-item-type ${track.is_video?'video':''}">${track.is_video?'VIDEO':'AUDIO'}</span>
      <button class="pl-remove-btn" title="Remove">✕</button>`;
    div.querySelector('.pl-remove-btn').addEventListener('click', e => removeTrack(track.path, e));
    div.addEventListener('click', () => loadTrack(realIdx));
    div.addEventListener('dblclick', () => loadTrack(realIdx, true));
    playlistList.appendChild(div);
  });

  plCount.textContent = `${S.playlist.length} TRACK${S.playlist.length!==1?'S':''}`;
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
    return { name:f.name.replace(/\.[^/.]+$/,''), path:f.path||f.name, url:URL.createObjectURL(f), ext, is_video:isV, duration:0, duration_str:'--:--' };
  });
  S.playlist.push(...tracks);
  renderPlaylist(); updatePlaylistMeta();
  if (S.currentIndex < 0) loadTrack(0);
  setStatus(`DROPPED ${tracks.length} FILE(S)`);
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