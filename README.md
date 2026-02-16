# 🐯 Macan Media Player

A sleek, fullscreen desktop media player built with Python and pywebview. Macan delivers a modern, cinema-grade playback experience for both audio and video files — with a dark aesthetic, real-time visualizer, and a robust local media HTTP server that ensures reliable playback on Windows (EdgeWebView2).

---

## Screenshot
<img width="1365" height="767" alt="image" src="https://github.com/user-attachments/assets/85a44ce8-5154-48c9-a896-d7cd18c0c807" />


## ✨ Features

- 🎵 **Audio & Video Playback** — supports MP3, WAV, FLAC, OGG, AAC, M4A, OPUS, MP4, MKV, AVI, WEBM, MOV, and more
- 📡 **Built-in Media HTTP Server** — streams local files over `http://127.0.0.1` to bypass EdgeWebView2's `file://` CORS restrictions on Windows
- ⏩ **HTTP Range Request Support** — enables accurate seeking without re-downloading the entire file
- 🎨 **Animated Background Visualizer** — real-time frequency bars that respond to playback state
- 📋 **Playlist Management** — add files, add entire folders, reorder, filter, and remove tracks
- 🔀 **Shuffle & Repeat Modes** — shuffle, repeat all, repeat one
- 🖼️ **Embedded Cover Art** — extracts and displays album artwork from ID3/FLAC/OGG tags via `mutagen`
- 🎛️ **Full Playback Controls** — play/pause, previous, next, seek, volume, mute
- 📺 **Video Overlay Controls** — YouTube-style autohiding controls with fullscreen support
- 🕐 **Live Clock** — real-time clock and date display in the header
- 💾 **Persistent Playlist & Settings** — automatically saved to `%LOCALAPPDATA%\MacanMediaPlayer` on Windows
- ⌨️ **Keyboard Shortcuts** — full keyboard control for power users
- 🖱️ **Drag & Drop** — drop files directly onto the player window
- 🪟 **Frameless Fullscreen Window** — custom window chrome with minimize and close controls

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
├── main.py          # Python backend — pywebview window, API bridge, media server
├── core/
│   └── __init__.py  # Core package placeholder
└── assets/
    ├── index.html   # App shell and HTML structure
    ├── style.css    # Dark theme, animations, layout
    └── script.js    # Playback engine, playlist, UI logic
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
