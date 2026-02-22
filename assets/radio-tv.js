// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — RADIO & TV ONLINE MODULE
// Diadaptasi dari Macan Vision build25.py
// ═══════════════════════════════════════════════════════════════

const RTV = (() => {
  // ─── Storage Keys ──────────────────────────────────────────────
  const STORAGE_RADIO_CACHE   = 'macan_radio_cache';
  const STORAGE_RADIO_CUSTOM  = 'macan_radio_custom';
  const STORAGE_TV_CHANNELS   = 'macan_tv_channels';
  const STORAGE_TV_CUSTOM     = 'macan_tv_custom';
  const STORAGE_TV_LAST_SRC   = 'macan_tv_last_source';

  // ─── State ─────────────────────────────────────────────────────
  let radioStations   = [];   // all stations (cached + custom)
  let radioCustom     = [];   // user-added custom stations
  let radioFiltered   = [];   // after search filter
  let radioActive     = null; // { name, url, city }
  let radioAudio      = null; // HTMLAudioElement for streaming

  let tvChannels      = [];
  let tvCustom        = [];
  let tvFiltered      = [];
  let tvActive        = null;
  let tvAudio         = null; // audio element for TV audio-only streams
  let tvVideoEl       = null; // video element for TV (reuse existing #video-player)

  let radioOpen       = false;
  let tvOpen          = false;
  let tvSwitcherVisible = false;     // channel switcher overlay on video layer
  let tvSwitcherHideTimer = null;    // auto-hide timer
  let tvSwitcherQuery = '';          // search query in switcher

  // ─── DOM refs ──────────────────────────────────────────────────
  const radioOverlay      = document.getElementById('radio-overlay');
  const radioList         = document.getElementById('radio-list');
  const radioSearch       = document.getElementById('radio-search');
  const radioCount        = document.getElementById('radio-count');
  const radioStatus       = document.getElementById('radio-status');
  const radioNowPlaying   = document.getElementById('radio-now-playing');
  const radioNowName      = document.getElementById('radio-now-name');
  const radioNowMeta      = document.getElementById('radio-now-meta');
  const radioLiveBadge    = document.getElementById('radio-live-badge');
  const radioCustomRow    = document.getElementById('radio-custom-url-row');
  const radioCustomName   = document.getElementById('radio-custom-name');
  const radioCustomUrl    = document.getElementById('radio-custom-url');
  const radioVisBars      = document.getElementById('radio-vis-bars');
  const radioPlayBtn      = document.getElementById('radio-play-btn');
  const radioIconPlay     = document.getElementById('radio-icon-play');
  const radioIconStop     = document.getElementById('radio-icon-stop');
  const radioPrevBtn      = document.getElementById('radio-prev');
  const radioNextBtn      = document.getElementById('radio-next');
  const radioVolSlider    = document.getElementById('radio-vol-slider');
  const radioVolVal       = document.getElementById('radio-vol-val');
  const btnRadio          = document.getElementById('btn-radio');

  const tvOverlay         = document.getElementById('tv-overlay');
  const tvList            = document.getElementById('tv-list');
  const tvSearch          = document.getElementById('tv-search');
  const tvCount           = document.getElementById('tv-count');
  const tvStatus          = document.getElementById('tv-status');
  const tvNowPlaying      = document.getElementById('tv-now-playing');
  const tvNowName         = document.getElementById('tv-now-name');
  const tvNowMeta         = document.getElementById('tv-now-meta');
  const tvLiveBadge       = document.getElementById('tv-live-badge');
  const tvCustomRow       = document.getElementById('tv-custom-url-row');
  const tvCustomUrl       = document.getElementById('tv-custom-url');
  const tvSourceSelect    = document.getElementById('tv-source-select');
  const btnTv             = document.getElementById('btn-tv');
  const tvM3uFileInput    = document.getElementById('tv-m3u-file-input');

  // ═══════════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════════

  function loadJSON(key, fallback = []) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
  }

  function saveJSON(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
  }

  function setStatus(el, text) {
    if (el) el.textContent = text;
  }

  function showLoading(listEl, message = 'LOADING...') {
    listEl.innerHTML = `<div class="rtv-loading"><div class="rtv-spinner"></div><span>${message}</span></div>`;
  }

  function parseM3U(content) {
    const channels = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXTINF:')) {
        const namePart = line.split(',').slice(1).join(',').trim();
        const nextLine = (lines[i + 1] || '').trim();
        if (namePart && nextLine.match(/^https?:\/\//)) {
          channels.push({ name: namePart, url: nextLine });
          i++;
        }
      }
    }
    return channels;
  }


  // ─── SEEKBAR LIVE MODE ─────────────────────────────────────────
  // Disables the seekbar interaction when playing a live stream.
  // Live streams have Infinity duration — seeking makes no sense.
  function setSeekbarLiveMode(enabled) {
    const progressBar = document.getElementById('progress-bar');
    const progressFill = document.getElementById('progress-fill');
    const progressThumb = document.getElementById('progress-thumb');
    const timeCurrent = document.getElementById('time-current');
    const timeTotal = document.getElementById('time-total');

    if (enabled) {
      if (progressBar) {
        progressBar.style.pointerEvents = 'none';
        progressBar.style.opacity = '0.35';
        progressBar.style.cursor = 'default';
      }
      if (progressFill) progressFill.style.width = '0%';
      if (progressThumb) progressThumb.style.left = '0%';
      if (timeCurrent) timeCurrent.textContent = '● LIVE';
      if (timeTotal) timeTotal.textContent = '∞';
    } else {
      if (progressBar) {
        progressBar.style.pointerEvents = '';
        progressBar.style.opacity = '';
        progressBar.style.cursor = '';
      }
      if (timeCurrent) timeCurrent.textContent = '0:00';
      if (timeTotal) timeTotal.textContent = '0:00';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // AUDIO PLAYER (shared between Radio and TV audio streams)
  // ═══════════════════════════════════════════════════════════════

  function createAudioEl() {
    const a = document.createElement('audio');
    a.preload = 'none';
    a.style.display = 'none';
    document.body.appendChild(a);
    return a;
  }

  function stopRadioStream() {
    if (radioAudio) {
      radioAudio.pause();
      radioAudio.src = '';
    }
    radioActive = null;
    // Reset player UI
    radioNowName.textContent = '— SELECT A STATION —';
    radioNowMeta.textContent = 'RADIO ONLINE · MACAN';
    setStatus(radioStatus, 'IDLE');
    if (radioLiveBadge)  radioLiveBadge.style.display = 'none';
    if (radioVisBars)    radioVisBars.style.display = 'none';
    if (radioIconPlay)   radioIconPlay.style.display = '';
    if (radioIconStop)   radioIconStop.style.display = 'none';
    // Remove active highlight
    radioList.querySelectorAll('.rtv-item.active').forEach(el => el.classList.remove('active'));
    renderRadioList();
  }

  function stopTvStream() {
    if (tvAudio) {
      tvAudio.pause();
      tvAudio.src = '';
    }

    // Stop & properly close the shared video-layer
    const vp          = document.getElementById('video-player');
    const videoLayer  = document.getElementById('video-layer');
    const mainLayout  = document.getElementById('main-layout');

    if (vp) { vp.pause(); vp.src = ''; }
    if (videoLayer) videoLayer.classList.remove('active');
    if (mainLayout) mainLayout.style.display = '';

    // Re-enable seekbar (disabled in live mode)
    setSeekbarLiveMode(false);

    // Hide channel switcher if open
    hideChannelSwitcher();
    tvSwitcherQuery = '';
    const chsSearch = document.getElementById('tv-chs-search');
    if (chsSearch) chsSearch.value = '';

    tvActive = null;
    tvNowPlaying.style.display = 'none';
    tvLiveBadge.style.display = 'none';
    setStatus(tvStatus, 'IDLE');
    tvList.querySelectorAll('.rtv-item.active').forEach(el => el.classList.remove('active'));
    renderTvList();
  }

  // ═══════════════════════════════════════════════════════════════
  // RADIO
  // ═══════════════════════════════════════════════════════════════

  function loadRadioCustom() {
    radioCustom = loadJSON(STORAGE_RADIO_CUSTOM, []);
  }

  function saveRadioCustom() {
    saveJSON(STORAGE_RADIO_CUSTOM, radioCustom);
  }

  async function fetchRadioStations(forceRefresh = false) {
    loadRadioCustom();
    const cached = loadJSON(STORAGE_RADIO_CACHE, []);

    if (!forceRefresh && cached.length > 0) {
      radioStations = cached;
      mergeAndRenderRadio();
      setStatus(radioStatus, `${radioStations.length + radioCustom.length} stations loaded (cached)`);
      return;
    }

    showLoading(radioList, 'FETCHING STATIONS FROM RADIO-BROWSER.INFO...');
    setStatus(radioStatus, 'CONNECTING TO RADIO-BROWSER.INFO...');

    const RADIO_API = 'https://de2.api.radio-browser.info/json/stations/bycountrycodeexact/ID';
    try {
      const res = await fetch(RADIO_API);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      radioStations = data
        .filter(s => s.url_resolved && s.name)
        .map(s => ({
          name: s.name.trim(),
          url: s.url_resolved,
          city: s.state || s.city || '',
          tags: s.tags || '',
          codec: s.codec || '',
          bitrate: s.bitrate || 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      saveJSON(STORAGE_RADIO_CACHE, radioStations);
      mergeAndRenderRadio();
      setStatus(radioStatus, `${radioStations.length + radioCustom.length} stations loaded`);
    } catch (err) {
      radioList.innerHTML = `<div class="rtv-empty-state"><p>FAILED TO LOAD: ${err.message}</p><p style="font-size:8px;margin-top:6px;">CHECK INTERNET CONNECTION</p></div>`;
      setStatus(radioStatus, 'ERROR: ' + err.message);
    }
  }

  function mergeAndRenderRadio() {
    loadRadioCustom();
    const all = [
      ...radioCustom.map(s => ({ ...s, _custom: true })),
      ...radioStations,
    ];
    radioFiltered = all;
    renderRadioList();
    radioCount.textContent = `${all.length} stations`;
  }

  function filterRadio(query) {
    const q = query.toLowerCase();
    const all = [
      ...radioCustom.map(s => ({ ...s, _custom: true })),
      ...radioStations,
    ];
    radioFiltered = q
      ? all.filter(s => s.name.toLowerCase().includes(q) || (s.city || '').toLowerCase().includes(q) || (s.tags || '').toLowerCase().includes(q))
      : all;
    renderRadioList();
    radioCount.textContent = `${radioFiltered.length} stations`;
  }

  function renderRadioList() {
    if (radioFiltered.length === 0) {
      radioList.innerHTML = `<div class="rtv-empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#E8FF00" stroke-width="1" opacity="0.2">
          <rect x="3" y="10" width="18" height="11" rx="2"/>
          <path d="M7 10V7a5 5 0 0 1 10 0v3"/>
          <circle cx="12" cy="16" r="2"/>
        </svg>
        <p>NO STATIONS FOUND</p></div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    radioFiltered.forEach((station, idx) => {
      const isActive = radioActive && radioActive.url === station.url;
      const item = document.createElement('div');
      item.className = 'rtv-item' + (isActive ? ' active' : '');
      item.dataset.idx = idx;

      const meta = [station.city, station.codec, station.bitrate ? station.bitrate + 'kbps' : '']
        .filter(Boolean).join(' · ');

      item.innerHTML = `
        <div class="rtv-item-idx">${idx + 1}</div>
        <div class="rtv-item-info">
          <div class="rtv-item-name">${escapeHtml(station.name)}</div>
          ${meta ? `<div class="rtv-item-meta">${escapeHtml(meta)}</div>` : ''}
        </div>
        ${station._custom ? '<span class="rtv-item-badge">CUSTOM</span>' : ''}
        <button class="rtv-item-play" title="Play">
          ${isActive
            ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
            : '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>'}
        </button>
        ${station._custom ? `<button class="rtv-item-del" title="Delete">✕</button>` : ''}
      `;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.rtv-item-del')) {
          deleteRadioCustom(station.url);
          return;
        }
        playRadioStation(station);
      });

      frag.appendChild(item);
    });

    radioList.innerHTML = '';
    radioList.appendChild(frag);
  }

  function playRadioStation(station) {
    radioActive = station;

    // Stop main audio player if playing
    if (typeof window.pauseMainPlayer === 'function') window.pauseMainPlayer();

    if (!radioAudio) radioAudio = createAudioEl();

    radioAudio.pause();
    radioAudio.src = '';
    setStatus(radioStatus, 'CONNECTING...');

    // Update center player UI
    radioNowName.textContent = station.name;
    radioNowMeta.textContent = [station.city, station.codec, station.bitrate ? station.bitrate + 'kbps' : ''].filter(Boolean).join(' · ') || '—';
    if (radioLiveBadge) radioLiveBadge.style.display = 'none';
    if (radioVisBars)   radioVisBars.style.display = 'none';
    if (radioIconPlay)  radioIconPlay.style.display = 'none';
    if (radioIconStop)  radioIconStop.style.display = '';

    radioAudio.src = station.url;
    radioAudio.volume = radioVolSlider ? parseInt(radioVolSlider.value) / 100 : getVolume();
    radioAudio.play().then(() => {
      setStatus(radioStatus, '● LIVE — ' + station.name);
      if (radioLiveBadge) radioLiveBadge.style.display = 'inline';
      if (radioVisBars)   radioVisBars.style.display = 'flex';
    }).catch(err => {
      setStatus(radioStatus, 'ERROR: ' + err.message);
      if (radioIconPlay)  radioIconPlay.style.display = '';
      if (radioIconStop)  radioIconStop.style.display = 'none';
    });

    renderRadioList();
  }

  function deleteRadioCustom(url) {
    if (!confirm('Remove this custom station?')) return;
    radioCustom = radioCustom.filter(s => s.url !== url);
    saveRadioCustom();
    if (radioActive && radioActive.url === url) stopRadioStream();
    mergeAndRenderRadio();
  }

  function addRadioCustomStation() {
    const name = radioCustomName.value.trim();
    const url  = radioCustomUrl.value.trim();
    if (!name) { alert('Please enter a station name.'); return; }
    if (!url.startsWith('http')) { alert('Please enter a valid stream URL (must start with http).'); return; }

    const station = { name, url, city: 'Custom', _custom: true };
    radioCustom.unshift(station);
    saveRadioCustom();
    radioCustomRow.style.display = 'none';
    radioCustomName.value = '';
    radioCustomUrl.value = '';
    mergeAndRenderRadio();
    playRadioStation(station);
  }

  // ═══════════════════════════════════════════════════════════════
  // TV
  // ═══════════════════════════════════════════════════════════════

  function loadTvCustom() {
    tvCustom = loadJSON(STORAGE_TV_CUSTOM, []);
  }

  function saveTvCustom() {
    saveJSON(STORAGE_TV_CUSTOM, tvCustom);
  }

  async function fetchTvChannels(url) {
    loadTvCustom();
    showLoading(tvList, 'FETCHING CHANNEL LIST...');
    setStatus(tvStatus, 'LOADING M3U FROM: ' + url.split('/').pop());
    saveJSON(STORAGE_TV_LAST_SRC, url);

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const channels = parseM3U(text);

      if (channels.length === 0) throw new Error('No valid channels found in M3U');

      tvChannels = channels.sort((a, b) => a.name.localeCompare(b.name));
      saveJSON(STORAGE_TV_CHANNELS, tvChannels);
      mergeAndRenderTv();
      setStatus(tvStatus, `${tvChannels.length + tvCustom.length} channels loaded`);
    } catch (err) {
      tvList.innerHTML = `<div class="rtv-empty-state"><p>FAILED TO LOAD: ${err.message}</p><p style="font-size:8px;margin-top:6px;">CHECK INTERNET / TRY ANOTHER SOURCE</p></div>`;
      setStatus(tvStatus, 'ERROR: ' + err.message);
    }
  }

  function mergeAndRenderTv() {
    loadTvCustom();
    const all = [
      ...tvCustom.map(c => ({ ...c, _custom: true })),
      ...tvChannels,
    ];
    tvFiltered = all;
    renderTvList();
    tvCount.textContent = `${all.length} channels`;
  }

  function filterTv(query) {
    const q = query.toLowerCase();
    const all = [
      ...tvCustom.map(c => ({ ...c, _custom: true })),
      ...tvChannels,
    ];
    tvFiltered = q ? all.filter(c => c.name.toLowerCase().includes(q)) : all;
    renderTvList();
    tvCount.textContent = `${tvFiltered.length} channels`;
  }

  function renderTvList() {
    if (tvFiltered.length === 0) {
      tvList.innerHTML = `<div class="rtv-empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#E8FF00" stroke-width="1" opacity="0.2">
          <rect x="2" y="7" width="20" height="15" rx="2"/>
          <polyline points="17 2 12 7 7 2"/>
        </svg>
        <p>NO CHANNELS FOUND</p></div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    tvFiltered.forEach((ch, idx) => {
      const isActive = tvActive && tvActive.url === ch.url;
      const item = document.createElement('div');
      item.className = 'rtv-item' + (isActive ? ' active' : '');

      item.innerHTML = `
        <div class="rtv-item-idx">${idx + 1}</div>
        <div class="rtv-item-info">
          <div class="rtv-item-name">${escapeHtml(ch.name)}</div>
        </div>
        ${ch._custom ? '<span class="rtv-item-badge">CUSTOM</span>' : ''}
        <button class="rtv-item-play" title="Watch/Play">
          ${isActive
            ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
            : '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>'}
        </button>
        ${ch._custom ? `<button class="rtv-item-del" title="Delete">✕</button>` : ''}
      `;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.rtv-item-del')) {
          deleteTvCustom(ch.url);
          return;
        }
        playTvChannel(ch);
      });

      frag.appendChild(item);
    });

    tvList.innerHTML = '';
    tvList.appendChild(frag);
  }

  function playTvChannel(channel) {
    tvActive = channel;

    const videoLayer   = document.getElementById('video-layer');
    const videoPlayer  = document.getElementById('video-player');
    const mainLayout   = document.getElementById('main-layout');
    const vcTitleText  = document.getElementById('vc-title-text');

    setStatus(tvStatus, 'CONNECTING...');
    tvNowPlaying.style.display = 'flex';
    tvNowName.textContent = channel.name;
    tvNowMeta.textContent = 'LIVE TV STREAM';

    if (videoLayer && videoPlayer) {
      // Hide main layout, show video layer (same as Macan's own video playback)
      if (mainLayout) mainLayout.style.display = 'none';
      videoLayer.classList.add('active');
      if (vcTitleText) vcTitleText.textContent = channel.name.toUpperCase();

      // Update marquee
      const mt  = document.getElementById('marquee-text');
      const mtc = document.getElementById('marquee-text-clone');
      if (mt)  mt.textContent  = `● LIVE — ${channel.name}`;
      if (mtc) mtc.textContent = `● LIVE — ${channel.name}`;

      // Disable seekbar — live streams have Infinity duration
      setSeekbarLiveMode(true);

      videoPlayer.src = channel.url;
      videoPlayer.play().then(() => {
        setStatus(tvStatus, 'PLAYING: ' + channel.name);
        tvLiveBadge.style.display = 'inline';
      }).catch(err => {
        // Stream not natively supported — hide video layer, fallback audio
        videoLayer.classList.remove('active');
        if (mainLayout) mainLayout.style.display = '';
        setSeekbarLiveMode(false);
        setStatus(tvStatus, 'NOTE: Native playback failed. URL: ' + channel.url);

        if (!tvAudio) tvAudio = createAudioEl();
        tvAudio.src = channel.url;
        tvAudio.volume = getVolume();
        tvAudio.play().catch(() => {
          setStatus(tvStatus, 'STREAM NOT SUPPORTED IN BROWSER. TRY A DIFFERENT CHANNEL.');
        });
      });
    } else {
      // No video layer — audio only fallback
      if (!tvAudio) tvAudio = createAudioEl();
      tvAudio.pause();
      tvAudio.src = channel.url;
      tvAudio.volume = getVolume();
      tvAudio.play().then(() => {
        setStatus(tvStatus, 'PLAYING (audio): ' + channel.name);
        tvLiveBadge.style.display = 'inline';
      }).catch(err => {
        setStatus(tvStatus, 'ERROR: ' + err.message);
      });
    }

    renderTvList();
  }

  function deleteTvCustom(url) {
    if (!confirm('Remove this custom channel?')) return;
    tvCustom = tvCustom.filter(c => c.url !== url);
    saveTvCustom();
    if (tvActive && tvActive.url === url) stopTvStream();
    mergeAndRenderTv();
  }

  function addTvCustomChannel() {
    const url = tvCustomUrl.value.trim();
    if (!url.startsWith('http')) { alert('Please enter a valid stream or .m3u URL.'); return; }

    if (url.toLowerCase().endsWith('.m3u') || url.toLowerCase().endsWith('.m3u8')) {
      // Fetch as playlist
      tvCustomRow.style.display = 'none';
      tvCustomUrl.value = '';
      fetchTvChannels(url);
      return;
    }

    // Single stream URL
    const hostname = (() => { try { return new URL(url).hostname; } catch { return 'Custom'; } })();
    const channel = { name: `${hostname} (Custom)`, url, _custom: true };
    tvCustom.unshift(channel);
    saveTvCustom();
    tvCustomRow.style.display = 'none';
    tvCustomUrl.value = '';
    mergeAndRenderTv();
    playTvChannel(channel);
  }

  function loadM3UFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const channels = parseM3U(e.target.result);
      if (channels.length === 0) { alert('No valid channels found in this M3U file.'); return; }
      tvChannels = channels.sort((a, b) => a.name.localeCompare(b.name));
      saveJSON(STORAGE_TV_CHANNELS, tvChannels);
      mergeAndRenderTv();
      setStatus(tvStatus, `${tvChannels.length} channels loaded from file`);
    };
    reader.readAsText(file);
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  function getVolume() {
    const slider = document.getElementById('volume-slider');
    return slider ? parseInt(slider.value) / 100 : 0.8;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ═══════════════════════════════════════════════════════════════
  // OVERLAY OPEN / CLOSE
  // ═══════════════════════════════════════════════════════════════

  function openRadio() {
    radioOverlay.classList.add('active');
    radioOpen = true;
    btnRadio.classList.add('active');

    // Close TV if open
    if (tvOpen) closeTv();

    // Load cached stations if list is empty
    if (radioFiltered.length === 0) {
      loadRadioCustom();
      const cached = loadJSON(STORAGE_RADIO_CACHE, []);
      if (cached.length > 0) {
        radioStations = cached;
        mergeAndRenderRadio();
        setStatus(radioStatus, `${radioStations.length + radioCustom.length} stations (cached)`);
      } else {
        radioList.innerHTML = `<div class="rtv-empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#E8FF00" stroke-width="1" opacity="0.2">
            <rect x="3" y="10" width="18" height="11" rx="2"/>
            <path d="M7 10V7a5 5 0 0 1 10 0v3"/>
            <circle cx="12" cy="16" r="2"/>
          </svg>
          <p>PRESS REFRESH TO LOAD STATIONS</p>
        </div>`;
        // Auto-fetch on first open
        fetchRadioStations(false);
      }
    }
  }

  function closeRadio() {
    radioOverlay.classList.remove('active');
    radioOpen = false;
    btnRadio.classList.remove('active');
  }

  function openTv() {
    tvOverlay.classList.add('active');
    tvOpen = true;
    btnTv.classList.add('active');

    // Close Radio if open
    if (radioOpen) closeRadio();

    // Load cached channels if list is empty
    if (tvFiltered.length === 0) {
      loadTvCustom();
      const cached = loadJSON(STORAGE_TV_CHANNELS, []);
      if (cached.length > 0) {
        tvChannels = cached;
        mergeAndRenderTv();
        setStatus(tvStatus, `${tvChannels.length + tvCustom.length} channels (cached)`);
      } else {
        // auto-fetch default source (Indonesia IPTV)
        const lastSrc = loadJSON(STORAGE_TV_LAST_SRC) || tvSourceSelect.value;
        if (lastSrc) {
          // set selector to match saved
          tvSourceSelect.value = lastSrc;
          fetchTvChannels(lastSrc);
        }
      }
    }
  }

  function closeTv() {
    tvOverlay.classList.remove('active');
    tvOpen = false;
    btnTv.classList.remove('active');
  }


  // ═══════════════════════════════════════════════════════════════
  // TV CHANNEL SWITCHER (in-video overlay, shows on mouse move)
  // ═══════════════════════════════════════════════════════════════

  function createChannelSwitcherDOM() {
    if (document.getElementById('tv-ch-switcher')) return;

    const el = document.createElement('div');
    el.id = 'tv-ch-switcher';
    el.className = 'tv-ch-switcher';
    el.innerHTML = `
      <div class="tv-chs-header">
        <div class="tv-chs-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>
          </svg>
          <span>CHANNELS</span>
        </div>
        <span class="tv-chs-count" id="tv-chs-count"></span>
      </div>
      <div class="tv-chs-search-wrap">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" id="tv-chs-search" class="tv-chs-search" placeholder="FILTER..."/>
        <button class="tv-chs-clear" id="tv-chs-clear" style="display:none">✕</button>
      </div>
      <div class="tv-chs-list" id="tv-chs-list"></div>
      <div class="tv-chs-hint">MOVE MOUSE AWAY TO HIDE</div>
    `;

    // Append inside video-layer so it stays inside the fullscreen context
    const videoLayer = document.getElementById('video-layer');
    if (videoLayer) videoLayer.appendChild(el);

    // Search inside switcher
    const searchEl = el.querySelector('#tv-chs-search');
    const clearBtn = el.querySelector('#tv-chs-clear');
    searchEl.addEventListener('input', () => {
      tvSwitcherQuery = searchEl.value;
      clearBtn.style.display = tvSwitcherQuery ? 'flex' : 'none';
      renderChannelSwitcher();
    });
    clearBtn.addEventListener('click', () => {
      tvSwitcherQuery = '';
      searchEl.value = '';
      clearBtn.style.display = 'none';
      renderChannelSwitcher();
      searchEl.focus();
    });

    // Prevent mouse events from bubbling to video layer (would reset hide timer)
    el.addEventListener('mouseenter', () => {
      clearTimeout(tvSwitcherHideTimer);
    });
    el.addEventListener('mouseleave', () => {
      scheduleHideSwitcher();
    });
  }

  function renderChannelSwitcher() {
    const listEl   = document.getElementById('tv-chs-list');
    const countEl  = document.getElementById('tv-chs-count');
    if (!listEl) return;

    const all = [
      ...tvCustom.map(c => ({ ...c, _custom: true })),
      ...tvChannels,
    ];

    const q = tvSwitcherQuery.toLowerCase();
    const filtered = q ? all.filter(c => c.name.toLowerCase().includes(q)) : all;

    if (countEl) countEl.textContent = `${filtered.length}/${all.length}`;

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="tv-chs-empty">NO CHANNELS MATCH</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach((ch, idx) => {
      const isActive = tvActive && tvActive.url === ch.url;
      const item = document.createElement('div');
      item.className = 'tv-chs-item' + (isActive ? ' active' : '');
      item.innerHTML = `
        <span class="tv-chs-idx">${idx + 1}</span>
        <span class="tv-chs-name">${escapeHtml(ch.name)}</span>
        ${isActive ? `<span class="tv-chs-live-dot">●</span>` : ''}
      `;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        playTvChannel(ch);
        renderChannelSwitcher();      // refresh active highlight
        scheduleHideSwitcher(2000);   // hide after 2s
      });
      frag.appendChild(item);
    });

    listEl.innerHTML = '';
    listEl.appendChild(frag);

    // Scroll active item into view
    const activeEl = listEl.querySelector('.tv-chs-item.active');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function showChannelSwitcher() {
    createChannelSwitcherDOM();
    const switcher = document.getElementById('tv-ch-switcher');
    if (!switcher) return;

    // Re-render with latest channel list
    renderChannelSwitcher();

    switcher.classList.add('visible');
    tvSwitcherVisible = true;
    scheduleHideSwitcher();
  }

  function hideChannelSwitcher() {
    const switcher = document.getElementById('tv-ch-switcher');
    if (switcher) switcher.classList.remove('visible');
    tvSwitcherVisible = false;
    clearTimeout(tvSwitcherHideTimer);
  }

  function scheduleHideSwitcher(delay = 3500) {
    clearTimeout(tvSwitcherHideTimer);
    tvSwitcherHideTimer = setTimeout(() => {
      // Don't hide if search input is focused
      const searchEl = document.getElementById('tv-chs-search');
      if (searchEl && document.activeElement === searchEl) {
        scheduleHideSwitcher();
        return;
      }
      hideChannelSwitcher();
    }, delay);
  }

  function initVideoLayerMouseEvents() {
    const videoLayer = document.getElementById('video-layer');
    if (!videoLayer) return;

    let mouseMoveThrottle = null;

    videoLayer.addEventListener('mousemove', () => {
      if (!tvActive) return;            // only show when TV is playing
      if (mouseMoveThrottle) return;
      mouseMoveThrottle = setTimeout(() => { mouseMoveThrottle = null; }, 120);

      if (!tvSwitcherVisible) {
        showChannelSwitcher();
      } else {
        // Reset the auto-hide timer on each move
        clearTimeout(tvSwitcherHideTimer);
        scheduleHideSwitcher();
      }
    });

    // Keyboard navigation inside switcher (up/down/enter)
    videoLayer.addEventListener('keydown', (e) => {
      if (!tvActive || !tvSwitcherVisible) return;
      const listEl = document.getElementById('tv-chs-list');
      if (!listEl) return;
      const items = [...listEl.querySelectorAll('.tv-chs-item')];
      if (!items.length) return;

      const activeIdx = items.findIndex(el => el.classList.contains('active'));

      if (e.key === 'ArrowDown') {
        e.stopPropagation();
        const next = items[(activeIdx + 1) % items.length];
        if (next) { next.click(); }
      } else if (e.key === 'ArrowUp') {
        e.stopPropagation();
        const prev = items[(activeIdx - 1 + items.length) % items.length];
        if (prev) { prev.click(); }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════════

  // ── Radio modal ──────────────────────────────────────────────
  if (btnRadio) btnRadio.addEventListener('click', () => { radioOpen ? closeRadio() : openRadio(); });
  document.getElementById('radio-close').addEventListener('click', closeRadio);
  // Click outside modal panel closes it
  radioOverlay.addEventListener('click', e => {
    if (e.target === radioOverlay) closeRadio();
  });

  document.getElementById('radio-refresh').addEventListener('click', () => fetchRadioStations(true));
  radioSearch.addEventListener('input', () => filterRadio(radioSearch.value));

  document.getElementById('radio-add-custom').addEventListener('click', () => {
    radioCustomRow.style.display = radioCustomRow.style.display === 'none' ? 'flex' : 'none';
  });
  document.getElementById('radio-custom-save').addEventListener('click', addRadioCustomStation);
  document.getElementById('radio-custom-cancel').addEventListener('click', () => {
    radioCustomRow.style.display = 'none';
    radioCustomName.value = '';
    radioCustomUrl.value = '';
  });
  radioCustomUrl.addEventListener('keydown', e => { if (e.key === 'Enter') addRadioCustomStation(); });
  radioCustomName.addEventListener('keydown', e => { if (e.key === 'Enter') radioCustomUrl.focus(); });

  // ── Radio player controls ──────────────────────────────────
  // Play/Stop toggle button
  if (radioPlayBtn) {
    radioPlayBtn.addEventListener('click', () => {
      if (radioActive) {
        stopRadioStream();
      } else if (radioFiltered.length > 0) {
        playRadioStation(radioFiltered[0]);
      }
    });
  }

  // Previous station
  if (radioPrevBtn) {
    radioPrevBtn.addEventListener('click', () => {
      if (!radioFiltered.length) return;
      let idx = radioActive ? radioFiltered.findIndex(s => s.url === radioActive.url) : 0;
      idx = (idx - 1 + radioFiltered.length) % radioFiltered.length;
      playRadioStation(radioFiltered[idx]);
    });
  }

  // Next station
  if (radioNextBtn) {
    radioNextBtn.addEventListener('click', () => {
      if (!radioFiltered.length) return;
      let idx = radioActive ? radioFiltered.findIndex(s => s.url === radioActive.url) : -1;
      idx = (idx + 1) % radioFiltered.length;
      playRadioStation(radioFiltered[idx]);
    });
  }

  // Volume slider (radio-specific)
  if (radioVolSlider) {
    radioVolSlider.addEventListener('input', () => {
      const v = parseInt(radioVolSlider.value) / 100;
      if (radioVolVal) radioVolVal.textContent = radioVolSlider.value;
      if (radioAudio) radioAudio.volume = v;
    });
  }

  // TV overlay
  btnTv.addEventListener('click', () => { tvOpen ? closeTv() : openTv(); });
  document.getElementById('tv-close').addEventListener('click', closeTv);
  tvOverlay.addEventListener('click', e => { if (e.target === tvOverlay) closeTv(); });

  tvSearch.addEventListener('input', () => filterTv(tvSearch.value));

  document.getElementById('tv-refresh').addEventListener('click', () => {
    fetchTvChannels(tvSourceSelect.value);
  });

  tvSourceSelect.addEventListener('change', () => {
    fetchTvChannels(tvSourceSelect.value);
  });

  document.getElementById('tv-load-m3u').addEventListener('click', () => {
    tvM3uFileInput.click();
  });

  tvM3uFileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) loadM3UFile(file);
    e.target.value = '';
  });

  document.getElementById('tv-stop').addEventListener('click', stopTvStream);

  document.getElementById('tv-custom-play').addEventListener('click', addTvCustomChannel);
  document.getElementById('tv-custom-cancel').addEventListener('click', () => {
    tvCustomRow.style.display = 'none';
    tvCustomUrl.value = '';
  });
  tvCustomUrl.addEventListener('keydown', e => { if (e.key === 'Enter') addTvCustomChannel(); });

  // Add URL button for TV
  (() => {
    const addUrlBtn = document.createElement('button');
    addUrlBtn.className = 'rtv-action-btn';
    addUrlBtn.id = 'tv-add-url-btn';
    addUrlBtn.title = 'Enter custom stream URL';
    addUrlBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>ADD URL`;
    document.getElementById('tv-refresh').after(addUrlBtn);
    addUrlBtn.addEventListener('click', () => {
      tvCustomRow.style.display = tvCustomRow.style.display === 'none' ? 'flex' : 'none';
    });
  })();

  // Sync main volume slider changes to TV audio (radio has own slider)
  const volSlider = document.getElementById('volume-slider');
  if (volSlider) {
    volSlider.addEventListener('input', () => {
      const v = parseInt(volSlider.value) / 100;
      if (tvAudio) tvAudio.volume = v;
    });
  }

  // Intercept vc-close: when TV playing, stop stream cleanly
  const vcCloseBtn = document.getElementById('vc-close');
  if (vcCloseBtn) {
    vcCloseBtn.addEventListener('click', () => {
      if (tvActive) stopTvStream();
    }, true);
  }

  // Init mouse-move channel switcher on video layer
  initVideoLayerMouseEvents();

  // Keyboard shortcut: Escape
  // - If TV is actively playing (fullscreen mode) → stop TV entirely (single press)
  // - If channel switcher visible but TV not playing → hide switcher only
  // - If radio/TV overlay open → close overlay
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (tvActive) {
      // TV fullscreen mode — one ESC press stops everything and returns to main layout
      hideChannelSwitcher();
      stopTvStream();
      return;
    }
    if (tvSwitcherVisible) { hideChannelSwitcher(); return; }
    if (radioOpen) closeRadio();
    if (tvOpen) closeTv();
  });

  // ── Public API ──────────────────────────────────────────────────
  return {
    openRadio, closeRadio,
    openTv,    closeTv,
    stopRadioStream,
    stopTvStream,
    showChannelSwitcher,
    hideChannelSwitcher,
    // Allow main script to inform RTV that main player stopped
    onMainPlayerStarted: () => {
      // Optionally pause radio/tv when main player starts
      // (comment out if you want them to coexist)
      if (radioActive) stopRadioStream();
      if (tvActive)    stopTvStream();
    },
  };
})();

// Expose globally for integration
window.RTV = RTV;
