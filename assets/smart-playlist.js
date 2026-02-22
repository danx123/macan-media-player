// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — SMART PLAYLIST MODULE
// Most-played tracks: audio (top 25) + video (top 25)
// Play counts stored in localStorage, keyed by file path.
// ═══════════════════════════════════════════════════════════════

const SmartPlaylist = (() => {
  const STORAGE_KEY = 'macan_play_counts';
  const MAX_TRACKS  = 25;

  // ── State ──────────────────────────────────────────────────
  let isOpen  = false;
  let activeTab = 'audio'; // 'audio' | 'video'

  // ── DOM ────────────────────────────────────────────────────
  const overlay  = document.getElementById('smart-playlist-overlay');
  const btnClose = document.getElementById('smart-playlist-close');
  const tabAudio = document.getElementById('sp-tab-audio');
  const tabVideo = document.getElementById('sp-tab-video');
  const listEl   = document.getElementById('sp-list');
  const countEl  = document.getElementById('sp-count');
  const emptyEl  = document.getElementById('sp-empty');

  // ── Play Count Storage ──────────────────────────────────────
  function loadCounts() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
  }

  function saveCounts(counts) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(counts)); } catch {}
  }

  /** Increment play count for a track path. Call from loadTrack(). */
  function recordPlay(path) {
    if (!path) return;
    const counts = loadCounts();
    counts[path] = (counts[path] || 0) + 1;
    saveCounts(counts);
  }

  /** Return top-N tracks from S.playlist filtered by type, sorted by play count. */
  function getTopTracks(kind) {
    if (typeof S === 'undefined' || !Array.isArray(S.playlist)) return [];
    const counts = loadCounts();
    return S.playlist
      .filter(t => (kind === 'video' ? t.is_video : !t.is_video))
      .filter(t => (counts[t.path] || 0) > 0)
      .sort((a, b) => (counts[b.path] || 0) - (counts[a.path] || 0))
      .slice(0, MAX_TRACKS);
  }

  // ── Render ─────────────────────────────────────────────────
  function render() {
    const tracks = getTopTracks(activeTab);
    const counts = loadCounts();

    listEl.innerHTML = '';
    emptyEl.style.display = tracks.length === 0 ? 'flex' : 'none';
    listEl.style.display  = tracks.length === 0 ? 'none'  : 'block';

    countEl.textContent = `${tracks.length} TRACK${tracks.length !== 1 ? 'S' : ''}`;

    if (tracks.length === 0) return;

    const frag = document.createDocumentFragment();
    tracks.forEach((track, i) => {
      const playCount = counts[track.path] || 0;

      // Thumb — use cached art if available
      let thumbHtml = '';
      if (track.cover_art || track.video_thumb) {
        const src = track.cover_art || track.video_thumb;
        thumbHtml = `<img class="sp-thumb" src="${src}" alt="" draggable="false">`;
      } else {
        thumbHtml = `<div class="sp-thumb sp-thumb-placeholder">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.35">
            <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
          </svg>
        </div>`;
      }

      const item = document.createElement('div');
      item.className = 'sp-item';
      item.dataset.path = track.path;
      item.innerHTML = `
        <div class="sp-rank">${i + 1}</div>
        ${thumbHtml}
        <div class="sp-info">
          <div class="sp-name">${_spEsc(track.name)}</div>
          <div class="sp-meta">${track.artist ? _spEsc(track.artist) : '—'} ${track.album ? '· ' + _spEsc(track.album) : ''}</div>
        </div>
        <div class="sp-count-badge">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" opacity="0.6">
            <polygon points="5,3 19,12 5,21"/>
          </svg>
          ${playCount}
        </div>
        <span class="sp-ext">${track.ext || ''}</span>
        <span class="sp-dur">${track.duration_str || '--:--'}</span>
      `;

      item.addEventListener('click', () => {
        // Find track in main playlist and play it
        const mainIdx = S.playlist.findIndex(t => t.path === track.path);
        if (mainIdx >= 0 && typeof loadTrack === 'function') {
          loadTrack(mainIdx, true);
          close();
        }
      });

      frag.appendChild(item);
    });

    listEl.appendChild(frag);
  }

  // ── Open / Close ───────────────────────────────────────────
  function open(tab) {
    if (tab) activeTab = tab;
    isOpen = true;
    _syncTabs();
    render();
    overlay.classList.add('active');
  }

  function close() {
    isOpen = false;
    overlay.classList.remove('active');
  }

  function _syncTabs() {
    tabAudio.classList.toggle('active', activeTab === 'audio');
    tabVideo.classList.toggle('active', activeTab === 'video');
  }

  // ── Events ─────────────────────────────────────────────────
  btnClose.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  tabAudio.addEventListener('click', () => { activeTab = 'audio'; _syncTabs(); render(); });
  tabVideo.addEventListener('click', () => { activeTab = 'video'; _syncTabs(); render(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen) close();
  });

  // ── Helper ─────────────────────────────────────────────────
  function _spEsc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Public API ─────────────────────────────────────────────
  return { open, close, recordPlay, render };
})();

window.SmartPlaylist = SmartPlaylist;
