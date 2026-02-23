// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — USER PROFILE MODULE
// Name, custom avatar (emoji picker + color), displayed in menu.
// ═══════════════════════════════════════════════════════════════

const UserProfile = (() => {
  const SK = 'macan_user_profile';

  const AVATAR_EMOJIS = [
    '🐯','🦁','🐻','🦊','🐺','🐼','🐸','🐧',
    '🦋','🦅','🎵','🎸','🎧','🎤','🎬','🎮',
    '⚡','🔥','🌙','⭐','🌊','🌿','💎','🚀',
  ];

  const AVATAR_COLORS = [
    '#E8FF00','#FF6B6B','#4ECDC4','#45B7D1',
    '#96CEB4','#FFEAA7','#DDA0DD','#FF8C69',
    '#98D8C8','#F7DC6F','#BB8FCE','#5DADE2',
  ];

  // ── Load / Save ─────────────────────────────────────────────
  function load() {
    try { return JSON.parse(localStorage.getItem(SK)) || {}; }
    catch { return {}; }
  }
  function save(data) {
    try { localStorage.setItem(SK, JSON.stringify(data)); } catch {}
  }

  function getProfile() {
    const p = load();
    return {
      name:        p.name  || 'Listener',
      emoji:       p.emoji || '🎧',
      color:       p.color || '#E8FF00',
    };
  }

  // ── Render avatar ────────────────────────────────────────────
  function _renderAvatar(emoji, color, size = 42) {
    return '<div class="up-avatar" style="width:' + size + 'px;height:' + size + 'px;background:' + color + '22;border:2px solid ' + color + ';border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:' + Math.round(size*0.5) + 'px;flex-shrink:0">' + emoji + '</div>';
  }

  // ── Update menu header ───────────────────────────────────────
  function updateMenuHeader() {
    const el = document.getElementById('nm-profile-block');
    if (!el) return;
    const p = getProfile();
    el.innerHTML =
      _renderAvatar(p.emoji, p.color, 44) +
      '<div class="nm-profile-info">' +
        '<div class="nm-profile-name">' + _esc(p.name) + '</div>' +
        '<div class="nm-profile-sub">MACAN LISTENER</div>' +
      '</div>' +
      '<button class="nm-profile-edit-btn" id="nm-profile-edit-btn" title="Edit profile">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
          '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>' +
        '</svg>' +
      '</button>';
    document.getElementById('nm-profile-edit-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      NavMenu.close();
      setTimeout(openEditPanel, 80);
    });
  }

  // ── Edit panel ───────────────────────────────────────────────
  function openEditPanel() {
    const p = getProfile();
    const overlay = document.getElementById('user-profile-overlay');
    if (!overlay) return;

    // Populate fields
    const nameInput = document.getElementById('up-name-input');
    if (nameInput) nameInput.value = p.name === 'Listener' ? '' : p.name;

    // Render emoji grid
    const emojiGrid = document.getElementById('up-emoji-grid');
    if (emojiGrid) {
      emojiGrid.innerHTML = '';
      AVATAR_EMOJIS.forEach(em => {
        const btn = document.createElement('button');
        btn.className = 'up-emoji-btn' + (em === p.emoji ? ' selected' : '');
        btn.textContent = em;
        btn.addEventListener('click', () => {
          emojiGrid.querySelectorAll('.up-emoji-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          _updatePreview();
        });
        emojiGrid.appendChild(btn);
      });
    }

    // Render color swatches
    const colorGrid = document.getElementById('up-color-grid');
    if (colorGrid) {
      colorGrid.innerHTML = '';
      AVATAR_COLORS.forEach(col => {
        const btn = document.createElement('button');
        btn.className = 'up-color-btn' + (col === p.color ? ' selected' : '');
        btn.style.background = col;
        btn.dataset.color = col;
        btn.addEventListener('click', () => {
          colorGrid.querySelectorAll('.up-color-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          _updatePreview();
        });
        colorGrid.appendChild(btn);
      });
    }

    _updatePreview();
    overlay.classList.add('active');
  }

  function _getEditValues() {
    const nameInput  = document.getElementById('up-name-input');
    const selEmoji   = document.querySelector('#up-emoji-grid .up-emoji-btn.selected');
    const selColor   = document.querySelector('#up-color-grid .up-color-btn.selected');
    const p = getProfile();
    return {
      name:  nameInput?.value.trim() || 'Listener',
      emoji: selEmoji?.textContent   || p.emoji,
      color: selColor?.dataset.color || p.color,
    };
  }

  function _updatePreview() {
    const preview = document.getElementById('up-avatar-preview');
    if (!preview) return;
    const v = _getEditValues();
    preview.innerHTML = _renderAvatar(v.emoji, v.color, 64);
    const nameLabel = document.getElementById('up-preview-name');
    if (nameLabel) {
      nameLabel.textContent = document.getElementById('up-name-input')?.value.trim() || 'Listener';
      nameLabel.style.color = v.color;
    }
  }

  function _saveEdit() {
    const v = _getEditValues();
    save(v);
    updateMenuHeader();
    document.getElementById('user-profile-overlay').classList.remove('active');
  }

  function _closeEdit() {
    document.getElementById('user-profile-overlay').classList.remove('active');
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Events ──────────────────────────────────────────────────
  document.getElementById('up-save-btn').addEventListener('click', _saveEdit);
  document.getElementById('up-cancel-btn').addEventListener('click', _closeEdit);
  document.getElementById('user-profile-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('user-profile-overlay')) _closeEdit();
  });
  document.getElementById('up-name-input')?.addEventListener('input', _updatePreview);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('user-profile-overlay').classList.contains('active')) _closeEdit();
  });

  // ── Init ─────────────────────────────────────────────────────
  updateMenuHeader();

  return { getProfile, updateMenuHeader, openEditPanel };
})();

window.UserProfile = UserProfile;
