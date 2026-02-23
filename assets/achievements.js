// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — ACHIEVEMENT SYSTEM
// Badges earned through listening behavior and app usage.
// Unlocked achievements stored in localStorage.
// ═══════════════════════════════════════════════════════════════

const AchievementSystem = (() => {
  const SK_UNLOCKED  = 'macan_achievements';
  const SK_NOTIFIED  = 'macan_ach_notified';
  let isOpen = false;

  // ── Achievement Definitions ────────────────────────────────
  // Each achievement: id, name, desc, icon (emoji or SVG class),
  // tier (bronze/silver/gold/platinum), condition fn → bool
  const ACHIEVEMENTS = [
    // ── First Steps ─────────────────────────────
    {
      id: 'first_play',
      name: 'First Note',
      desc: 'Play your first track.',
      emoji: '🎵',
      tier: 'bronze',
      check: (s) => s.totalPlays >= 1,
    },
    {
      id: 'first_folder',
      name: 'Collector',
      desc: 'Load a folder into the queue.',
      emoji: '📁',
      tier: 'bronze',
      check: (s) => s.foldersOpened >= 1,
    },
    {
      id: 'eq_opened',
      name: 'Sound Engineer',
      desc: 'Open the equalizer for the first time.',
      emoji: '🎛️',
      tier: 'bronze',
      check: (s) => s.eqOpened >= 1,
    },
    {
      id: 'lyrics_opened',
      name: 'Word for Word',
      desc: 'Look up lyrics for a track.',
      emoji: '📜',
      tier: 'bronze',
      check: (s) => s.lyricsOpened >= 1,
    },
    {
      id: 'radio_played',
      name: 'Airwaves',
      desc: 'Listen to an online radio station.',
      emoji: '📻',
      tier: 'bronze',
      check: (s) => s.radioPlayed >= 1,
    },
    {
      id: 'tv_watched',
      name: 'Channel Surfer',
      desc: 'Watch an online TV channel.',
      emoji: '📺',
      tier: 'bronze',
      check: (s) => s.tvWatched >= 1,
    },
    // ── Listening Time ───────────────────────────
    {
      id: 'listen_10m',
      name: 'Warming Up',
      desc: 'Listen for 10 minutes total.',
      emoji: '⏱️',
      tier: 'bronze',
      check: (s) => s.totalListenSec >= 600,
    },
    {
      id: 'listen_1h',
      name: 'In the Zone',
      desc: 'Reach 1 hour of total listening time.',
      emoji: '🎧',
      tier: 'silver',
      check: (s) => s.totalListenSec >= 3600,
    },
    {
      id: 'listen_5h',
      name: 'Dedicated Listener',
      desc: 'Reach 5 hours of total listening time.',
      emoji: '🔊',
      tier: 'silver',
      check: (s) => s.totalListenSec >= 18000,
    },
    {
      id: 'listen_24h',
      name: 'Marathon Ears',
      desc: 'Accumulate a full 24 hours of listening.',
      emoji: '🏅',
      tier: 'gold',
      check: (s) => s.totalListenSec >= 86400,
    },
    {
      id: 'listen_100h',
      name: 'Audiophile',
      desc: 'A hundred hours of pure sound. Legendary.',
      emoji: '🏆',
      tier: 'platinum',
      check: (s) => s.totalListenSec >= 360000,
    },
    // ── Tracks Played ───────────────────────────
    {
      id: 'plays_10',
      name: 'Getting Comfortable',
      desc: 'Play 10 tracks.',
      emoji: '▶️',
      tier: 'bronze',
      check: (s) => s.totalPlays >= 10,
    },
    {
      id: 'plays_50',
      name: 'Regular',
      desc: 'Play 50 tracks.',
      emoji: '🎼',
      tier: 'silver',
      check: (s) => s.totalPlays >= 50,
    },
    {
      id: 'plays_200',
      name: 'Music Lover',
      desc: 'Play 200 tracks.',
      emoji: '💿',
      tier: 'gold',
      check: (s) => s.totalPlays >= 200,
    },
    {
      id: 'plays_1000',
      name: 'Discophile',
      desc: 'One thousand tracks played. Unstoppable.',
      emoji: '🌟',
      tier: 'platinum',
      check: (s) => s.totalPlays >= 1000,
    },
    // ── Smart Playlist ───────────────────────────
    {
      id: 'smart_loaded',
      name: 'Taste Curator',
      desc: 'Load a Smart Playlist into the queue.',
      emoji: '⭐',
      tier: 'silver',
      check: (s) => s.smartLoaded >= 1,
    },
    // ── Converter ────────────────────────────────
    {
      id: 'converted_file',
      name: 'Format Shifter',
      desc: 'Convert a file using the built-in converter.',
      emoji: '🔄',
      tier: 'silver',
      check: (s) => s.filesConverted >= 1,
    },
    // ── Streaks ──────────────────────────────────
    {
      id: 'streak_3',
      name: 'Three-Day Streak',
      desc: 'Listen on 3 consecutive days.',
      emoji: '🔥',
      tier: 'silver',
      check: (s) => s.listenStreak >= 3,
    },
    {
      id: 'streak_7',
      name: 'Week of Sound',
      desc: 'Listen on 7 consecutive days.',
      emoji: '🗓️',
      tier: 'gold',
      check: (s) => s.listenStreak >= 7,
    },
    {
      id: 'streak_30',
      name: 'Sound Monk',
      desc: '30 days straight. True dedication.',
      emoji: '🧘',
      tier: 'platinum',
      check: (s) => s.listenStreak >= 30,
    },
    // ── Night Owl / Early Bird ───────────────────
    {
      id: 'night_owl',
      name: 'Night Owl',
      desc: 'Play a track after midnight.',
      emoji: '🦉',
      tier: 'silver',
      check: (s) => s.nightOwl >= 1,
    },
    {
      id: 'early_bird',
      name: 'Early Bird',
      desc: 'Play a track before 6 AM.',
      emoji: '🌅',
      tier: 'silver',
      check: (s) => s.earlyBird >= 1,
    },
    // ── Video ────────────────────────────────────
    {
      id: 'first_video',
      name: 'Visual Listener',
      desc: 'Play your first video file.',
      emoji: '🎬',
      tier: 'bronze',
      check: (s) => s.videosPlayed >= 1,
    },
    {
      id: 'videos_10',
      name: 'Screenwatcher',
      desc: 'Play 10 video files.',
      emoji: '🎞️',
      tier: 'silver',
      check: (s) => s.videosPlayed >= 10,
    },
    // ── Secret ───────────────────────────────────
    {
      id: 'loyal_user',
      name: 'Loyal User',
      desc: 'Use Macan for more than 7 days since first launch.',
      emoji: '🐯',
      tier: 'gold',
      check: (s) => s.daysSinceInstall >= 7,
    },
  ];

  // ── Stat Storage ────────────────────────────────────────────
  const SK_STATS = 'macan_ach_stats';
  const SK_INSTALL = 'macan_install_date';

  function _loadStats() {
    try { return JSON.parse(localStorage.getItem(SK_STATS)) || {}; }
    catch { return {}; }
  }
  function _saveStats(s) {
    try { localStorage.setItem(SK_STATS, JSON.stringify(s)); } catch {}
  }
  function _loadUnlocked() {
    try { return JSON.parse(localStorage.getItem(SK_UNLOCKED)) || []; }
    catch { return []; }
  }
  function _saveUnlocked(u) {
    try { localStorage.setItem(SK_UNLOCKED, JSON.stringify(u)); } catch {}
  }

  function _initInstallDate() {
    if (!localStorage.getItem(SK_INSTALL)) {
      localStorage.setItem(SK_INSTALL, new Date().toISOString().slice(0, 10));
    }
  }

  function _daysSinceInstall() {
    const d = localStorage.getItem(SK_INSTALL);
    if (!d) return 0;
    return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  }

  function _listenStreak() {
    const daily = (() => {
      try { return JSON.parse(localStorage.getItem('macan_listen_daily')) || {}; }
      catch { return {}; }
    })();
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 366; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      if (daily[key] && daily[key] > 0) streak++;
      else if (i > 0) break; // gap — stop
    }
    return streak;
  }

  function _totalListenSec() {
    try {
      const d = JSON.parse(localStorage.getItem('macan_listen_daily')) || {};
      return Object.values(d).reduce((a, v) => a + v, 0);
    } catch { return 0; }
  }

  // ── Build full stats snapshot ────────────────────────────────
  function _buildStats() {
    const s = _loadStats();
    return {
      totalPlays:      s.totalPlays      || 0,
      videosPlayed:    s.videosPlayed    || 0,
      foldersOpened:   s.foldersOpened   || 0,
      eqOpened:        s.eqOpened        || 0,
      lyricsOpened:    s.lyricsOpened    || 0,
      radioPlayed:     s.radioPlayed     || 0,
      tvWatched:       s.tvWatched       || 0,
      smartLoaded:     s.smartLoaded     || 0,
      filesConverted:  s.filesConverted  || 0,
      nightOwl:        s.nightOwl        || 0,
      earlyBird:       s.earlyBird       || 0,
      totalListenSec:  _totalListenSec(),
      listenStreak:    _listenStreak(),
      daysSinceInstall: _daysSinceInstall(),
    };
  }

  // ── Record stat events ───────────────────────────────────────
  function record(event, value = 1) {
    const s = _loadStats();
    s[event] = (s[event] || 0) + value;
    _saveStats(s);
    _checkAll();

    // Time-of-day events
    if (event === 'totalPlays') {
      const h = new Date().getHours();
      if (h >= 0 && h < 5) { s.nightOwl = (s.nightOwl||0)+1; _saveStats(s); }
      if (h >= 4 && h < 6) { s.earlyBird = (s.earlyBird||0)+1; _saveStats(s); }
    }
  }

  // ── Check and unlock ─────────────────────────────────────────
  function _checkAll() {
    const unlocked = _loadUnlocked();
    const notified = (() => {
      try { return JSON.parse(localStorage.getItem(SK_NOTIFIED)) || []; }
      catch { return []; }
    })();
    const stats = _buildStats();
    let changed = false;

    ACHIEVEMENTS.forEach(ach => {
      if (!unlocked.includes(ach.id) && ach.check(stats)) {
        unlocked.push(ach.id);
        changed = true;
        // Show toast notification if not yet notified
        if (!notified.includes(ach.id)) {
          notified.push(ach.id);
          try { localStorage.setItem(SK_NOTIFIED, JSON.stringify(notified)); } catch {}
          _showToast(ach);
        }
      }
    });

    if (changed) {
      _saveUnlocked(unlocked);
      if (isOpen) render();
      _updateMenuBadge();
    }
  }

  // ── Toast notification ───────────────────────────────────────
  function _showToast(ach) {
    const tier = { bronze: '#cd7f32', silver: '#c0c0c0', gold: '#ffd700', platinum: '#e5e4e2' };
    const toast = document.createElement('div');
    toast.className = 'ach-toast';
    toast.innerHTML =
      '<div class="ach-toast-icon">' + ach.emoji + '</div>' +
      '<div class="ach-toast-info">' +
        '<div class="ach-toast-title">ACHIEVEMENT UNLOCKED</div>' +
        '<div class="ach-toast-name" style="color:' + (tier[ach.tier]||'#E8FF00') + '">' + ach.name + '</div>' +
        '<div class="ach-toast-desc">' + ach.desc + '</div>' +
      '</div>';
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 500);
    }, 4000);
  }

  // ── Update menu badge (unread count) ─────────────────────────
  function _updateMenuBadge() {
    const unlocked = _loadUnlocked();
    const badge = document.getElementById('nm-ach-badge');
    if (badge) {
      badge.textContent = unlocked.length;
      badge.style.display = unlocked.length > 0 ? 'inline-flex' : 'none';
    }
  }

  // ── Tier colors / labels ─────────────────────────────────────
  const TIER = {
    bronze:   { color: '#cd7f32', label: 'BRONZE',   glow: 'rgba(205,127,50,0.3)' },
    silver:   { color: '#c0c0c0', label: 'SILVER',   glow: 'rgba(192,192,192,0.3)' },
    gold:     { color: '#ffd700', label: 'GOLD',     glow: 'rgba(255,215,0,0.4)' },
    platinum: { color: '#e5e4e2', label: 'PLATINUM', glow: 'rgba(229,228,226,0.4)' },
  };

  // ── Render panel ─────────────────────────────────────────────
  function render() {
    const unlocked = _loadUnlocked();
    const grid = document.getElementById('ach-grid');
    if (!grid) return;

    grid.innerHTML = '';
    const frag = document.createDocumentFragment();

    ACHIEVEMENTS.forEach(ach => {
      const isUnlocked = unlocked.includes(ach.id);
      const t = TIER[ach.tier] || TIER.bronze;
      const card = document.createElement('div');
      card.className = 'ach-card' + (isUnlocked ? ' unlocked' : ' locked');
      card.style.setProperty('--tier-color', t.color);
      card.style.setProperty('--tier-glow',  t.glow);
      card.innerHTML =
        '<div class="ach-card-badge">' +
          '<span class="ach-emoji">' + (isUnlocked ? ach.emoji : '🔒') + '</span>' +
        '</div>' +
        '<div class="ach-card-info">' +
          '<div class="ach-card-name">' + ach.name + '</div>' +
          '<div class="ach-card-desc">' + ach.desc + '</div>' +
          '<span class="ach-tier-badge" style="color:' + t.color + ';border-color:' + t.color + '">' + t.label + '</span>' +
        '</div>';
      frag.appendChild(card);
    });

    grid.appendChild(frag);

    // Update counters
    const el = id => document.getElementById(id);
    if (el('ach-count-unlocked')) el('ach-count-unlocked').textContent = unlocked.length;
    if (el('ach-count-total'))    el('ach-count-total').textContent    = ACHIEVEMENTS.length;
    if (el('ach-progress-bar'))   el('ach-progress-bar').style.width  = (unlocked.length / ACHIEVEMENTS.length * 100) + '%';
  }

  // ── Open / Close ────────────────────────────────────────────
  function open() {
    isOpen = true;
    render();
    document.getElementById('achievements-overlay').classList.add('active');
  }
  function close() {
    isOpen = false;
    document.getElementById('achievements-overlay').classList.remove('active');
  }

  // ── Public: stat reset hook ──────────────────────────────────
  function _onStatsReset() {
    // listening time cleared, re-check (some may de-qualify, keep unlocked)
  }

  // ── Events ──────────────────────────────────────────────────
  document.getElementById('ach-close').addEventListener('click', close);
  document.getElementById('achievements-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('achievements-overlay')) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) close(); });

  // ── Init ────────────────────────────────────────────────────
  _initInstallDate();
  _updateMenuBadge();
  setTimeout(_checkAll, 1500); // check on startup after other modules load

  return { open, close, record, _checkAll, _onStatsReset, _updateMenuBadge };
})();

window.AchievementSystem = AchievementSystem;
