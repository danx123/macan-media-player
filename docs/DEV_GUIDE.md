# Developer Guide — Macan Media Player

This guide describes the internal architecture of Macan Media Player for contributors and developers who need to understand how the system works before making changes.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Python Backend](#python-backend)
- [JavaScript Frontend](#javascript-frontend)
- [Audio Pipeline](#audio-pipeline)
- [Data Persistence](#data-persistence)
- [WebView2 Integration](#webview2-integration)
- [Module Reference](#module-reference)
- [State Management](#state-management)
- [Adding a Hook Point](#adding-a-hook-point)
- [Common Patterns](#common-patterns)

---

## Architecture Overview

Macan Media Player is a desktop application built on **pywebview**, which embeds a WebView2 (Chromium-based) web renderer inside a native frameless window. The application has two distinct layers that communicate through a bidirectional bridge:

```
┌─────────────────────────────────────────────────────────────┐
│                    Native Window (Win32)                     │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              WebView2 (Chromium Engine)              │   │
│  │                                                      │   │
│  │  HTML/CSS/JS Frontend                                │   │
│  │  ├── script.js          (core application logic)     │   │
│  │  ├── plugin-bridge.js   (plugin adapter layer)       │   │
│  │  ├── equalizer.js       (10-band EQ)                 │   │
│  │  ├── [other modules…]                                │   │
│  │  └── plugins/           (user-installed plugins)     │   │
│  │                         ↕ pywebview.api.*            │   │
│  │  Python Backend                                      │   │
│  │  └── main.py            (MacanMediaAPI class)        │   │
│  │       ├── HTTP media server (localhost, CORS bypass) │   │
│  │       ├── SQLite database  (macan.db)                │   │
│  │       ├── Album art cache  (SQLite + disk)           │   │
│  │       ├── Lyrics cache     (SQLite)                  │   │
│  │       └── Video thumbnailer                          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

JavaScript calls Python by invoking methods on `pywebview.api` (which is bound to the `MacanMediaAPI` instance). Python calls JavaScript by invoking `window.evaluate_js()` on the pywebview window object.

---

## Python Backend

### Entry point: `main.py`

`main.py` has two responsibilities: defining `MacanMediaAPI` and bootstrapping the application.

**Bootstrap sequence (bottom of `main.py`):**

1. Set `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable to enable SMTC / Media Session API support before the process starts.
2. Start the local HTTP media server (`_MediaServer`) on a random port.
3. Create the `MacanMediaAPI` instance.
4. Compute SHA-256 hash of all frontend assets; clear WebView2 disk cache if the hash changed.
5. Generate `assets/index.live.html` — a cache-busted copy of `index.html` with `?v=<hash>` appended to all local asset URLs.
6. Create the pywebview window, pointing to `index.live.html`.
7. Call `webview.start()` with `storage_path` pointing to the persistent WebView2 profile directory.

### `MacanMediaAPI`

The `MacanMediaAPI` class is the JS-to-Python bridge. Every public method on this class is directly callable from JavaScript as `pywebview.api.method_name(args)`. Methods run on pywebview's internal bridge threads — one thread per concurrent JS call — so shared state must be protected with locks.

**Key internal components:**

| Attribute | Type | Purpose |
|---|---|---|
| `self._window` | `webview.Window` | Set after `webview.create_window()` via `set_window()` |
| `self.playlist` | `list` | In-memory current queue (mirrors JS `S.playlist`) |
| `self.settings` | `dict` | In-memory settings (loaded from `macan.db` on init) |
| `self._settings_lock` | `threading.Lock` | Prevents concurrent `save_settings` / `save_app_state` races |
| `self._art_cache` | `AlbumArtCache` | Cover art fetcher and disk cache |
| `self._lyric_cache` | `LyricCache` | Lyrics database |
| `self._plugin_handlers` | `dict` | `plugin_id:action` → callable, for the Plugin Bridge |

**Key method groups:**

- **Window management** — `close_app()`, `minimize_app()`
- **File I/O** — `open_files()`, `open_folder()`, `add_tracks()`, `add_tracks_stream()`
- **Playlist** — `get_playlist()`, `clear_playlist()`, `reorder_playlist()`, `remove_track()`
- **Named playlists** — `save_named_playlist()`, `get_playlist_registry()`, `load_named_playlist()`
- **Cover art** — `get_cover_art()`, `get_cover_art_with_online_fallback()`, `update_track_art()`
- **Lyrics** — `get_lyrics()`, `save_lyrics()`
- **Settings** — `get_settings()`, `save_settings()`, `save_app_state()`, `get_app_state()`
- **Cache** — `get_cache_sizes()`, `clear_cache()`
- **Plugin bridge** — `plugin_request()`, `register_plugin_handler()`

### Local HTTP media server

EdgeWebView2 blocks `<audio>` and `<video>` elements with `file://` source URLs (CORS policy). To work around this, `main.py` starts a `_MediaServer` on a random localhost port at startup. `add_tracks()` and `add_tracks_stream()` register each file path with a UUID token and return a `http://127.0.0.1:{port}/media/{token}` URL. The `<audio>` and `<video>` elements use these URLs as their `src`.

The server supports HTTP Range requests, which is required for seeking to work correctly in `<audio>` and `<video>`.

### `add_tracks_stream()` vs `add_tracks()`

For large folders, `add_tracks_stream()` is used instead of `add_tracks()`. It scans files in batches of 12, calling `window.evaluate_js('window.onTrackBatchReady(tracks, done)')` after each batch. This allows the UI to render tracks progressively rather than waiting for the full scan to complete.

`add_tracks()` is used for smaller additions (drag-and-drop, explicit file selection) where blocking until completion is acceptable.

### Data storage paths

| Platform | App data directory |
|---|---|
| Windows | `%LOCALAPPDATA%\MacanMediaPlayer\` |
| Other | `~/.macan_media_player/` |

Files within the app data directory:

| Path | Contents |
|---|---|
| `macan.db` | SQLite: settings, current playlist, named playlists, lyrics |
| `AlbumArtCache/` | Disk cache for fetched cover art images |
| `AlbumArtCache/art_cache.db` | SQLite: cached cover art metadata |
| `WebView2Profile/` | WebView2 persistent user data (localStorage, IndexedDB, cookies) |
| `WebView2Profile/asset_hash.txt` | SHA-256 hash of last seen frontend assets |

---

## JavaScript Frontend

### Module loading order

Scripts load in the following order, which is significant:

```
plugin-bridge.js      ← loads first; must be available to all other modules
equalizer.js
playlist-manager.js
radio-tv.js
converter.js
about.js
smart-playlist.js
settings.js
listen-stats.js
achievements.js
user-profile.js
nav-menu.js
script.js             ← loads last among Core modules; sets up all event listeners
plugins.config.js     ← loads after script.js; plugins run after all Core is ready
```

Each module (except `script.js`) is an IIFE that exposes a single global:

| Script | Global exposed |
|---|---|
| `plugin-bridge.js` | `window.MacanBridge` |
| `equalizer.js` | `Equalizer10Band` (class), `equalizerUI` |
| `smart-playlist.js` | `window.SmartPlaylist` |
| `settings.js` | `window.Settings` |
| `listen-stats.js` | `window.ListenStats` |
| `achievements.js` | `window.AchievementSystem` |
| `user-profile.js` | `window.UserProfile` |
| `nav-menu.js` | *(no global; self-contained)* |
| `script.js` | `S`, `activePlayer`, `loadTrack`, `togglePlayPause`, and other globals |

`script.js` is not an IIFE — it runs in global scope and defines the core functions and state object that all other modules depend on. Its functions are intentionally global so pywebview's `evaluate_js` calls and SMTC handlers can invoke them directly.

### Initialization sequence

`script.js` defers state restoration until pywebview signals readiness:

```javascript
window.addEventListener('pywebviewready', () => {
  _doStateRestore();
});
```

`_doStateRestore()` calls `pywebview.api.get_playlist()` and `pywebview.api.get_app_state()` concurrently, then restores: playlist, playback position, volume, shuffle/repeat state, and equalizer bands.

---

## Audio Pipeline

The Web Audio API graph for audio playback:

```
HTMLAudioElement
       │
       ▼
MediaElementSourceNode  (audioSource)
       │
       ▼
Equalizer10Band         (10 cascaded BiquadFilterNodes)
       │
       ▼
GainNode                (S._gainNode — ReplayGain normalization)
       │
       ▼
GainNode                (S._fadeGain — fade in/out)
       │
       ▼
AudioContext.destination
```

The audio graph is created lazily in `initAudioContext()`, which is called on the first user gesture that triggers playback (browser autoplay policy). Until then, a lightweight stub equalizer handles UI interactions without any AudioContext.

**Fade system:**
- `doFadeIn()` — `exponentialRampToValueAtTime(1.0, now + duration)` from near-silence (`0.0001`)
- `doFadeOut(callback)` — ramp to near-silence, then invoke callback after `fadeDuration + 50ms`
- Duration is configurable via `S.fadeDuration` (default: 1200 ms)
- Video tracks bypass fade (visual sync requirement)
- `0.0001` is used instead of `0.0` because `exponentialRampToValueAtTime` cannot ramp to exactly zero (multiplicative interpolation)

**Equalizer:**
- 10 bands: 31 Hz, 62 Hz, 125 Hz, 250 Hz, 500 Hz, 1 kHz, 2 kHz, 4 kHz, 8 kHz, 16 kHz
- Band gain range: −12 dB to +12 dB
- Presets stored in `macan.db` and restored across sessions

---

## Data Persistence

### Python-side (SQLite `macan.db`)

| Table/key pattern | Contents |
|---|---|
| `kv` table, `settings` key | Application settings JSON |
| `kv` table, `app_state` key | Playback state (position, volume, indices) |
| `kv` table, `playlist_registry` key | Named playlist index |
| `kv` table, `playlist_{name}` key | Named playlist track arrays |
| `playlist` table | Current queue (one row per track, position-ordered) |

WAL journal mode and `PRAGMA synchronous=NORMAL` are set for all connections. A short `timeout=10` is set on all connections to handle transient lock contention from pywebview's multithreaded bridge.

### JavaScript-side (localStorage)

| Key | Module | Contents |
|---|---|---|
| `macan_settings_v1` | `settings.js` | Button visibility, Dynamic Aura toggle |
| `macan_play_counts` | `smart-playlist.js` | `{ filePath: totalPlays }` — persistent play counter |
| `macan_sp_meta` | `smart-playlist.js` | `{ filePath: trackMetadata }` — cover art and metadata cache |
| `macan_listen_daily` | `listen-stats.js` | `{ 'YYYY-MM-DD': seconds }` — daily listening time |
| `macan_listen_session` | `listen-stats.js` | Current session seconds (runtime only) |
| `macan_achievements` | `achievements.js` | Set of unlocked achievement IDs |
| `macan_ach_notified` | `achievements.js` | Set of achievement IDs for which notification was shown |
| `macan_ach_stats` | `achievements.js` | Counters: totalPlays, videosPlayed, etc. |
| `macan_install_date` | `achievements.js` | First-run date (ISO string) |
| `macan_user_profile` | `user-profile.js` | `{ name, emoji, color }` |
| `macan_radio_cache` | `radio-tv.js` | Cached online radio station list |
| `macan_radio_custom` | `radio-tv.js` | User-added custom radio stations |
| `macan_tv_channels` | `radio-tv.js` | User-added TV channel URLs |

Plugin localStorage keys should follow the pattern `macan_plg_{plugin_id}_{key}` to avoid collisions.

---

## WebView2 Integration

### SMTC (System Media Transport Controls)

SMTC integration relies on the W3C Media Session API (`navigator.mediaSession`). Two environment flags are required and are set in `main.py` before the process starts:

```
--enable-features=HardwareMediaKeyHandling,MediaSessionService
--autoplay-policy=no-user-gesture-required
```

Without these flags, `navigator.mediaSession` exists but is silently ignored by EdgeWebView2.

**Update flow:**
- `updateMediaSession(track, artSrc)` — pushes full `MediaMetadata` (title, artist, album, artwork blob URL). Called on track load and when cover art arrives.
- `syncMediaSessionState()` — updates `playbackState` and calls `setPositionState()`. Called on play/pause state changes and throttled at 1-second intervals inside `onTimeUpdate()`.
- `startSmtcHeartbeat()` — a `setInterval` running every 5 seconds that detects title drift (stale SMTC after track switch while minimized) and re-pushes full metadata if needed.

Cover art is converted from `data:` URLs to `blob:` URLs before being passed to `MediaMetadata`, because EdgeWebView2 rejects `data:` URLs in artwork arrays.

### Cache invalidation

On every startup, `main.py`:

1. Computes a SHA-256 hash of all `.html`, `.css`, and `.js` files in `assets/`.
2. Compares it to the hash stored in `WebView2Profile/asset_hash.txt`.
3. If changed: deletes `Cache`, `Code Cache`, `GPUCache`, `Service Worker`, `CacheStorage`, and `blob_storage` subdirectories from the WebView2 profile (and their mirrors under `EBWebView/`).
4. Writes `assets/index.live.html` with `?v=<hash>` appended to all local asset URLs.
5. Passes `index.live.html` as the WebView2 entry point.

The `?v=` query string forces WebView2 to treat updated assets as new resources, bypassing any in-process caches that survive directory deletion.

### Storage profile

`webview.start(storage_path=..., private_mode=False)` is required for `localStorage` and IndexedDB to persist across restarts. `private_mode=False` must be set explicitly — omitting it or passing `True` causes pywebview to use an ephemeral (in-memory) profile, which loses all localStorage data on exit.

---

## Module Reference

### `script.js` — Core application

The primary module. Owns the `S` state object, audio element references, all playback functions, seekbar and volume UI, playlist rendering, drag-and-drop, keyboard shortcuts, and the `onTrackBatchReady` streaming receiver. Loads last among Core modules.

Key functions: `loadTrack()`, `doPlay()`, `togglePlayPause()`, `doFadeIn()`, `doFadeOut()`, `onPlayState()`, `applyArt()`, `clearPlaylist()`, `onTimeUpdate()`, `renderPlaylist()`, `updateTrackInfo()`, `initAudioContext()`, `initMediaSessionHandlers()`, `startSmtcHeartbeat()`.

### `equalizer.js` — 10-band EQ

`Equalizer10Band` class wraps ten `BiquadFilterNode` instances. The `equalizerUI` IIFE handles the DOM panel. A stub equalizer is used before `AudioContext` is created so the UI remains interactive from the first frame.

### `smart-playlist.js` — Smart Playlist

Maintains two independent `localStorage` stores (`macan_play_counts`, `macan_sp_meta`) that persist independently of the queue. `_buildPool()` assembles a unified candidate set from three sources: persisted metadata, current queue, and all named playlists via `playlistManager.loadPlaylistTracks()`. The top 25 tracks by play count are surfaced in the panel.

### `settings.js` — Settings module

Persists to `macan_settings_v1`. Manages two features: toolbar button visibility (show/hide via `display` toggling) and Dynamic Aura (dominant color extraction from album art via a 64×64 offscreen canvas, applied as CSS custom properties `--accent`, `--accent-dim`, `--accent-glow`).

### `listen-stats.js` — Listen Statistics

Tracks daily listening time in `macan_listen_daily`. Uses a `setInterval` timer while playing. The bar chart is rendered on an HTML5 canvas with `roundRect` for bar caps (falls back gracefully if not supported).

### `achievements.js` — Achievement System

24 predefined badges earned through listening behavior (play counts, formats played, features used). Achievement state stored in `macan_achievements`. Toast notifications shown on first unlock.

### `user-profile.js` — User Profile

Stores `{ name, emoji, color }` in `macan_user_profile`. The profile header in the navigation menu is updated on every open. Name input and emoji/color pickers are in an overlay panel.

### `nav-menu.js` — Navigation menu

Builds the hamburger menu from a static `menuItems` array. Does not expose a public API. Plugin items are injected into the `#nav-menu-list` element by `plugin-bridge.js` using a `MutationObserver`.

### `plugin-bridge.js` — Plugin Bridge Adapter

See [plugin_development.md](plugin_development.md) for complete documentation.

---

## State Management

The global `S` object in `script.js` is the single source of truth for runtime playback state:

```javascript
const S = {
  playlist:        [],       // array of track objects
  currentIndex:    -1,       // index into playlist, -1 = nothing loaded
  isPlaying:       false,
  isShuffle:       false,
  repeatMode:      'none',   // 'none' | 'all' | 'one'
  isMuted:         false,
  volume:          80,
  duration:        0,        // seconds, set by loadedmetadata event
  fadeEnabled:     true,
  fadeDuration:    1200,     // ms
  normEnabled:     false,
  targetLUFS:      -14,
  _fadeGain:       null,     // GainNode, set by initAudioContext()
  _gainNode:       null,     // GainNode, set by initAudioContext()
  _saveLock:       false,    // prevents concurrent save_app_state calls
  _seekPending:    null,     // { position } — applied on loadedmetadata
  _restoreComplete: false,   // true after _doStateRestore() finishes
  // … additional private fields
};
```

`S` is intentionally global (not exported from a module) because pywebview's `evaluate_js` calls and SMTC action handlers need to reference it. Do not access `S` directly from plugin code — use `MacanBridge.api` instead.

A track object has the following shape:

```javascript
{
  path:       '/absolute/path/to/file.mp3',
  url:        'http://127.0.0.1:{port}/media/{token}',
  name:       'Track Title',
  artist:     'Artist Name',
  album:      'Album Name',
  ext:        '.mp3',
  duration:   245.3,         // seconds
  is_video:   false,
  cover_art:  'data:image/jpeg;base64,...',  // may be null
  video_thumb: null,
  replaygain_db: 0,          // dB adjustment, may be null
}
```

---

## Adding a Hook Point

If a plugin requires an event that `script.js` does not yet emit, the correct approach is to add a `MacanBridge?.emit()` call to the appropriate function in `script.js`. This is the only acceptable modification to `script.js` for plugin support.

**Pattern:**

```javascript
// In script.js, inside the relevant function
// Use optional chaining so the player works even if the bridge is absent
window.MacanBridge?.emit('event:name', payloadObject);
```

**Guidelines:**
- The event name should follow the `noun:verb` convention (e.g., `queue:clear`, `player:pause`).
- The payload should be a plain object containing only data that is genuinely useful to a plugin. Do not pass internal mutable references — pass copies or primitives.
- If the event fires frequently (e.g., inside `onTimeUpdate`), throttle it with a wall-clock check, following the pattern used for `player:seek`.
- Document the new event in the hook events table in [plugin_development.md](plugin_development.md).

---

## Common Patterns

### Guarded module calls

All calls from `script.js` to optional modules use `window.Module` guards:

```javascript
if (window.AchievementSystem) AchievementSystem.record('someEvent');
if (window.ListenStats) ListenStats.startTracking();
if (window.Settings) Settings.onArtLoaded(albumArt);
window.MacanBridge?.emit('track:load', track);
```

This pattern ensures the player functions correctly if any module fails to load.

### State save debouncing

All state saves go through `scheduleStateSave()`, which debounces writes with a 500 ms delay and a `_saveLock` boolean to prevent concurrent calls:

```javascript
function scheduleStateSave() {
  clearTimeout(S._stateSaveTimer);
  S._stateSaveTimer = setTimeout(async () => {
    if (S._saveLock) { scheduleStateSave(); return; }
    S._saveLock = true;
    try { await pywebview.api.save_app_state(/* … */); }
    finally { S._saveLock = false; }
  }, 500);
}
```

### Python thread safety

`MacanMediaAPI` methods are called on pywebview's bridge threads. Always acquire `self._settings_lock` before accessing `self.settings`:

```python
with self._settings_lock:
    self.settings['key'] = value
    self._save_settings()
```

### evaluate_js from Python

Python pushes data to the JavaScript layer via `self._window.evaluate_js(script)`. This is used for streaming batch delivery and any other server-push event:

```python
import json
self._window.evaluate_js(
    f'window.onTrackBatchReady({json.dumps(batch)}, {str(done).lower()})'
)
```

Always serialize payloads with `json.dumps` to handle special characters correctly.
