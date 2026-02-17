import os
import sys
import json
import base64
import hashlib
import threading
import http.server
import socketserver
import secrets
import mimetypes
import urllib.parse
import sqlite3
import requests
from io import BytesIO
from pathlib import Path

import webview
import mutagen
from mutagen.mp4 import MP4
from mutagen.id3 import ID3
from mutagen.flac import FLAC
from mutagen.oggvorbis import OggVorbis

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

from core.video_utils import VideoThumbnailer

if hasattr(webview, 'settings'):
    webview.settings['ALLOW_DOWNLOADS'] = True

GUI_BACKEND = 'edgechromium' if sys.platform == 'win32' else 'qt'


# ─── LOCAL MEDIA HTTP SERVER ──────────────────────────────────────────────────
# EdgeWebView2 on Windows blocks <audio>/<video> with file:// src (CORS).
# Fix: tiny localhost HTTP server that streams any local file via http://.
# Supports HTTP Range requests so seeking works correctly in <audio>/<video>.

class _MediaRequestHandler(http.server.BaseHTTPRequestHandler):
    registry: dict = {}  # token -> Path

    def log_message(self, fmt, *args):
        pass  # suppress logs

    def _resolve(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = parsed.path.strip('/').split('/')
        if len(parts) != 2 or parts[0] != 'media':
            return None
        return _MediaRequestHandler.registry.get(parts[1])

    def do_HEAD(self):
        fp = self._resolve()
        if not fp or not fp.exists():
            self.send_error(404); return
        mime, _ = mimetypes.guess_type(str(fp))
        self.send_response(200)
        self.send_header('Content-Type', mime or 'application/octet-stream')
        self.send_header('Content-Length', str(fp.stat().st_size))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

    def do_GET(self):
        fp = self._resolve()
        if not fp or not fp.exists():
            self.send_error(404); return
        mime, _ = mimetypes.guess_type(str(fp))
        mime = mime or 'application/octet-stream'
        file_size = fp.stat().st_size
        range_header = self.headers.get('Range')
        try:
            if range_header:
                range_val = range_header.strip().replace('bytes=', '')
                start_str, end_str = range_val.split('-')
                start = int(start_str) if start_str else 0
                end   = int(end_str)   if end_str   else file_size - 1
                end   = min(end, file_size - 1)
                length = end - start + 1
                self.send_response(206)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
                self.send_header('Content-Length', str(length))
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                with open(fp, 'rb') as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk: break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            else:
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(file_size))
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                with open(fp, 'rb') as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk: break
                        self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client disconnected mid-stream (normal during seeks)


class _MediaServer:
    def __init__(self):
        self.port = None
        self._path_to_token: dict = {}

    def start(self):
        _MediaRequestHandler.registry = {}
        server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), _MediaRequestHandler)
        server.daemon_threads = True
        self.port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"[MediaServer] Listening on http://127.0.0.1:{self.port}/")

    def register(self, filepath: Path) -> str:
        key = str(filepath)
        if key not in self._path_to_token:
            token = secrets.token_urlsafe(16)
            self._path_to_token[key] = token
            _MediaRequestHandler.registry[token] = filepath
        return f"http://127.0.0.1:{self.port}/media/{self._path_to_token[key]}"


# ─── Single instance (declared once, here) ───────────────────────────────────
_media_server = _MediaServer()


# ─── ALBUM ART CACHE ──────────────────────────────────────────────────────────

