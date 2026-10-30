# 🐯 Macan Media Player

![Version](https://img.shields.io/badge/version-11.6.7-E8FF00?style=flat-square)
![Python](https://img.shields.io/badge/python-3.10%2B-blue?style=flat-square)
![Rust](https://img.shields.io/badge/native%20engine-Rust-orange?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)


A sleek, fullscreen desktop media player built with Python, pywebview and a native Rust audio engine. Macan delivers a modern, cinema-grade playback experience for both audio and video files — with a dark aesthetic, real-time FFT visualizer, synced lyrics, a plugin system, deep Windows integration, and a robust local media HTTP server that ensures reliable playback on Windows (EdgeWebView2).

---

## Screenshot

<img width="1365" height="767" alt="Screenshot 2026-09-07 111707" src="https://github.com/user-attachments/assets/48113ec7-4f3c-4d35-97d7-8594087714d5" />
<img width="1365" height="767" alt="Screenshot 2026-09-15 113806" src="https://github.com/user-attachments/assets/74d10826-5383-4273-98a7-8ef718a3b677" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 211708" src="https://github.com/user-attachments/assets/db0b4eab-4069-4d8d-9ab3-bf1f1a2e58e8" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 153459" src="https://github.com/user-attachments/assets/93e9fdf2-0e1a-45c7-a239-3159554db777" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 211715" src="https://github.com/user-attachments/assets/ae93a3ae-4b58-4a1b-85ef-b08a5204d002" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 153510" src="https://github.com/user-attachments/assets/1d1ca4fe-bba0-4511-b716-be89d172d4e4" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 054143" src="https://github.com/user-attachments/assets/2c29ed7a-da1c-4999-945c-74b123cd3b99" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 054223" src="https://github.com/user-attachments/assets/94ce25e5-7309-4ed2-8ebe-0406632d77ad" />
<img width="1365" height="767" alt="Screenshot 2026-02-18 044825" src="https://github.com/user-attachments/assets/10399916-24fb-42da-971d-f39da5c141f6" />
<img width="1365" height="767" alt="Screenshot 2026-02-19 220344" src="https://github.com/user-attachments/assets/f0c9bd67-e091-4bbd-b2b9-6c13e900c37c" />
<img width="1365" height="767" alt="Screenshot 2026-02-20 015736" src="https://github.com/user-attachments/assets/d092160c-12be-4c76-9606-6d1043a305a2" />

---

## ✨ Features

### Playback
- 🎵 **Audio & Video Playback** — MP3, WAV, FLAC, OGG, AAC, M4A, OPUS, MP4, MKV, AVI, WEBM, MOV, and more
- 🦀 **Native Rust Audio Engine** — `media_engine`, a PyO3 extension that decodes with FFmpeg and outputs through `cpal` (WASAPI on Windows) using a lock-free ring buffer for glitch-free audio
- 📡 **Built-in Media HTTP Server** — streams local files over `http://127.0.0.1` to bypass EdgeWebView2's `file://` CORS restrictions on Windows, backed by a bounded thread pool and zero-copy `sendfile`
- ⏩ **HTTP Range Request Support** — accurate seeking without re-downloading the entire file
- 🎛️ **10-Band Equalizer** — 17 built-in presets (Flat, Acoustic, Bass Boost, Classical, Dance, Electronic, Hip-Hop, Jazz, Metal, Pop, R&B, Rock, Spoken Word, Treble Boost, Vocal, etc.), custom presets stored in `localStorage`, per-band control (31 Hz – 16 kHz)
- 🔀 **Shuffle & Repeat Modes** — shuffle, repeat all, repeat one
- 🎛️ **Full Playback Controls** — play/pause, previous, next, seek, volume, mute
- 📺 **Video Overlay Controls** — YouTube-style autohide controls with fullscreen support
- 📺 **TV & Radio Online** — stream online TV and radio stations (VLC-based TV player module)

### Library & Metadata
- 📋 **Playlist Management** — add files, add folders, reorder, filter, and delete tracks; saves are debounced so large playlists (5000+ tracks) stay responsive
- 💾 **Playlist Manager** — save/load/delete/export/import named playlists as `.macan.json` files
- 🖼️ **Embedded Cover Art** — extract album artwork from ID3/FLAC/OGG/MP4 tags via mutagen
- 🌐 **Online Album Art** — automatic fallback to the iTunes Search API when a track has no embedded art, cached locally (SQLite + disk)
- 🎤 **Lyrics** — reads embedded lyrics (ID3 USLT/SYLT, FLAC, M4A, OGG/Opus), fetches synced lyrics from [LRCLIB](https://lrclib.net) with a Musixmatch fallback, and caches everything in a local SQLite database
- 🏷️ **Advanced Tag Editor** — a standalone tag editor that launches lazily in its own process, so it costs nothing at startup
- 🖼️ **Video Seek Thumbnail Preview** — thumbnail preview on video seekbar hover, generated server-side in `core/video_utils.py` and persisted in a disk cache (validated by file mtime + size, so edited files never serve stale thumbnails)
- 🔄 **Media Converter** — convert audio/video with FFmpeg

### Visuals
- 🎨 **Animated Background Visualizer** — real-time frequency bars driven by FFT spectrum data, rendered on a `<canvas>`
- 🔊 **Mini Waveform Visualizer** — small waveform below the album art in the now-playing panel
- 🌈 **Dynamic Aura** — the UI accent color adapts to the current album art
- 🎞️ **Noise Overlay** — animated film-grain effect for a cinematic aesthetic
- 🪟 **Frameless Fullscreen Window** — custom chrome with minimize and close buttons
- 🕐 **Live Clock** — real-time time and date in the header

### Windows Integration
- 🎹 **Global Media Hotkeys** — system-wide shortcuts that work even when the window is not focused
- 🖱️ **Taskbar Thumbnail Toolbar** — Previous / Play-Pause / Next buttons on the taskbar preview, synced with the current track and accent color
- 💬 **Now Playing Bubble** — native notification bubble above the system tray with artist, title and artwork (toggle with the `notify_bubble_enabled` setting)
- ⌨️ **Hardware Media Keys & SMTC** — OS media overlay support through the Media Session API

### Extensibility
- 🧩 **Plugin System** — add features without modifying any core file using the Plugin Bridge Adapter. See [plugin_development.md](plugin_development.md)

### Quality of Life
- 💾 **Persistent Playlist & Settings** — automatically saved to `%LOCALAPPDATA%\MacanMediaPlayer` on Windows
- 🖱️ **Drag & Drop** — drop files directly into the player window
- ⚡ **Tuned for Low-End Machines** — trimmed WebView2 flags, capped JS heap, bounded worker pools, and throttled canvas effects

---

## 🖥️ Requirements

- **Python 3.10+**
- **Windows 10/11** (primary target): Microsoft Edge WebView2 Runtime (usually pre-installed)
- **Linux** (experimental): Qt WebEngine (`PyQt5` or `PyQt6`). Windows-only integrations (global hotkeys, taskbar thumbnail toolbar, now-playing bubble) are automatically disabled
- Python packages (see [`requirements.txt`](requirements.txt)):

| Package | Version | Purpose |
|---------|---------|---------|
| `pywebview` | `>= 4.4.1` | Window and JS ↔ Python bridge |
| `mutagen` | `>= 1.47.0` | Metadata, cover art and embedded lyrics |
| `requests` | `>= 2.31.0` | Online album art and lyrics |
| `Pillow` | `>= 10.0.0` | Album art resizing and caching |

- Optional: `opencv-python` for video seek thumbnails (`core/video_utils.py`)
- The native `media_engine` module (see [Native Engine](#-native-engine-rust))

---

## 📦 Installation

```bash
# Clone the repository
git clone https://github.com/danx123/macan-media-player.git
cd macan-media-player

# Install Python dependencies
pip install -r requirements.txt

# Optional: video seek thumbnails
pip install opencv-python
```

For Linux, also install a Qt backend:

```bash
pip install pyqt5   # or pyqt6
```

---

## 🚀 Usage

```bash
python main.py
```

The player launches in fullscreen and loads its UI from the `assets/` folder next to `main.py`.

---

## ⌨️ Keyboard Shortcuts

### In-app

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `→` | Seek forward 10s |
| `←` | Seek backward 10s |
| `Shift + →` | Next track |
| `Shift + ←` | Previous track |
| `↑` | Volume up |
| `↓` | Volume down |
| `M` | Toggle mute |
| `S` | Toggle shuffle |
| `R` | Cycle repeat mode |
| `N` | Next track |
| `P` | Previous track |

### Global (Windows, works when the window is not focused)

| Key | Action |
|-----|--------|
| `Ctrl + Alt + Space` | Play / Pause |
| `Ctrl + Alt + →` | Next track |
| `Ctrl + Alt + ←` | Previous track |

If another app has already claimed a combination, Macan skips it and keeps running.

---

## 🔧 How It Works

### The Media Server Problem (Windows)

EdgeWebView2 on Windows enforces strict CORS rules that block `<audio>` and `<video>` elements from loading `file://` URIs — even from the same machine. This causes a misleading `MEDIA_ELEMENT_ERROR: Format error` even for perfectly valid files.

**Macan solves this by running a lightweight HTTP server** (`_MediaServer`) on a random localhost port at startup. Every time a track is loaded, `get_file_url()` registers the file's absolute path with a unique token and returns an `http://127.0.0.1:<port>/media/<token>` URL. The browser then fetches media over HTTP — no CORS issues, full Range request support for seeking. Requests are served by a small fixed-size thread pool instead of one thread per request, which keeps CPU and thread usage predictable on low-spec machines.

```
JS calls get_file_url(path)
    → Python registers path, returns http://127.0.0.1:PORT/media/TOKEN
    → audio.src = "http://..." ✅ (EdgeWebView2 accepts this)
    → Seeking works via HTTP Range requests ✅
```

### Architecture

```
┌──────────────────────────────────────────────┐
│               pywebview window               │
│  ┌────────────────────────────────────────┐  │
│  │  index.html / script.js / style.css    │  │
│  │  equalizer · playlist-manager · radio  │  │
│  │  plugin-bridge.js  ←  plugins/*.js     │  │
│  └───────────────────┬────────────────────┘  │
│                      │ pywebview JS API      │
│  ┌───────────────────▼────────────────────┐  │
│  │          MacanMediaAPI (Python)        │  │
│  │  playlist · settings · plugin routing  │  │
│  └──┬──────────┬───────────┬───────────┬──┘  │
└─────┼──────────┼───────────┼───────────┼─────┘
      │          │           │           │
      ▼          ▼           ▼           ▼
 _MediaServer  SQLite     media_engine  Windows integration
 (localhost,   caches     (Rust, FFmpeg  · taskbar thumbbar
  Range +      · art      + cpal + FFT)  · now-playing bubble
  sendfile)    · lyrics                  · global hotkeys
               · video                   · SMTC / media keys
                 thumbs
```

### Native Engine (Rust)

`media_engine` (crate version 0.5.0) is a Rust extension module exposed to Python through [PyO3](https://pyo3.rs). It provides:

- **Playback engine** — FFmpeg decoding (`ffmpeg-next`, FFmpeg n9.0) with software resampling and scaling, output through `cpal` (WASAPI on Windows)
- **Lock-free audio path** — an SPSC ring buffer (`ringbuf`) between the decode thread and the real-time audio callback, so there are no mutexes on the audio thread
- **Real-time spectrum** — `rustfft` powers the FFT visualizer
- **Parallel analysis** — `rayon` computes waveform envelopes (RMS per segment) and BPM detection (autocorrelation) across all cores

The release profile is built for size and speed (`opt-level = 3`, fat LTO, single codegen unit, stripped, `panic = "abort"`).

**Building.** The Windows build is cross-compiled in CI (see `workflows/`), with FFmpeg compiled for the `mingw32` target and linked through `FFMPEG_DIR`. Prebuilt wheels are kept in `whl/`. On non-Windows targets `ffmpeg-sys-next` can build FFmpeg from source, and the ALSA backend needs `libasound2-dev`.

### Plugin System

Plugins are single self-contained JavaScript files in `assets/plugins/`, registered with one line in `assets/plugins.config.js`:

```js
MacanBridge.register({
  id:      'my-plugin',
  name:    'My Plugin',
  version: '1.0.0',
  on: {
    'track:load': (track) => console.log('Now playing:', track.name),
  },
});
```

A plugin can subscribe to playback events (`track:load`, `player:play`, `player:pause`, `player:seek`, `player:end`, `art:load`, `art:clear`, `queue:add`, `queue:clear`), read player state, show overlay panels and toasts, add navigation menu items, inject scoped CSS, and call Python handlers via `MacanBridge.py()`. The bundled **Sleep Timer** (`assets/plugins/sleep-timer.js`) is the reference implementation.

📖 Full guide: [plugin_development.md](plugin_development.md)

### Data & Cache Locations

Everything lives under `%LOCALAPPDATA%\MacanMediaPlayer` on Windows:

| Data | Storage |
|------|---------|
| Playlist & settings | SQLite / JSON |
| Album art cache | `AlbumArtCache/` (SQLite index + JPEG files) |
| Video thumbnail cache | `VideoThumbCache/` (SQLite index + JPEG files) |
| Lyrics | `lyrics.db` (SQLite) |
| Equalizer presets & plugin data | WebView2 `localStorage` |

---

## 📁 Project Structure

```
macan-media-player/
├── main.py                              # Python backend — pywebview window, API bridge, media server, caches
├── macan_taskbar_thumbbar_webview.py    # Windows taskbar thumbnail toolbar (Prev / Play-Pause / Next)
├── macan_now_playing_bubble.py          # Native "now playing" notification bubble
├── advanced_tag_editor.py               # Standalone tag editor (launched lazily as a separate process)
├── tv_vlc_player.py                     # VLC-based online TV player
├── image_engine/                        # Image processing engine used by main.py
├── core/
│   ├── __init__.py                      # Core package
│   ├── video_utils.py                   # OpenCV hover-thumbnail generator for the video seekbar
│   └── converter.py                     # FFmpeg audio/video converter
├── src/                                 # Rust source of the media_engine native module
├── Cargo.toml                           # Rust crate manifest (media_engine)
├── whl/                                 # Prebuilt native engine wheels
├── workflows/                           # CI build definitions
├── docs/                                # Additional documentation
├── assets/
│   ├── index.html                       # App shell and HTML structure
│   ├── style.css                        # Dark theme, animations, layout
│   ├── script.js                        # Playback engine, playlist, UI logic
│   ├── equalizer.js                     # 10-band equalizer engine
│   ├── playlist-manager.js              # Named playlists as .macan.json
│   ├── radio-tv.js                      # Online radio & TV
│   ├── converter.js                     # Converter UI
│   ├── nav-menu.js                      # Navigation menu
│   ├── plugin-bridge.js                 # Plugin Bridge Adapter (MacanBridge)
│   ├── plugins.config.js                # List of enabled plugins
│   └── plugins/
│       └── sleep-timer.js               # Reference plugin
├── libvlc.dll · libvlccore.dll          # Bundled VLC runtime for the TV player
│   axvlc.dll · npvlc.dll
├── icon.ico · tag.ico                   # App and tag editor icons
├── requirements.txt                     # Python dependencies
├── version.json                         # Current version metadata
├── plugin_development.md                # Plugin developer guide
└── LICENSE                              # MIT
```

---

## 🎨 Tech Stack

| Layer | Technology |
|-------|-----------|
| Window / Bridge | [pywebview](https://pywebview.flowrl.com/) (EdgeWebView2 on Windows, Qt on Linux) |
| UI | HTML5, CSS3, Vanilla JS |
| Fonts | Bebas Neue, Space Mono, Inter (Google Fonts) |
| Native engine | Rust · [PyO3](https://pyo3.rs) · [cpal](https://github.com/RustAudio/cpal) · [ringbuf](https://crates.io/crates/ringbuf) · [rustfft](https://crates.io/crates/rustfft) · [rayon](https://crates.io/crates/rayon) · [ndarray](https://crates.io/crates/ndarray) |
| Decoding | [FFmpeg](https://ffmpeg.org) via `ffmpeg-next` (n9.0) |
| Metadata | [mutagen](https://mutagen.readthedocs.io/) |
| Images | [Pillow](https://python-pillow.org/), OpenCV (video thumbnails) |
| Online data | `requests` — iTunes Search API (album art), LRCLIB / Musixmatch (lyrics) |
| Storage | SQLite (WAL mode) for art, video-thumbnail and lyrics caches |
| Media Server | Python `http.server` + `socketserver` with a bounded `ThreadPoolExecutor` and `sendfile` |
| TV player | VLC (`libvlc`) |
| Windows integration | Win32 API via `ctypes` (global hotkeys), taskbar thumbnail toolbar, SMTC / Media Session API |
| Visualizer | Canvas API fed by Rust FFT data |
| CI | GitHub Actions (cross-compiled Windows build) |

---

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change. Want to add a feature without touching core files? Write a [plugin](plugin_development.md).

---

## 📄 License

[MIT](LICENSE)
