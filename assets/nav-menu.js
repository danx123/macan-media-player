// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — NAV MENU MODULE
// Burger menu with user profile header + all feature items.
// ═══════════════════════════════════════════════════════════════

const NavMenu = (() => {
  let isOpen = false;

  const btnBurger  = document.getElementById('btn-burger');
  const menuPanel  = document.getElementById('nav-menu-panel');
  const menuOverlay = document.getElementById('nav-menu-overlay');

  const menuItems = [
    {
      id: 'nm-equalizer', label: 'EQUALIZER',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
      action: () => document.getElementById('btn-equalizer')?.click(),
    },
    {
      id: 'nm-playlist', label: 'PLAYLISTS',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
      action: () => document.getElementById('btn-playlist-manager')?.click(),
    },
    {
      id: 'nm-smart-playlist', label: 'SMART PLAYLIST',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>',
      action: () => window.SmartPlaylist?.open(),
    },
    {
      id: 'nm-lyrics', label: 'LYRICS',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      action: () => document.getElementById('btn-lyrics')?.click(),
    },
    {
      id: 'nm-radio', label: 'RADIO ONLINE',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="10" width="18" height="11" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/><circle cx="12" cy="16" r="2"/></svg>',
      action: () => window.RTV?.openRadio(),
    },
    {
      id: 'nm-tv', label: 'TV ONLINE',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>',
      action: () => window.RTV?.openTv(),
    },
    {
      id: 'nm-convert', label: 'CONVERTER',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
      action: () => document.getElementById('btn-converter')?.click(),
    },
    {
      id: 'nm-cache', label: 'CACHE MANAGER',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
      action: () => document.getElementById('btn-cache-manager')?.click(),
    },
    {
      id: 'nm-stats', label: 'LISTEN STATISTICS',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>',
      action: () => window.ListenStats?.open(),
    },
    {
      id: 'nm-achievements', label: 'ACHIEVEMENTS',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>',
      badge: true, // will hold dynamic unlock count
      action: () => window.AchievementSystem?.open(),
    },
    {
      id: 'nm-about', label: 'ABOUT',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
      action: () => document.getElementById('btn-about')?.click(),
    },
    {
      id: 'nm-exit', label: 'EXIT',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
      danger: true,
      action: () => document.getElementById('btn-close')?.click(),
    },
  ];

  // ── Build menu ──────────────────────────────────────────────
  function _buildMenu() {
    const list = document.getElementById('nav-menu-list');
    if (!list) return;
    list.innerHTML = '';

    menuItems.forEach(item => {
      if (item.id === 'nm-exit') {
        const sep = document.createElement('div');
        sep.className = 'nm-separator';
        list.appendChild(sep);
      }

      const el = document.createElement('button');
      el.className = 'nm-item' + (item.danger ? ' nm-item-danger' : '');
      el.id = item.id;

      const badgeHtml = item.badge
        ? '<span class="nm-ach-badge" id="nm-ach-badge" style="display:none">0</span>'
        : '';

      el.innerHTML =
        '<span class="nm-item-icon">' + item.icon + '</span>' +
        '<span class="nm-item-label">' + item.label + '</span>' +
        badgeHtml +
        '<svg class="nm-item-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';

      el.addEventListener('click', () => {
        close();
        setTimeout(() => item.action(), 80);
      });
      list.appendChild(el);
    });
  }

  // ── Open / Close ────────────────────────────────────────────
  function open() {
    isOpen = true;
    menuPanel.classList.add('active');
    menuOverlay.classList.add('active');
    btnBurger.classList.add('active');
  }
  function close() {
    isOpen = false;
    menuPanel.classList.remove('active');
    menuOverlay.classList.remove('active');
    btnBurger.classList.remove('active');
  }
  function toggle() { isOpen ? close() : open(); }

  // ── Events ──────────────────────────────────────────────────
  btnBurger.addEventListener('click', toggle);
  menuOverlay.addEventListener('click', close);
  document.getElementById('nm-close-btn')?.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) close(); });

  _buildMenu();

  return { open, close, toggle };
})();

window.NavMenu = NavMenu;