class AlbumArtCache:
    """Manages online album art fetching and local SQLite cache."""

    def __init__(self, app_data_dir):
        self.cache_dir = os.path.join(app_data_dir, "AlbumArtCache")
        os.makedirs(self.cache_dir, exist_ok=True)
        self.db_path = os.path.join(self.cache_dir, "art_cache.db")
        self._init_db()

    def _init_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute('''CREATE TABLE IF NOT EXISTS album_art (
            query_hash TEXT PRIMARY KEY,
            artist TEXT, title TEXT, local_path TEXT
        )''')
        conn.commit()
        conn.close()

    def _hash(self, artist, title):
        s = f"{artist}-{title}".lower().strip()
        return hashlib.md5(s.encode('utf-8')).hexdigest()

    def get_cached(self, artist, title):
        h = self._hash(artist, title)
        conn = sqlite3.connect(self.db_path)
        row = conn.execute("SELECT local_path FROM album_art WHERE query_hash=?", (h,)).fetchone()
        conn.close()
        if row and os.path.exists(row[0]):
            with open(row[0], 'rb') as f:
                data = f.read()
            mime = 'image/jpeg'
            return f"data:{mime};base64,{base64.b64encode(data).decode()}"
        return None

    def fetch_online(self, artist, title):
        """Try iTunes API, save to cache. Returns base64 data-URL or None."""
        if not artist or not title:
            return None
        try:
            term = f"{artist} {title}"
            resp = requests.get("https://itunes.apple.com/search",
                                params={"term": term, "media": "music", "entity": "song", "limit": 1},
                                timeout=6)
            if resp.status_code == 200:
                results = resp.json().get("results", [])
                if results:
                    art_url = results[0].get("artworkUrl100", "").replace("100x100", "600x600")
                    if art_url:
                        img_resp = requests.get(art_url, timeout=10)
                        if img_resp.status_code == 200:
                            return self._save_and_return(artist, title, img_resp.content)
        except Exception as e:
            print(f"[ArtCache] Network error: {e}")
        return None

    def _save_and_return(self, artist, title, image_data):
        h = self._hash(artist, title)
        file_path = os.path.join(self.cache_dir, f"{h}.jpg")
        try:
            if PIL_AVAILABLE:
                img = Image.open(BytesIO(image_data))
                img = img.convert("RGB")
                img.thumbnail((500, 500))
                img.save(file_path, "JPEG", quality=85)
            else:
                with open(file_path, 'wb') as f:
                    f.write(image_data)
            conn = sqlite3.connect(self.db_path)
            conn.execute("INSERT OR REPLACE INTO album_art (query_hash,artist,title,local_path) VALUES(?,?,?,?)",
                         (h, artist, title, file_path))
            conn.commit()
            conn.close()
            with open(file_path, 'rb') as f:
                data = f.read()
            return f"data:image/jpeg;base64,{base64.b64encode(data).decode()}"
        except Exception as e:
            print(f"[ArtCache] Save error: {e}")
        return None


# ─── LYRIC CACHE ──────────────────────────────────────────────────────────────

class LyricCache:
    """Local SQLite lyrics store + LRCLIB online fetch."""

    def __init__(self, app_data_dir):
        self.db_path = os.path.join(app_data_dir, "lyrics.db")
        self._init_db()

    def _conn(self):
        return sqlite3.connect(self.db_path, check_same_thread=False)

    def _init_db(self):
        conn = self._conn()
        conn.execute('''CREATE TABLE IF NOT EXISTS lyrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            artist TEXT, title TEXT, content TEXT, is_synced INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(artist, title)
        )''')
        conn.commit()
        conn.close()

    def get(self, artist, title):
        conn = self._conn()
        row = conn.execute(
            "SELECT content, is_synced FROM lyrics WHERE lower(artist)=? AND lower(title)=?",
            (artist.lower().strip(), title.lower().strip())
        ).fetchone()
        conn.close()
        if row:
            return {"content": row[0], "is_synced": bool(row[1])}
        return None

    def save(self, artist, title, content, is_synced):
        try:
            conn = self._conn()
            conn.execute("INSERT OR REPLACE INTO lyrics (artist,title,content,is_synced) VALUES(?,?,?,?)",
                         (artist.lower().strip(), title.lower().strip(), content, int(is_synced)))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[LyricDB] Error: {e}")

    def fetch_online(self, artist, title, duration=None):
        """Fetch from LRCLIB, save to DB, return dict or None."""
        try:
            clean_artist = artist.split("feat")[0].split("(")[0].strip()
            clean_title  = title.split("(")[0].strip()
            params = {"artist_name": clean_artist, "track_name": clean_title}
            if duration and duration > 0:
                params["duration"] = int(duration)
            resp = requests.get("https://lrclib.net/api/get", params=params, timeout=10)
            if resp.status_code == 200:
                return self._process(artist, title, resp.json())
            elif resp.status_code == 404:
                # fuzzy fallback
                resp2 = requests.get("https://lrclib.net/api/search",
                                     params={"q": f"{clean_artist} {clean_title}"}, timeout=10)
                if resp2.status_code == 200:
                    results = resp2.json()
                    if results and isinstance(results, list):
                        return self._process(artist, title, results[0])
        except Exception as e:
            print(f"[LyricDB] Fetch error: {e}")
        return None

    def _process(self, artist, title, data):
        content = None
        is_synced = False
        if data.get("syncedLyrics"):
            content = data["syncedLyrics"]
            is_synced = True
        elif data.get("plainLyrics"):
            content = data["plainLyrics"]
            is_synced = False
        if content:
            self.save(artist, title, content, is_synced)
            return {"content": content, "is_synced": is_synced}
        return None


