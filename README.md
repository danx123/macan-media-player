# 🐯 Macan Media Player

A sleek, fullscreen desktop media player built with Python and pywebview. Macan delivers a modern, cinema-grade playback experience for both audio and video files — with a dark aesthetic, real-time visualizer, and a robust local media HTTP server that ensures reliable playback on Windows (EdgeWebView2).

---

## Screenshot
<img width="1365" height="767" alt="Screenshot 2026-03-19 033913" src="https://github.com/user-attachments/assets/c9225aad-41c1-48f1-a862-6c8f9d3e3399" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 211708" src="https://github.com/user-attachments/assets/db0b4eab-4069-4d8d-9ab3-bf1f1a2e58e8" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 153459" src="https://github.com/user-attachments/assets/93e9fdf2-0e1a-45c7-a239-3159554db777" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 211715" src="https://github.com/user-attachments/assets/ae93a3ae-4b58-4a1b-85ef-b08a5204d002" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 153510" src="https://github.com/user-attachments/assets/1d1ca4fe-bba0-4511-b716-be89d172d4e4" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 054143" src="https://github.com/user-attachments/assets/2c29ed7a-da1c-4999-945c-74b123cd3b99" />
<img width="1365" height="767" alt="Screenshot 2026-02-23 054223" src="https://github.com/user-attachments/assets/94ce25e5-7309-4ed2-8ebe-0406632d77ad" />
<img width="1365" height="767" alt="Screenshot 2026-02-18 044825" src="https://github.com/user-attachments/assets/10399916-24fb-42da-971d-f39da5c141f6" />
<img width="1365" height="767" alt="Screenshot 2026-02-19 220344" src="https://github.com/user-attachments/assets/f0c9bd67-e091-4bbd-b2b9-6c13e900c37c" />
<img width="1365" height="767" alt="Screenshot 2026-02-20 015736" src="https://github.com/user-attachments/assets/d092160c-12be-4c76-9606-6d1043a305a2" />





## ✨ Features

- 🎵 Audio & Video Playback — supports MP3, WAV, FLAC, OGG, AAC, M4A, OPUS, MP4, MKV, AVI, WEBM, MOV, and more
- 📡 Built-in Media HTTP Server — streams local files over http://127.0.0.1 to bypass EdgeWebView2's file:// CORS restrictions on Windows
- ⏩ HTTP Range Request Support — enables accurate seeking without re-downloading the entire file
- 🎨 Animated Background Visualizer — real-time frequency bars that respond to playback state, rendered on a <canvas> element
- 🎛️ 10-Band Equalizer — full-featured EQ with 17 built-in presets (Flat, Acoustic, Bass Boost, Classical, Dance, Electronic, Hip-Hop, Jazz, Metal, Pop, R&B, Rock, Spoken Word, Treble Boost, Vocal, etc.), custom preset storage via localStorage, and per-band control (31 Hz – 16 kHz)
- 📋 Playlist Management — add files, add folders, reorder, filter, and delete tracks
- 💾 Playlist Manager — save/load/delete/export/import named playlists as .macan.json files
- 🔀 Shuffle & Repeat Modes — shuffle, repeat all, repeat one
- 🖼️ Embedded Cover Art — extract and display album artwork from ID3/FLAC/OGG tags via mutagen
- 🎛️ Full Playback Controls — play/pause, previous, next, seek, volume, mute
- 📺 Video Overlay Controls — YouTube-style autohide controls with fullscreen support
- 📺 TV & Radio Online
- 🖼️ Video Seek Thumbnail Preview — thumbnail preview on video seekbar hover, generated server-side via cv2 (OpenCV) in core/video_utils.py
- 🕐 Live Clock — real-time time and date in header
- 💾 Persistent Playlist & Settings — automatically saved to %LOCALAPPDATA%\MacanMediaPlayer on Windows
- ⌨️ Keyboard Shortcuts — full keyboard control for power users
- 🖱️ Drag & Drop — drop files directly into the player window
- 🪟 Frameless Fullscreen Window — custom chrome window with minimize and close buttons
- 🔊 Mini Waveform Visualizer — small waveform visualizer below album art in the now-playing panel
- 🎞️ Noise Overlay — animated film-grain effect on the canvas for a cinematic aesthetic

