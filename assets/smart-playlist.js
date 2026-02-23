// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — SMART PLAYLIST  (Patch 10 rewrite)
//
// FIXES:
//   1. Play counts stored independently from S.playlist — survive
//      clear(), reload, and cross-session restarts.
//   2. Track metadata (name/artist/album/ext/duration/art)
//      snapshotted on every play → stays visible after clear.
//   3. Cross-playlist aggregation: scans ALL named playlists via
//      PlaylistManager registry, not just the current queue.
//      Pool = macan_sp_meta ∪ S.playlist ∪ all named playlists.
// ═══════════════════════════════════════════════════════════════

const SmartPlaylist = (() => {
  const SK_COUNTS = 'macan_play_counts'; // { filePath → totalPlays }
  const SK_META   = 'macan_sp_meta';    // { filePath → {name,artist,...} }
  const MAX       = 25;

  let isOpen    = false;
  let activeTab = 'audio';

  const overlay  = document.getElementById('smart-playlist-overlay');
  const btnClose = document.getElementById('smart-playlist-close');
  const tabAudio = document.getElementById('sp-tab-audio');
  const tabVideo = document.getElementById('sp-tab-video');
  const listEl   = document.getElementById('sp-list');
  const countEl  = document.getElementById('sp-count');
  const emptyEl  = document.getElementById('sp-empty');

  // ── Persistent storage helpers ──────────────────────────────
  function _loadCounts() {
    try { return JSON.parse(localStorage.getItem(SK_COUNTS)) || {}; } catch { return {}; }
  }
  function _saveCounts(c) {
    try { localStorage.setItem(SK_COUNTS, JSON.stringify(c)); } catch {}
  }
  function _loadMeta() {
    try { return JSON.parse(localStorage.getItem(SK_META)) || {}; } catch { return {}; }
  }
  function _saveMeta(m) {
    try { localStorage.setItem(SK_META, JSON.stringify(m)); } catch {}
  }

  // ── recordPlay: increment count + snapshot metadata ─────────
  // Pass full track object so metadata survives queue clear.
  function recordPlay(path, track) {
    if (!path) return;
    // Increment count
    const counts = _loadCounts();
    counts[path] = (counts[path] || 0) + 1;
    _saveCounts(counts);
    // Snapshot metadata
    if (track) {
      const meta = _loadMeta();
      meta[path] = {
        name:      track.name      || '',
        artist:    track.artist    || '',
        album:     track.album     || '',
        ext:       track.ext       || '',
        dur:       track.duration_str || '',
        is_video:  !!track.is_video,
        cover_art: track.cover_art || '',
      };
      _saveMeta(meta);
    }
  }

  // ── Build unified candidate pool ────────────────────────────
  // Merges: persisted metadata + current queue + all named playlists.
  // Returns Map<path, trackObj> — richest available metadata wins.
  async function _buildPool() {
    const pool = new Map();

    // 1) Previously played tracks (from macan_sp_meta)
    const meta = _loadMeta();
    Object.entries(meta).forEach(([path, m]) => {
      pool.set(path, {
        path, name: m.name, artist: m.artist, album: m.album,
        ext: m.ext, duration_str: m.dur, is_video: m.is_video,
        cover_art: m.cover_art,
      });
    });

    // 2) Current queue (richest source, overrides meta)
    if (typeof S !== 'undefined' && Array.isArray(S.playlist)) {
      S.playlist.forEach(t => { if (t.path) pool.set(t.path, t); });
    }

    // 3) All named playlists via PlaylistManager
    if (typeof playlistManager !== 'undefined' && playlistManager.registry) {
      const names = Object.keys(playlistManager.registry);
      await Promise.all(names.map(async name => {
        try {
          const tracks = await playlistManager.loadPlaylistTracks(name);
          if (!Array.isArray(tracks)) return;
          tracks.forEach(t => {
            if (!t.path) return;
            if (!pool.has(t.path)) {
              pool.set(t.path, t);
            }
            // Also persist metadata for newly discovered tracks
            if (!meta[t.path]) {
              meta[t.path] = {
                name: t.name || '', artist: t.artist || '',
                album: t.album || '', ext: t.ext || '',
                dur: t.duration_str || '', is_video: !!t.is_video,
                cover_art: t.cover_art || '',
              };
            }
          });
        } catch (e) {
          console.warn('[SmartPlaylist] failed loading:', name, e);
        }
      }));
      _saveMeta(meta); // persist any newly discovered metadata
    }

    return pool;
  }

  // ── getTopTracks ────────────────────────────────────────────
  async function _getTopTracks(kind) {
    const counts = _loadCounts();
    const pool   = await _buildPool();
    return Array.from(pool.values())
      .filter(t => (kind === 'video') ? t.is_video : !t.is_video)
      .filter(t => (counts[t.path] || 0) > 0)
      .sort((a, b) => (counts[b.path] || 0) - (counts[a.path] || 0))
      .slice(0, MAX);
  }

  // ── Load to Queue ───────────────────────────────────────────
  async function loadToQueue() {
    const tracks = await _getTopTracks(activeTab);
    if (!tracks.length) return;

    S.playlist = tracks.map(t => ({ ...t }));
    if (typeof renderPlaylist    === 'function') renderPlaylist();
    if (typeof updatePlaylistMeta === 'function') updatePlaylistMeta();
    if (typeof loadTrack === 'function' && S.playlist.length > 0) loadTrack(0, true);
    if (window.AchievementSystem) AchievementSystem.record('smartLoaded');

    const btn = document.getElementById('sp-load-btn');
    if (btn) { btn.textContent = '✓ LOADED!'; setTimeout(() => close(), 700); }
    else close();
  }

  // ── Render ──────────────────────────────────────────────────
  async function render() {
    // Show loading indicator while async pool builds
    listEl.innerHTML = '<div class="sp-loading">LOADING…</div>';
    emptyEl.style.display = 'none';

    const tracks = await _getTopTracks(activeTab);
    const counts = _loadCounts();

    listEl.innerHTML = '';
    const empty = tracks.length === 0;
    emptyEl.style.display = empty ? 'flex'  : 'none';
    listEl.style.display  = empty ? 'none'  : 'block';
    countEl.textContent   = tracks.length + ' TRACK' + (tracks.length !== 1 ? 'S' : '');

    const btn = document.getElementById('sp-load-btn');
    if (btn) {
      btn.style.display = empty ? 'none' : 'flex';
      btn.textContent   = '▶ LOAD TO QUEUE';
    }
    if (empty) return;

    const esc = s => String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const frag = document.createDocumentFragment();
    tracks.forEach((track, i) => {
      const plays = counts[track.path] || 0;
      const src   = track.cover_art || track.video_thumb || '';
      const thumb = src
        ? '<img class="sp-thumb" src="' + src + '" alt="" draggable="false">'
        : '<div class="sp-thumb sp-thumb-placeholder"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.35"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></div>';

      const item = document.createElement('div');
      item.className    = 'sp-item';
      item.dataset.path = track.path;
      item.innerHTML =
        '<div class="sp-rank">' + (i + 1) + '</div>' +
        thumb +
        '<div class="sp-info">' +
          '<div class="sp-name">'  + esc(track.name || track.path.split(/[\\/]/).pop()) + '</div>' +
          '<div class="sp-meta">'  + (track.artist ? esc(track.artist) : '—') +
            (track.album ? ' · ' + esc(track.album) : '') + '</div>' +
        '</div>' +
        '<div class="sp-play-count" title="' + plays + '× played">' +
          '<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" opacity="0.5"><polygon points="5,3 19,12 5,21"/></svg>' +
          '<span>' + plays + '</span>' +
        '</div>' +
        '<span class="sp-ext">'  + esc(track.ext || '') + '</span>' +
        '<span class="sp-dur">'  + (track.duration_str || '--:--') + '</span>';

      item.addEventListener('click', () => {
        listEl.querySelectorAll('.sp-item.sp-selected').forEach(el => el.classList.remove('sp-selected'));
        item.classList.add('sp-selected');
      });
      frag.appendChild(item);
    });
    listEl.appendChild(frag);
  }

  // ── Open / Close ────────────────────────────────────────────
  async function open(tab) {
    if (tab) activeTab = tab;
    isOpen = true;
    _syncTabs();
    overlay.classList.add('active');
    await render();
  }
  function close() {
    isOpen = false;
    overlay.classList.remove('active');
  }
  function _syncTabs() {
    tabAudio.classList.toggle('active', activeTab === 'audio');
    tabVideo.classList.toggle('active', activeTab === 'video');
  }

  // ── Events ──────────────────────────────────────────────────
  btnClose.addEventListener('click', close);
  overlay.addEventListener('click', async e => {
    if (e.target === overlay) close();
    if (e.target && e.target.id === 'sp-load-btn') await loadToQueue();
  });
  tabAudio.addEventListener('click', () => { activeTab = 'audio'; _syncTabs(); render(); });
  tabVideo.addEventListener('click', () => { activeTab = 'video'; _syncTabs(); render(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) close(); });

  return { open, close, recordPlay, render, loadToQueue };
})();

window.SmartPlaylist = SmartPlaylist;