# ─── MAIN API CLASS ───────────────────────────────────────────────────────────

class MacanMediaAPI:
    """Bridge Class: Methods callable from JavaScript"""

    def __init__(self):
        self._window = None
        self.playlist = []
        self.settings = {}
        self._load_settings()
        app_data = self._get_app_data()
        self._art_cache   = AlbumArtCache(app_data)
        self._lyric_cache = LyricCache(app_data)

    def set_window(self, window):
        self._window = window

    # ─── WINDOW MANAGEMENT ───────────────────────────────────────────────────

    def close_app(self):
        print("[MACAN] Shutdown initiated...")
        def delayed_close():
            import time
            time.sleep(0.1)
            self._window.destroy()
        threading.Thread(target=delayed_close, daemon=True).start()

    def minimize_app(self):
        self._window.minimize()

    def toggle_fullscreen(self):
        self._window.toggle_fullscreen()

    # ─── DIALOG & FILE BROWSING ───────────────────────────────────────────────

    def browse_files(self):
        """Open file dialog. Returns list of file path strings."""
        file_types = (
            'Media Files (*.mp3;*.mp4;*.wav;*.flac;*.ogg;*.aac;*.mkv;*.avi;*.webm;*.m4a;*.opus)',
            'Audio (*.mp3;*.wav;*.flac;*.ogg;*.aac;*.m4a;*.opus)',
            'Video (*.mp4;*.mkv;*.avi;*.webm)',
            'All files (*.*)'
        )
        result = self._open_dialog(allow_multiple=True, file_types=file_types)
        if result:
            return list(result)  # raw file paths — JS calls add_tracks() next
        return []

    def browse_folder(self):
        """Open folder dialog. Returns list of media file path strings."""
        result = self._folder_dialog()
        if result and len(result) > 0:
            return self._scan_media_folder_paths(result[0])  # raw paths
        return []

    def get_file_url(self, path):
        """Return an http:// URL for a local media file served via MediaServer.
        Bypasses EdgeWebView2's file:// CORS block on Windows."""
        try:
            p = Path(path).resolve()
            if not p.exists():
                p = Path(urllib.parse.unquote(path)).resolve()
            if not p.exists():
                print(f"[MACAN] File not found: {path}")
                return None
            url = _media_server.register(p)
            print(f"[MACAN] Serving: {url}  ← {p.name}")
            return url
        except Exception as e:
            print(f"[MACAN] get_file_url error: {e}")
            return None

    # ─── PLAYLIST MANAGEMENT ─────────────────────────────────────────────────

    def get_playlist(self):
        return self.playlist

    def add_tracks(self, file_paths):
        """Accept list of file path strings, build track metadata, append to playlist."""
        for fp in file_paths:
            abs_path = str(Path(fp).resolve())
            if not any(t['path'] == abs_path for t in self.playlist):
                track = self._build_track_meta(fp)
                self.playlist.append(track)
        self._save_playlist()
        return self.playlist

    def remove_track(self, path):
        self.playlist = [t for t in self.playlist if t['path'] != path]
        self._save_playlist()
        return self.playlist

    def clear_playlist(self):
        self.playlist = []
        self._save_playlist()
        return []

    # ─── MEDIA METADATA ───────────────────────────────────────────────────────

    def get_cover_art(self, path):
        """Extract Cover Art (MP3, FLAC, M4A/MP4)."""
        path = str(path)
        if not os.path.exists(path):
            return None
        try:
            ext = os.path.splitext(path)[1].lower()

            # 1. Handle M4A / MP4
            if ext in ['.m4a', '.mp4']:
                audio_file = MP4(path)
                if 'covr' in audio_file and audio_file['covr']:
                    data = bytes(audio_file['covr'][0])
                    encoded = base64.b64encode(data).decode('utf-8')
                    mime = 'image/png' if data.startswith(b'\x89PNG') else 'image/jpeg'
                    return f"data:{mime};base64,{encoded}"

            # 2. Handle MP3 (ID3)
            elif ext == '.mp3':
                audio_file = ID3(path)
                for tag in audio_file.values():
                    if hasattr(tag, 'data') and tag.data and 'APIC' in tag.HashKey:
                        encoded = base64.b64encode(tag.data).decode('utf-8')
                        return f"data:image/jpeg;base64,{encoded}"

            # 3. Handle FLAC
            elif ext == '.flac':
                audio_file = FLAC(path)
                if audio_file.pictures:
                    pic = audio_file.pictures[0]
                    encoded = base64.b64encode(pic.data).decode('utf-8')
                    return f"data:{pic.mime};base64,{encoded}"

            # 4. Fallback Generic Mutagen
            else:
                audio_file = mutagen.File(path)
                if audio_file and hasattr(audio_file, 'pictures') and audio_file.pictures:
                    pic = audio_file.pictures[0]
                    encoded = base64.b64encode(pic.data).decode('utf-8')
                    return f"data:{pic.mime};base64,{encoded}"

        except Exception as e:
            print(f"[Metadata] Error reading art for {path}: {e}")

        return None

    def get_video_preview(self, path, time_sec):
        """API called from JS when hovering video seekbar.
        path must be the original file path (track.path), not the http:// URL."""
        if path.startswith('http'):
            return None  # can't grab frames from localhost stream via OpenCV
        return VideoThumbnailer.get_thumbnail_at_time(path, float(time_sec))

    def save_settings(self, settings_dict):
        self.settings.update(settings_dict)
        self._save_settings()
        return True

    def get_settings(self):
        return self.settings

    # ─── PRIVATE: DIALOG WRAPPERS ─────────────────────────────────────────────

    def _open_dialog(self, allow_multiple=False, file_types=()):
        try:
            from webview import FileDialog
            dialog_type = FileDialog.OPEN
        except ImportError:
            try:
                from webview.util import FileDialog
                dialog_type = FileDialog.OPEN
            except ImportError:
                dialog_type = webview.OPEN_DIALOG
        try:
            return self._window.create_file_dialog(
                dialog_type, allow_multiple=allow_multiple, file_types=file_types)
        except Exception as e:
            print(f"[MACAN] Open dialog error: {e}")
            return None

    def _folder_dialog(self):
        try:
            from webview import FileDialog
            dialog_type = FileDialog.FOLDER
        except ImportError:
            try:
                from webview.util import FileDialog
                dialog_type = FileDialog.FOLDER
            except ImportError:
                dialog_type = webview.FOLDER_DIALOG
        try:
            return self._window.create_file_dialog(dialog_type)
        except Exception as e:
            print(f"[MACAN] Folder dialog error: {e}")
            return None

    # ─── PRIVATE: TRACK / SCAN HELPERS ───────────────────────────────────────

    def _build_track_meta(self, filepath):
        p = Path(filepath)
        ext = p.suffix.lower()
        is_video = ext in {'.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv'}
        abs_path = str(p.resolve())

        # Read metadata (title, artist, album) from tags
        meta = self._read_tags(abs_path, ext, is_video)
        duration = meta.get('duration') or self._get_duration(abs_path)

        # Display name: prefer tag title, else filename stem
        display_name = meta.get('title') or p.stem
        artist       = meta.get('artist') or ''
        album        = meta.get('album')  or ''

        # Pre-fetch cover art for audio files
        cover_art = None
        if not is_video:
            try:
                cover_art = self.get_cover_art(abs_path)
            except Exception:
                cover_art = None

        return {
            "name":         display_name,
            "artist":       artist,
            "album":        album,
            "path":         abs_path,
            "url":          p.resolve().as_uri(),
            "ext":          ext.lstrip('.').upper(),
            "is_video":     is_video,
            "duration":     duration,
            "duration_str": self._format_duration(duration),
            "cover_art":    cover_art,
        }

    def _scan_media_folder_paths(self, folder):
        """Recursively scan folder and return list of media file path strings."""
        extensions = {'.mp3', '.mp4', '.wav', '.flac', '.ogg', '.aac',
                      '.mkv', '.avi', '.webm', '.m4a', '.opus', '.mov', '.wmv'}
        paths = []
        for root, dirs, files in os.walk(folder):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for f in sorted(files):
                if Path(f).suffix.lower() in extensions:
                    paths.append(os.path.join(root, f))
        return paths

    def _read_tags(self, path, ext, is_video):
        """Read title, artist, album, duration from file tags."""
        result = {}
        if is_video:
            return result
        try:
            audio_file = mutagen.File(path, easy=True)
            if audio_file is None:
                return result
            # EasyID3 / EasyMP4 use lowercase list values
            def _get(key):
                val = audio_file.get(key)
                if val and isinstance(val, (list, tuple)) and val[0]:
                    return str(val[0]).strip()
                return None
            result['title']    = _get('title')
            result['artist']   = _get('artist')
            result['album']    = _get('album')
            if audio_file.info:
                result['duration'] = int(audio_file.info.length)
        except Exception as e:
            print(f"[Tags] Could not read tags for {path}: {e}")
        return result

    # ─── ONLINE ART FALLBACK ──────────────────────────────────────────────────

    def get_cover_art_with_online_fallback(self, path):
        """Get cover art: embedded tags → local cache → iTunes API."""
        # 1. Try embedded art first
        embedded = self.get_cover_art(path)
        if embedded:
            return embedded

        # 2. Need artist + title for online search
        p = Path(path)
        ext = p.suffix.lower()
        meta = self._read_tags(str(p.resolve()), ext, False)
        artist = meta.get('artist') or ''
        title  = meta.get('title')  or p.stem

        if not artist:
            return None  # can't search without artist

        # 3. Check local SQLite cache
        cached = self._art_cache.get_cached(artist, title)
        if cached:
            return cached

        # 4. Fetch from iTunes API in background thread (non-blocking) — 
        #    return None now; JS will call this again or use polling
        def _bg():
            result = self._art_cache.fetch_online(artist, title)
            if result and self._window:
                # Push art update to frontend via JS eval
                safe_path = path.replace('\\', '\\\\').replace("'", "\\'")
                js = f"window.onOnlineArtReady && window.onOnlineArtReady('{safe_path}', `{result}`);"
                try:
                    self._window.evaluate_js(js)
                except Exception:
                    pass
        threading.Thread(target=_bg, daemon=True).start()
        return None

    # ─── LYRICS ───────────────────────────────────────────────────────────────

    def get_lyrics(self, path, artist, title, duration=None):
        """Get lyrics for a track. Checks DB first, then fetches online.
        Returns {content, is_synced} or None."""
        # Normalise inputs — use tag data as fallback
        if not artist or not title:
            p = Path(path)
            meta = self._read_tags(str(p.resolve()), p.suffix.lower(), False)
            artist = artist or meta.get('artist') or ''
            title  = title  or meta.get('title')  or p.stem

        if not artist or not title:
            return None

        # 1. Local DB
        cached = self._lyric_cache.get(artist, title)
        if cached:
            return cached

        # 2. Online fetch (synchronous — called from JS, runs in thread)
        result = self._lyric_cache.fetch_online(artist, title, duration)
        return result



        try:
            audio_file = mutagen.File(path)
            if audio_file and audio_file.info:
                return int(audio_file.info.length)
        except Exception:
            pass
        return 0

    def _format_duration(self, seconds):
        if not seconds:
            return "--:--"
        m, s = divmod(int(seconds), 60)
        h, m = divmod(m, 60)
        return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"

    # ─── PRIVATE: PERSISTENCE ─────────────────────────────────────────────────

    def _get_app_data(self):
        if os.name == 'nt':
            return os.path.join(os.getenv('LOCALAPPDATA', ''), 'MacanMediaPlayer')
        return os.path.join(os.path.expanduser('~'), '.macan_media_player')

    def _load_settings(self):
        app_data = self._get_app_data()
        os.makedirs(app_data, exist_ok=True)
        for attr, fname in [('settings', 'settings.json'), ('playlist', 'playlist.json')]:
            fpath = os.path.join(app_data, fname)
            if os.path.exists(fpath):
                try:
                    with open(fpath, 'r', encoding='utf-8') as f:
                        setattr(self, attr, json.load(f))
                except Exception:
                    setattr(self, attr, {} if attr == 'settings' else [])

    def _save_settings(self):
        fpath = os.path.join(self._get_app_data(), 'settings.json')
        with open(fpath, 'w', encoding='utf-8') as f:
            json.dump(self.settings, f, indent=2)

    def _save_playlist(self):
        fpath = os.path.join(self._get_app_data(), 'playlist.json')
        with open(fpath, 'w', encoding='utf-8') as f:
            json.dump(self.playlist, f, indent=2)


def main():
    # Start media server BEFORE creating the window
    _media_server.start()

    api = MacanMediaAPI()
    base_dir = os.path.dirname(os.path.abspath(__file__))
    entry_point = os.path.join(base_dir, 'assets', 'index.html')

    window = webview.create_window(
        title='Macan Media Player',
        url=entry_point,
        js_api=api,
        frameless=True,
        fullscreen=True,
        background_color='#030303',
        text_select=False,
        easy_drag=False,
    )

    api.set_window(window)
    webview.start(debug=False, gui=GUI_BACKEND)


if __name__ == '__main__':
    main()
