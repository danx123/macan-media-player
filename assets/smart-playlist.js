// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — SMART PLAYLIST MODULE
// Most-played tracks: audio (top 25) + video (top 25)
// LOAD button replaces queue with the top-25 list and plays.
// ═══════════════════════════════════════════════════════════════

const SmartPlaylist = (() => {
  const STORAGE_KEY = 'macan_play_counts';
  const MAX_TRACKS  = 25;

  let isOpen    = false;
  let activeTab = 'audio';

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

  function recordPlay(path) {
    if (!path) return;
    const counts = loadCounts();
    counts[path] = (counts[path] || 0) + 1;
    saveCounts(counts);
  }

  function getTopTracks(kind) {
    if (typeof S === 'undefined' || !Array.isArray(S.playlist)) return [];
    const counts = loadCounts();
    return S.playlist
      .filter(t => kind === 'video' ? t.is_video : !t.is_video)
      .filter(t => (counts[t.path] || 0) > 0)
      .sort((a, b) => (counts[b.path] || 0) - (counts[a.path] || 0))
      .slice(0, MAX_TRACKS);
  }

  // ── Load to Queue ───────────────────────────────────────────
  function loadToQueue() {
    const tracks = getTopTracks(activeTab);
    if (!tracks.length) return;

    // Clear queue then push top-25 tracks
    S.playlist = tracks.map(t => Object.assign({}, t));

    if (typeof renderPlaylist === 'function')     renderPlaylist();
    if (typeof updatePlaylistMeta === 'function') updatePlaylistMeta();
    if (typeof loadTrack === 'function' && S.playlist.length > 0) {
      loadTrack(0, true);
    }
    if (window.AchievementSystem) AchievementSystem.record('smartLoaded');

    // Brief success feedback then close
    const btn = document.getElementById('sp-load-btn');
    if (btn) {
      btn.textContent = '\u2713 LOADED!';
      setTimeout(() => close(), 700);
    } else {
      close();
    }
  }

  // ── Render ─────────────────────────────────────────────────
  function render() {
    const tracks = getTopTracks(activeTab);
    const counts = loadCounts();

    listEl.innerHTML = '';
    emptyEl.style.display = tracks.length === 0 ? 'flex' : 'none';
    listEl.style.display  = tracks.length === 0 ? 'none' : 'block';
    countEl.textContent   = tracks.length + ' TRACK' + (tracks.length !== 1 ? 'S' : '');

    const btn = document.getElementById('sp-load-btn');
    if (btn) btn.style.display = tracks.length > 0 ? 'flex' : 'none';

    if (!tracks.length) return;

    const frag = document.createDocumentFragment();
    tracks.forEach((track, i) => {
      const playCount = counts[track.path] || 0;
      const src = track.cover_art || track.video_thumb;
      const thumbHtml = src
        ? '<img class="sp-thumb" src="' + src + '" alt="" draggable="false">'
        : '<div class="sp-thumb sp-thumb-placeholder"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.35"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></div>';

      const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

      const item = document.createElement('div');
      item.className = 'sp-item';
      item.innerHTML =
        '<div class="sp-rank">' + (i+1) + '</div>' +
        thumbHtml +
        '<div class="sp-info">' +
          '<div class="sp-name">' + esc(track.name) + '</div>' +
          '<div class="sp-meta">' + (track.artist ? esc(track.artist) : '—') + (track.album ? ' · ' + esc(track.album) : '') + '</div>' +
        '</div>' +
        '<div class="sp-play-count">' +
          '<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" opacity="0.5"><polygon points="5,3 19,12 5,21"/></svg>' +
          '<span>' + playCount + '</span>' +
        '</div>' +
        '<span class="sp-ext">' + (track.ext || '') + '</span>' +
        '<span class="sp-dur">' + (track.duration_str || '--:--') + '</span>';

      item.addEventListener('click', () => {
        listEl.querySelectorAll('.sp-item.sp-selected').forEach(el => el.classList.remove('sp-selected'));
        item.classList.add('sp-selected');
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
  overlay.addEventListener('click', e => {
    if (e.target === overlay) close();
    if (e.target && e.target.id === 'sp-load-btn') loadToQueue();
  });
  tabAudio.addEventListener('click', () => { activeTab = 'audio'; _syncTabs(); render(); });
  tabVideo.addEventListener('click', () => { activeTab = 'video'; _syncTabs(); render(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) close(); });

  return { open, close, recordPlay, render, loadToQueue };
})();

window.SmartPlaylist = SmartPlaylist;
