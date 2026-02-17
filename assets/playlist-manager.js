// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — PLAYLIST MANAGER
// ═══════════════════════════════════════════════════════════════

class PlaylistManager {
  constructor() {
    this.playlists = this.loadPlaylists();
    this.currentPlaylist = null;
    this.isOpen = false;
    this.container = null;
    this.onLoadCallback = null;
    this.onSaveCallback = null;

    this.createUI();
    // Re-read from storage after UI built to ensure initial list is correct
    this.playlists = this.loadPlaylists();
    this.updatePlaylistList();
  }
  
  loadPlaylists() {
    const saved = localStorage.getItem('macan_playlists');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return {};
      }
    }
    return {};
  }
  
  savePlaylists() {
    localStorage.setItem('macan_playlists', JSON.stringify(this.playlists));
  }
  
  saveCurrentPlaylist(name, tracks) {
    const timestamp = new Date().toISOString();
    this.playlists[name] = {
      name: name,
      tracks: tracks,
      created: this.playlists[name]?.created || timestamp,
      modified: timestamp,
      count: tracks.length
    };
    this.savePlaylists();
    this.updatePlaylistList();
  }
  
  loadPlaylist(name) {
    return this.playlists[name]?.tracks || [];
  }
  
  deletePlaylist(name) {
    if (confirm(`Delete playlist "${name}"?`)) {
      delete this.playlists[name];
      this.savePlaylists();
      this.updatePlaylistList();
    }
  }
  
  exportPlaylist(name) {
    const playlist = this.playlists[name];
    if (!playlist) return;
    
    const dataStr = JSON.stringify(playlist, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name.replace(/[^a-z0-9]/gi, '_')}.macan.json`;
    link.click();
    
    URL.revokeObjectURL(url);
  }
  
  importPlaylist(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.tracks && Array.isArray(data.tracks)) {
          const name = data.name || file.name.replace('.macan.json', '').replace(/_/g, ' ');
          this.saveCurrentPlaylist(name, data.tracks);
          alert(`Playlist "${name}" imported successfully!`);
        } else {
          alert('Invalid playlist file format.');
        }
      } catch (err) {
        alert('Error reading playlist file.');
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
          <button class="pm-close-btn" id="pm-close">✕</button>
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
            <input type="file" id="pm-import-file" accept=".json,.macan.json" style="display:none">
            <button class="pm-btn pm-import-btn" id="pm-import">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              IMPORT
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
    this.attachEvents();
    this.updatePlaylistList();
  }
  
  attachEvents() {
    this.container.querySelector('#pm-close').addEventListener('click', () => this.close());
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) this.close();
    });
    
    this.container.querySelector('#pm-save').addEventListener('click', () => {
      const nameInput = this.container.querySelector('#pm-playlist-name');
      const name = nameInput.value.trim();
      
      if (!name) {
        alert('Please enter a playlist name.');
        return;
      }
      
      if (this.onSaveCallback) {
        this.onSaveCallback(name);
        nameInput.value = '';
      }
    });
    
    this.container.querySelector('#pm-import').addEventListener('click', () => {
      this.container.querySelector('#pm-import-file').click();
    });
    
    this.container.querySelector('#pm-import-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        this.importPlaylist(file);
      }
      e.target.value = '';
    });
  }
  
  updatePlaylistList() {
    const listContainer = this.container.querySelector('#pm-playlist-list');
    const countSpan = this.container.querySelector('#pm-count');
    
    const playlistNames = Object.keys(this.playlists);
    countSpan.textContent = `${playlistNames.length} playlist${playlistNames.length !== 1 ? 's' : ''}`;
    
    if (playlistNames.length === 0) {
      listContainer.innerHTML = `
        <div class="pm-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#E8FF00" stroke-width="1" opacity="0.3">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
          </svg>
          <p>NO SAVED PLAYLISTS</p>
        </div>
      `;
      return;
    }
    
    listContainer.innerHTML = playlistNames
      .sort((a, b) => {
        const dateA = new Date(this.playlists[a].modified);
        const dateB = new Date(this.playlists[b].modified);
        return dateB - dateA;
      })
      .map(name => this.createPlaylistItemHTML(name))
      .join('');
    
    // Attach item events
    listContainer.querySelectorAll('.pm-item').forEach(item => {
      const name = item.dataset.name;
      
      item.querySelector('.pm-item-load').addEventListener('click', () => {
        if (this.onLoadCallback) {
          this.onLoadCallback(name);
          this.close();
        }
      });
      
      item.querySelector('.pm-item-export').addEventListener('click', (e) => {
        e.stopPropagation();
        this.exportPlaylist(name);
      });
      
      item.querySelector('.pm-item-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        this.deletePlaylist(name);
      });
    });
  }
  
  createPlaylistItemHTML(name) {
    const playlist = this.playlists[name];
    const modifiedDate = new Date(playlist.modified).toLocaleDateString();
    const modifiedTime = new Date(playlist.modified).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    return `
      <div class="pm-item" data-name="${name}">
        <div class="pm-item-main">
          <div class="pm-item-info">
            <div class="pm-item-name">${name}</div>
            <div class="pm-item-meta">
              ${playlist.count} track${playlist.count !== 1 ? 's' : ''} • ${modifiedDate} ${modifiedTime}
            </div>
          </div>
          <div class="pm-item-actions">
            <button class="pm-item-btn pm-item-load" title="Load Playlist">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5,3 19,12 5,21"/>
              </svg>
            </button>
            <button class="pm-item-btn pm-item-export" title="Export">
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
      </div>
    `;
  }
  
  onSave(callback) {
    this.onSaveCallback = callback;
  }
  
  onLoad(callback) {
    this.onLoadCallback = callback;
  }
  
  open() {
    this.container.classList.add('active');
    this.isOpen = true;
    // Always re-read from localStorage when opening to catch latest saves
    this.playlists = this.loadPlaylists();
    this.updatePlaylistList();
  }
  
  close() {
    this.container.classList.remove('active');
    this.isOpen = false;
  }
  
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open(); // open() re-reads playlists from storage
    }
  }
}
