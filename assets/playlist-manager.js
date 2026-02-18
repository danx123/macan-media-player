// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — PLAYLIST MANAGER (M3U8 backend)
// Named playlists are stored as .m3u8 files on the Python side.
// This class only holds the lightweight registry in memory.
// ═══════════════════════════════════════════════════════════════

class PlaylistManager {
  constructor() {
    this.registry = {};
    this.isOpen   = false;
    this.container = null;
    this.onLoadCallback = null;
    this.onSaveCallback = null;

    this.createUI();
    this._loadRegistry();
  }

  async _loadRegistry() {
    try {
      if (typeof pywebview !== 'undefined') {
        const data = await pywebview.api.get_playlist_registry();
        // Only overwrite if server returned a valid object
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          this.registry = data;
          this.updatePlaylistList();
          return true;
        }
      }
    } catch (e) {
      console.warn('[PlaylistManager] get_playlist_registry failed:', e);
      // Keep current registry on error — don't reset to empty
    }
    // Only set empty if registry is truly uninitialized
    if (!this.registry) {
      this.registry = {};
    }
    this.updatePlaylistList();
    return false;
  }

  async saveCurrentPlaylist(name, tracks) {
    const ts = new Date().toISOString();
    this.registry[name] = {
      name,
      filename: null,
      count:    tracks.length,
      created:  this.registry[name]?.created || ts,
      modified: ts,
    };
    this.updatePlaylistList();

    if (typeof pywebview !== 'undefined') {
      try {
        const ok = await pywebview.api.save_named_playlist(name, tracks);
        if (!ok) {
          console.error('[PlaylistManager] save_named_playlist returned falsy');
          alert(`Failed to save playlist "${name}". Check console for errors.`);
          return false;
        }
        // Reload registry from Python to get the stable filename
        await this._loadRegistry();
        return true;
      } catch (e) {
        console.error('[PlaylistManager] save_named_playlist failed:', e);
        alert(`Error saving playlist "${name}": ${e.message || e}`);
        return false;
      }
    }
    return true;
  }

  async loadPlaylistTracks(name) {
    if (typeof pywebview === 'undefined') return [];
    try {
      const tracks = await pywebview.api.load_named_playlist(name);
      return Array.isArray(tracks) ? tracks : [];
    } catch (e) {
      console.error('[PlaylistManager] load_named_playlist failed:', e);
      return [];
    }
  }

  async deletePlaylist(name) {
    if (!confirm(`Delete playlist "${name}"?`)) return;
    delete this.registry[name];
    this.updatePlaylistList();
    if (typeof pywebview !== 'undefined') {
      try {
        await pywebview.api.delete_named_playlist(name);
      } catch (e) {
        console.error('[PlaylistManager] delete_named_playlist failed:', e);
      }
    }
  }

  async exportPlaylist(name) {
    if (typeof pywebview === 'undefined') return;
    try {
      const m3uText = await pywebview.api.export_named_playlist(name);
      if (!m3uText) { alert('Playlist not found.'); return; }
      const blob = new Blob([m3uText], { type: 'audio/x-mpegurl' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = (name.replace(/[^a-z0-9]/gi, '_') || 'playlist') + '.m3u8';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('[PlaylistManager] exportPlaylist failed:', e);
    }
  }

  importPlaylist(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target.result;
      const name = (file.name || 'Imported')
        .replace(/\.(m3u8?|macan\.json)$/i, '')
        .replace(/_/g, ' ')
        .trim() || 'Imported';

      if (typeof pywebview !== 'undefined') {
        try {
          const result = await pywebview.api.import_m3u_playlist(name, text);
          if (result.ok) {
            alert(`Playlist "${name}" imported — ${result.count} track(s).`);
            await this._loadRegistry();
          } else {
            alert(`Import failed: ${result.error || 'unknown error'}`);
          }
        } catch (e) {
          console.error('[PlaylistManager] import_m3u_playlist failed:', e);
          alert('Import error — see console.');
        }
      }
    };
    reader.readAsText(file);
  }

  createUI() {
    this.container = document.createElement('div');
    this.container.id = 'playlist-manager-overlay';
    this.container.className = 'playlist-manager-overlay';
    this.container.innerHTML = `
      <div class="pm-panel">
        <div class="pm-header">
          <h2>PLAYLIST MANAGER</h2>
          <button class="pm-close-btn" id="pm-close">&#x2715;</button>
        </div>

        <div class="pm-actions">
          <div class="pm-save-section">
            <input type="text" id="pm-playlist-name" placeholder="Enter playlist name..." class="pm-input">
            <button class="pm-btn pm-save-btn" id="pm-save">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              SAVE CURRENT
            </button>
          </div>

          <div class="pm-import-section">
            <input type="file" id="pm-import-file" accept=".m3u,.m3u8,.json" style="display:none">
            <button class="pm-btn pm-import-btn" id="pm-import">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              IMPORT .M3U8
            </button>
          </div>
        </div>

        <div class="pm-list-header">
          <span>SAVED PLAYLISTS</span>
          <span class="pm-count" id="pm-count">0 playlists</span>
        </div>

        <div class="pm-list" id="pm-playlist-list">
          <div class="pm-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#E8FF00" stroke-width="1" opacity="0.3">
              <path d="M9 18V5l12-2v13"/>
              <circle cx="6" cy="18" r="3"/>
              <circle cx="18" cy="16" r="3"/>
            </svg>
            <p>NO SAVED PLAYLISTS</p>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(this.container);
    this._attachEvents();
    this.updatePlaylistList();
  }

  _attachEvents() {
    this.container.querySelector('#pm-close').addEventListener('click', () => this.close());
    this.container.addEventListener('click', e => {
      if (e.target === this.container) this.close();
    });

    this.container.querySelector('#pm-save').addEventListener('click', async () => {
      const nameInput = this.container.querySelector('#pm-playlist-name');
      const name = nameInput.value.trim();
      if (!name) { alert('Please enter a playlist name.'); return; }
      const btn = this.container.querySelector('#pm-save');
      btn.disabled = true;
      btn.textContent = 'SAVING…';
      try {
        let saved = false;
        if (this.onSaveCallback) {
          saved = await this.onSaveCallback(name);
        }
        nameInput.value = '';
        if (saved !== false) {
          btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg> SAVED!`;
          setTimeout(() => {
            btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg> SAVE CURRENT`;
          }, 2000);
        }
      } finally {
        btn.disabled = false;
        if (!btn.innerHTML.includes('SAVED')) {
          btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg> SAVE CURRENT`;
        }
      }
    });

    this.container.querySelector('#pm-import').addEventListener('click', () => {
      this.container.querySelector('#pm-import-file').click();
    });

    this.container.querySelector('#pm-import-file').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) this.importPlaylist(file);
      e.target.value = '';
    });
  }

  updatePlaylistList() {
    const listContainer = this.container.querySelector('#pm-playlist-list');
    const countSpan     = this.container.querySelector('#pm-count');
    const names         = Object.keys(this.registry);

    countSpan.textContent = `${names.length} playlist${names.length !== 1 ? 's' : ''}`;

    if (names.length === 0) {
      listContainer.innerHTML = `
        <div class="pm-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#E8FF00" stroke-width="1" opacity="0.3">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
          </svg>
          <p>NO SAVED PLAYLISTS</p>
        </div>`;
      return;
    }

    const sorted = names.sort((a, b) =>
      new Date(this.registry[b].modified) - new Date(this.registry[a].modified)
    );

    listContainer.innerHTML = sorted.map(n => this._itemHTML(n)).join('');

    listContainer.querySelectorAll('.pm-item').forEach(item => {
      const name = item.dataset.name;
      item.querySelector('.pm-item-load').addEventListener('click', async () => {
        if (this.onLoadCallback) {
          this.close();
          await this.onLoadCallback(name);
        }
      });
      item.querySelector('.pm-item-export').addEventListener('click', e => {
        e.stopPropagation(); this.exportPlaylist(name);
      });
      item.querySelector('.pm-item-delete').addEventListener('click', e => {
        e.stopPropagation(); this.deletePlaylist(name);
      });
    });
  }

  _itemHTML(name) {
    const entry   = this.registry[name];
    const modDate = new Date(entry.modified).toLocaleDateString();
    const modTime = new Date(entry.modified).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const count   = entry.count ?? '?';
    return `
      <div class="pm-item" data-name="${name}">
        <div class="pm-item-main">
          <div class="pm-item-info">
            <div class="pm-item-name">${name}</div>
            <div class="pm-item-meta">
              ${count} track${count !== 1 ? 's' : ''} &bull; ${modDate} ${modTime}
              <span class="pm-item-badge">M3U8</span>
            </div>
          </div>
          <div class="pm-item-actions">
            <button class="pm-item-btn pm-item-load" title="Load Playlist">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5,3 19,12 5,21"/>
              </svg>
            </button>
            <button class="pm-item-btn pm-item-export" title="Export .m3u8">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </button>
            <button class="pm-item-btn pm-item-delete danger" title="Delete">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>`;
  }

  onSave(callback)  { this.onSaveCallback = callback; }
  onLoad(callback)  { this.onLoadCallback = callback; }

  open() {
    this.container.classList.add('active');
    this.isOpen = true;
    this._loadRegistry();
  }

  close() {
    this.container.classList.remove('active');
    this.isOpen = false;
  }

  toggle() { this.isOpen ? this.close() : this.open(); }
}