---

## 🖥️ Requirements

- Python 3.8+
- [pywebview](https://pywebview.flowrl.com/) `>= 4.0`
- [mutagen](https://mutagen.readthedocs.io/) (for metadata and cover art extraction)
- Windows: Microsoft Edge WebView2 Runtime (usually pre-installed on Windows 10/11)
- Linux/macOS: Qt WebEngine (`PyQt5` or `PyQt6`)

---

## 📦 Installation

```bash
# Clone the repository
git clone https://github.com/danx123/macan-media-player.git
cd macan-media-player

# Install dependencies
pip install pywebview mutagen
```

For Linux/macOS, also install a Qt backend:

```bash
pip install pyqt5   # or pyqt6
```

---

## 🚀 Usage

```bash
python main.py
```

The player launches in fullscreen. Place your HTML/CSS/JS assets inside an `assets/` folder in the same directory as `main.py`.

```
macan-media-player/
├── main.py
└── assets/
    ├── index.html
    ├── style.css
    └── script.js
```

---

## ⌨️ Keyboard Shortcuts

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

---

## 🔧 How It Works

### The Media Server Problem (Windows)

EdgeWebView2 on Windows enforces strict CORS rules that block `<audio>` and `<video>` elements from loading `file://` URIs — even from the same machine. This causes a misleading `MEDIA_ELEMENT_ERROR: Format error` even for perfectly valid files.

**Macan solves this by running a lightweight HTTP server** (`_MediaServer`) on a random localhost port at startup. Every time a track is loaded, `get_file_url()` registers the file's absolute path with a unique token and returns an `http://127.0.0.1:<port>/media/<token>` URL. The browser then fetches media over HTTP — no CORS issues, full Range request support for seeking.

```
JS calls get_file_url(path)
    → Python registers path, returns http://127.0.0.1:PORT/media/TOKEN
    → audio.src = "http://..." ✅ (EdgeWebView2 accepts this)
    → Seeking works via HTTP Range requests ✅
```

### Architecture

```
┌─────────────────────────────────┐
│          pywebview window        │
│  ┌───────────────────────────┐  │
│  │   index.html / script.js  │  │
│  │   (UI + playback logic)   │  │
│  └──────────┬────────────────┘  │
│             │ pywebview JS API  │
│  ┌──────────▼────────────────┐  │
│  │     MacanMediaAPI (Py)    │  │
│  │  browse_files()           │  │
│  │  get_file_url()  ─────────┼──┼──► _MediaServer (localhost)
│  │  get_cover_art()          │  │         streams file bytes
│  └───────────────────────────┘  │         with Range support
└─────────────────────────────────┘
```

---

## 📁 Project Structure

```
macan-media-player/
├── main.py                  # Python backend — pywebview window, API bridge, media server
├── core/
│   └── __init__.py          # Core package placeholder
│   └── video_utils.py       # Core OpenCV generate hover thumbnail seekbar
│   └── converter.py         # Core ffmpeg to convert audio/video
└── assets/
    ├── index.html           # App shell and HTML structure
    ├── converter.js         # Engine for converter
    ├── equalizer.js         # Engine for equalizer
    ├── playlist-manager.js  # For manage playlist with .json
    ├── radio-tv.js          # For manage radio & tv online
    ├── style.css            # Dark theme, animations, layout
    └── script.js            # Playback engine, playlist, UI logic
```

---

## 🎨 Tech Stack

| Layer | Technology |
|-------|-----------|
| Window / Bridge | [pywebview](https://pywebview.flowrl.com/) |
| UI | HTML5, CSS3, Vanilla JS |
| Fonts | Bebas Neue, Space Mono, Inter (Google Fonts) |
| Metadata | [mutagen](https://mutagen.readthedocs.io/) |
| Media Server | Python `http.server` + `socketserver` (stdlib) |
| Visualizer | Canvas API |

---

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.

---

## 📄 License

[MIT](LICENSE)
