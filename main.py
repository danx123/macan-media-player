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

# ── EdgeWebView2: enable SMTC / Media Session API ────────────────────────────
# Without these flags, navigator.mediaSession exists but is silently ignored —
# the OS overlay, taskbar thumbnail, and hardware media keys won't respond.
# Must be set before webview.start() is called (env var is read at process start).
if sys.platform == 'win32':
    _wv2_flags = ' '.join([
        '--enable-features=HardwareMediaKeyHandling,MediaSessionService',
        '--autoplay-policy=no-user-gesture-required',
    ])
    _existing = os.environ.get('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '')
    if '--enable-features=HardwareMediaKeyHandling' not in _existing:
        os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = (
            (_existing + ' ' + _wv2_flags).strip()
        )



# ─── LOCAL MEDIA HTTP SERVER ──────────────────────────────────────────────────
# EdgeWebView2 on Windows blocks <audio>/<video> with file:// src (CORS).
# Fix: tiny localhost HTTP server that streams any local file via http://.
# Supports HTTP Range requests so seeking works correctly in <audio>/<video>.

class _MediaRequestHandler(http.server.BaseHTTPRequestHandler):
    registry: dict = {}  # token -> Path

    def log_message(self, fmt, *args):
        pass  # suppress request logs

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
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass  # client disconnected mid-stream (normal during seeks/track changes on Windows)


class _SilentTCPServer(socketserver.ThreadingTCPServer):
    """ThreadingTCPServer that silences client-disconnect errors (WinError 10053/10054)."""
    def handle_error(self, request, client_address):
        import sys
        exc = sys.exc_info()[1]
        # Silently ignore normal client-abort / connection-reset errors
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError,
                            BrokenPipeError, OSError)):
            return
        # Let anything unexpected propagate to stderr
        super().handle_error(request, client_address)


class _MediaServer:
    def __init__(self):
        self.port = None
        self._path_to_token: dict = {}

    def start(self):
        _MediaRequestHandler.registry = {}
        server = _SilentTCPServer(('127.0.0.1', 0), _MediaRequestHandler)
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
        # FIX: Lock to prevent concurrent save_app_state / _save_settings calls
        # from multiple JS threads (pywebview calls each JS→Python bridge on its
        # own thread, so parallel invocations are possible).
        self._settings_lock = threading.Lock()
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

    def update_track_art(self, path, cover_art):
        """Called from JS when cover art is fetched asynchronously (online fallback
        or first-time fetch). Persists art back into playlist.json so restarts
        and clear+reload cycles don't lose it."""
        updated = False
        for track in self.playlist:
            if track.get('path') == path:
                track['cover_art'] = cover_art
                updated = True
                break
        if updated:
            self._save_playlist()
        return updated

    def update_track_video_thumb(self, path, video_thumb):
        """Same as update_track_art but for video thumbnails."""
        updated = False
        for track in self.playlist:
            if track.get('path') == path:
                track['video_thumb'] = video_thumb
                updated = True
                break
        if updated:
            self._save_playlist()
        return updated

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

    def get_video_thumbnail(self, path):
        """Return a base64 thumbnail for a video file, extracted at ~10% of duration.
        Result is cached in memory keyed by path so repeat calls are instant.
        Returns data URI string or None on failure."""
        if not hasattr(self, '_video_thumb_cache'):
            self._video_thumb_cache = {}
        if path in self._video_thumb_cache:
            return self._video_thumb_cache[path]
        try:
            import cv2
            cap = cv2.VideoCapture(path)
            if not cap.isOpened():
                self._video_thumb_cache[path] = None
                return None
            total = cap.get(cv2.CAP_PROP_FRAME_COUNT)
            fps   = cap.get(cv2.CAP_PROP_FPS) or 24
            # Seek to ~10% of duration, minimum 1 second in
            seek_frame = max(int(fps), int(total * 0.10))
            cap.set(cv2.CAP_PROP_POS_FRAMES, seek_frame)
            ret, frame = cap.read()
            cap.release()
            if not ret or frame is None:
                self._video_thumb_cache[path] = None
                return None
            # Resize to 160×90 (16:9) keeping aspect ratio
            h, w = frame.shape[:2]
            target_w, target_h = 160, 90
            scale = min(target_w / w, target_h / h)
            nw, nh = int(w * scale), int(h * scale)
            frame = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
            # Pad to exact size
            canvas = __import__('numpy').zeros((target_h, target_w, 3), dtype='uint8')
            x_off = (target_w - nw) // 2
            y_off = (target_h - nh) // 2
            canvas[y_off:y_off+nh, x_off:x_off+nw] = frame
            ret2, buf = cv2.imencode('.jpg', canvas, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if not ret2:
                self._video_thumb_cache[path] = None
                return None
            data_uri = 'data:image/jpeg;base64,' + base64.b64encode(buf.tobytes()).decode()
            self._video_thumb_cache[path] = data_uri
            return data_uri
        except Exception as e:
            print(f'[VideoThumb] Error for {path}: {e}')
            self._video_thumb_cache[path] = None
            return None

    def reorder_playlist(self, from_index, to_index):
        """Move a track in the server-side playlist from from_index to to_index.
        Called after the JS drag-and-drop completes so playlist.json stays in sync."""
        with self._settings_lock:
            pl = self.settings.get('playlist', [])
            if (0 <= from_index < len(pl)) and (0 <= to_index < len(pl)):
                item = pl.pop(from_index)
                pl.insert(to_index, item)
                self.settings['playlist'] = pl
                self._save_settings_locked()
        return True

    def get_file_info(self, path):
        """Return detailed file information for context menu File Properties."""
        try:
            p = Path(path)
            if not p.exists():
                return None
            ext = p.suffix.lower()
            is_video = ext in {'.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv'}
            stat = p.stat()
            file_size = stat.st_size

            def fmt_size(b):
                for u in ['B', 'KB', 'MB', 'GB']:
                    if b < 1024:
                        return f"{b:.1f} {u}"
                    b /= 1024
                return f"{b:.1f} TB"

            info = {
                "name":       p.name,
                "path":       str(p.resolve()),
                "size":       fmt_size(file_size),
                "size_bytes": file_size,
                "ext":        ext.lstrip('.').upper(),
                "is_video":   is_video,
                "modified":   os.path.getmtime(str(p)),
            }

            if is_video:
                try:
                    import cv2
                    cap = cv2.VideoCapture(str(p))
                    w   = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                    h   = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                    fps = cap.get(cv2.CAP_PROP_FPS)
                    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
                    dur = int(frames / fps) if fps and fps > 0 else 0
                    cap.release()
                    info["resolution"]   = f"{w}x{h}" if w and h else "Unknown"
                    info["duration"]     = dur
                    info["duration_str"] = self._format_duration(dur)
                    info["fps"]          = round(fps, 2) if fps else 0
                except Exception:
                    info["resolution"]   = "Unknown"
                    info["duration"]     = 0
                    info["duration_str"] = "--:--"
                    info["fps"]          = 0
                    try:
                        af = mutagen.File(str(p))
                        if af and af.info:
                            info["duration"]     = int(af.info.length)
                            info["duration_str"] = self._format_duration(info["duration"])
                    except Exception:
                        pass
            else:
                meta = self._read_tags(str(p.resolve()), ext, False)
                info["duration"]     = meta.get('duration', 0)
                info["duration_str"] = self._format_duration(info["duration"])
                info["title"]        = meta.get('title') or p.stem
                info["artist"]       = meta.get('artist') or ''
                info["album"]        = meta.get('album')  or ''
                rg = self._read_replaygain(str(p.resolve()), ext)
                info["replaygain_db"] = rg if rg is not None else None

            return info
        except Exception as e:
            print(f"[MACAN] get_file_info error: {e}")
            return None

    # ─── TAG EDITOR ───────────────────────────────────────────────────────────

    def get_tags(self, path):
        """Read all editable tags from an audio file.
        Returns dict: {title, artist, album, albumartist, tracknumber, discnumber,
                       date, genre, comment, composer, lyrics} or None on error."""
        try:
            p = Path(path)
            if not p.exists():
                return None
            ext = p.suffix.lower()
            if ext in {'.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv'}:
                return None  # video — no tag editing

            tags = {
                "title": "", "artist": "", "album": "", "albumartist": "",
                "tracknumber": "", "discnumber": "", "date": "", "genre": "",
                "comment": "", "composer": "", "lyrics": ""
            }

            def _first(val):
                """Return first string value from a mutagen list/str."""
                if val is None:
                    return ""
                if isinstance(val, (list, tuple)):
                    return str(val[0]).strip() if val else ""
                return str(val).strip()

            if ext == '.mp3':
                try:
                    audio = ID3(path)
                except Exception:
                    audio = None
                if audio:
                    tags["title"]       = _first(audio.get("TIT2"))
                    tags["artist"]      = _first(audio.get("TPE1"))
                    tags["album"]       = _first(audio.get("TALB"))
                    tags["albumartist"] = _first(audio.get("TPE2"))
                    tags["tracknumber"] = _first(audio.get("TRCK"))
                    tags["discnumber"]  = _first(audio.get("TPOS"))
                    tags["date"]        = _first(audio.get("TDRC"))
                    tags["genre"]       = _first(audio.get("TCON"))
                    tags["composer"]    = _first(audio.get("TCOM"))
                    # Comment
                    for tag in audio.values():
                        if tag.FrameID == "COMM":
                            tags["comment"] = _first(getattr(tag, "text", ""))
                            break
                    # Lyrics (unsynchronized)
                    for tag in audio.values():
                        if tag.FrameID == "USLT":
                            tags["lyrics"] = getattr(tag, "text", "")
                            break

            elif ext == '.flac':
                audio = FLAC(path)
                tags["title"]       = _first(audio.get("title"))
                tags["artist"]      = _first(audio.get("artist"))
                tags["album"]       = _first(audio.get("album"))
                tags["albumartist"] = _first(audio.get("albumartist"))
                tags["tracknumber"] = _first(audio.get("tracknumber"))
                tags["discnumber"]  = _first(audio.get("discnumber"))
                tags["date"]        = _first(audio.get("date"))
                tags["genre"]       = _first(audio.get("genre"))
                tags["comment"]     = _first(audio.get("comment"))
                tags["composer"]    = _first(audio.get("composer"))
                tags["lyrics"]      = _first(audio.get("lyrics"))

            elif ext in ('.m4a', '.aac'):
                audio = MP4(path)
                def _mp4(key):
                    v = audio.tags.get(key) if audio.tags else None
                    return _first(v)
                tags["title"]       = _mp4("\xa9nam")
                tags["artist"]      = _mp4("\xa9ART")
                tags["album"]       = _mp4("\xa9alb")
                tags["albumartist"] = _mp4("aART")
                tags["date"]        = _mp4("\xa9day")
                tags["genre"]       = _mp4("\xa9gen")
                tags["comment"]     = _mp4("\xa9cmt")
                tags["composer"]    = _mp4("\xa9wrt")
                tags["lyrics"]      = _mp4("\xa9lyr")
                # Track number: MP4 stores as (number, total) tuple
                trk = audio.tags.get("trkn") if audio.tags else None
                if trk and isinstance(trk[0], (tuple, list)):
                    n, t = trk[0][0], trk[0][1]
                    tags["tracknumber"] = f"{n}/{t}" if t else str(n)
                disk = audio.tags.get("disk") if audio.tags else None
                if disk and isinstance(disk[0], (tuple, list)):
                    n, t = disk[0][0], disk[0][1]
                    tags["discnumber"] = f"{n}/{t}" if t else str(n)

            else:
                # Generic via mutagen easy tags (OGG, OPUS, WMA, WAV, etc.)
                audio = mutagen.File(path, easy=True)
                if audio is not None:
                    tags["title"]       = _first(audio.get("title"))
                    tags["artist"]      = _first(audio.get("artist"))
                    tags["album"]       = _first(audio.get("album"))
                    tags["albumartist"] = _first(audio.get("albumartist"))
                    tags["tracknumber"] = _first(audio.get("tracknumber"))
                    tags["discnumber"]  = _first(audio.get("discnumber"))
                    tags["date"]        = _first(audio.get("date"))
                    tags["genre"]       = _first(audio.get("genre"))
                    tags["comment"]     = _first(audio.get("comment"))
                    tags["composer"]    = _first(audio.get("composer"))
                    tags["lyrics"]      = _first(audio.get("lyrics"))

            return tags

        except Exception as e:
            print(f"[TagEditor] get_tags error for {path}: {e}")
            return None

    def save_tags(self, path, tags):
        """Write tag dict back to audio file using mutagen.
        tags: {title, artist, album, albumartist, tracknumber, discnumber,
               date, genre, comment, composer, lyrics}
        Returns {ok: bool, error: str|None, updated_track: dict|None}"""
        try:
            p = Path(path)
            if not p.exists():
                return {"ok": False, "error": "File not found", "updated_track": None}
            ext = p.suffix.lower()

            def _s(k):
                return (tags.get(k) or "").strip()

            if ext == '.mp3':
                from mutagen.id3 import (ID3, TIT2, TPE1, TALB, TPE2, TRCK,
                                          TPOS, TDRC, TCON, TCOM, COMM, USLT)
                try:
                    audio = ID3(path)
                except Exception:
                    audio = ID3()

                def _set(frame_cls, key, **kw):
                    val = _s(key)
                    if val:
                        audio[frame_cls.__name__] = frame_cls(encoding=3, text=val, **kw)
                    else:
                        audio.delall(frame_cls.__name__)

                _set(TIT2, "title")
                _set(TPE1, "artist")
                _set(TALB, "album")
                _set(TPE2, "albumartist")
                _set(TRCK, "tracknumber")
                _set(TPOS, "discnumber")
                _set(TDRC, "date")
                _set(TCON, "genre")
                _set(TCOM, "composer")

                comment = _s("comment")
                audio.delall("COMM")
                if comment:
                    audio["COMM::eng"] = COMM(encoding=3, lang="eng", desc="", text=comment)

                lyrics = _s("lyrics")
                audio.delall("USLT")
                if lyrics:
                    audio["USLT::eng"] = USLT(encoding=3, lang="eng", desc="", text=lyrics)

                audio.save(path)

            elif ext == '.flac':
                audio = FLAC(path)
                for field, tag_key in [
                    ("title","title"), ("artist","artist"), ("album","album"),
                    ("albumartist","albumartist"), ("tracknumber","tracknumber"),
                    ("discnumber","discnumber"), ("date","date"), ("genre","genre"),
                    ("comment","comment"), ("composer","composer"), ("lyrics","lyrics")
                ]:
                    val = _s(field)
                    if val:
                        audio[tag_key] = [val]
                    elif tag_key in audio:
                        del audio[tag_key]
                audio.save()

            elif ext in ('.m4a', '.aac'):
                audio = MP4(path)
                if audio.tags is None:
                    audio.add_tags()

                def _mp4set(mp4key, field):
                    val = _s(field)
                    if val:
                        audio.tags[mp4key] = [val]
                    elif mp4key in audio.tags:
                        del audio.tags[mp4key]

                _mp4set("\xa9nam", "title")
                _mp4set("\xa9ART", "artist")
                _mp4set("\xa9alb", "album")
                _mp4set("aART",   "albumartist")
                _mp4set("\xa9day", "date")
                _mp4set("\xa9gen", "genre")
                _mp4set("\xa9cmt", "comment")
                _mp4set("\xa9wrt", "composer")
                _mp4set("\xa9lyr", "lyrics")

                # Track/disc: parse "n/total" or just "n"
                for mp4key, field in [("trkn","tracknumber"), ("disk","discnumber")]:
                    val = _s(field)
                    if val:
                        parts = val.split("/")
                        try:
                            n = int(parts[0])
                            t = int(parts[1]) if len(parts) > 1 else 0
                            audio.tags[mp4key] = [(n, t)]
                        except ValueError:
                            pass
                    elif mp4key in audio.tags:
                        del audio.tags[mp4key]

                audio.save()

            else:
                # Generic easy tags (OGG, OPUS, WAV, WMA, etc.)
                audio = mutagen.File(path, easy=True)
                if audio is None:
                    return {"ok": False, "error": "Unsupported format", "updated_track": None}
                for field in ["title","artist","album","albumartist","tracknumber",
                              "discnumber","date","genre","comment","composer","lyrics"]:
                    val = _s(field)
                    if val:
                        audio[field] = [val]
                    elif field in audio:
                        del audio[field]
                audio.save()

            # Update in-memory playlist so the change is reflected immediately
            updated_track = None
            for track in self.playlist:
                if track.get("path") == str(p.resolve()):
                    if _s("title"):  track["name"]   = _s("title")
                    if _s("artist"): track["artist"] = _s("artist")
                    if _s("album"):  track["album"]  = _s("album")
                    updated_track = dict(track)
                    break
            self._save_playlist()

            print(f"[TagEditor] Saved tags for: {p.name}")
            return {"ok": True, "error": None, "updated_track": updated_track}

        except Exception as e:
            print(f"[TagEditor] save_tags error: {e}")
            return {"ok": False, "error": str(e), "updated_track": None}

    def save_settings(self, settings_dict):
        with self._settings_lock:
            self.settings.update(settings_dict)
            self._save_settings_locked()
        return True

    def get_settings(self):
        with self._settings_lock:
            return dict(self.settings)

    def save_app_state(self, state_dict):
        """Save full application state: current index, position, volume, EQ bands, etc.
        FIX: Wrapped in _settings_lock to prevent concurrent writes from parallel
        JS→Python bridge calls (e.g. periodic 10s saves overlapping with user actions)."""
        with self._settings_lock:
            self.settings['app_state'] = state_dict
            self._save_settings_locked()
        return True

    def get_app_state(self):
        """Retrieve last saved application state."""
        with self._settings_lock:
            return dict(self.settings.get('app_state', {}))

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

        # File size
        try:
            file_size = p.stat().st_size
        except Exception:
            file_size = 0

        # Pre-fetch cover art for audio files
        # Priority: 1) embedded tags  2) SQLite online art cache (from previous sessions)
        cover_art = None
        if not is_video:
            try:
                cover_art = self.get_cover_art(abs_path)
            except Exception:
                cover_art = None
            # If no embedded art, check the local SQLite art cache populated by
            # previous online fetches — this survives clear+reload cycles
            if not cover_art:
                try:
                    meta_for_cache = meta  # already read above
                    artist = meta_for_cache.get('artist') or ''
                    title  = meta_for_cache.get('title')  or p.stem
                    if artist:
                        cover_art = self._art_cache.get_cached(artist, title)
                except Exception:
                    cover_art = None

        # Pre-generate thumbnail for video files (cached in memory)
        video_thumb = None
        if is_video:
            try:
                video_thumb = self.get_video_thumbnail(abs_path)
            except Exception:
                video_thumb = None

        # Video resolution (width x height)
        video_resolution = None
        if is_video:
            try:
                import cv2
                cap = cv2.VideoCapture(abs_path)
                w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                cap.release()
                if w and h:
                    video_resolution = f"{w}x{h}"
            except Exception:
                video_resolution = None

        # ReplayGain tag reading for audio normalization
        replaygain_db = 0.0
        if not is_video:
            try:
                rg = self._read_replaygain(abs_path, ext)
                if rg is not None:
                    replaygain_db = rg
            except Exception:
                pass

        return {
            "name":             display_name,
            "artist":           artist,
            "album":            album,
            "path":             abs_path,
            "url":              p.resolve().as_uri(),
            "ext":              ext.lstrip('.').upper(),
            "is_video":         is_video,
            "duration":         duration,
            "duration_str":     self._format_duration(duration),
            "cover_art":        cover_art,
            "video_thumb":      video_thumb,
            "file_size":        file_size,
            "video_resolution": video_resolution,
            "replaygain_db":    replaygain_db,
        }

    def _read_replaygain(self, path, ext):
        """Read ReplayGain track gain tag from audio file. Returns dB float or None."""
        try:
            if ext == '.mp3':
                audio = ID3(path)
                # Standard TXXX:REPLAYGAIN_TRACK_GAIN
                for tag in audio.values():
                    if hasattr(tag, 'desc') and 'REPLAYGAIN_TRACK_GAIN' in tag.desc.upper():
                        val = str(tag.text[0]) if tag.text else ''
                        return float(val.split()[0])
            elif ext == '.flac':
                audio = FLAC(path)
                gain = audio.get('REPLAYGAIN_TRACK_GAIN', [None])[0]
                if gain:
                    return float(gain.split()[0])
            elif ext in ('.m4a', '.mp4'):
                audio = mutagen.File(path)
                if audio and audio.tags:
                    gain_bytes = audio.tags.get('----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN', [None])[0]
                    if gain_bytes:
                        return float(gain_bytes.decode('utf-8').split()[0])
            else:
                audio = mutagen.File(path)
                if audio and audio.tags:
                    for k, v in audio.tags.items():
                        if 'REPLAYGAIN_TRACK_GAIN' in k.upper():
                            val = str(v[0]) if isinstance(v, list) else str(v)
                            return float(val.split()[0])
        except Exception:
            pass
        return None

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
        """Get lyrics for a track.
        Priority: 1) Local .lrc file → 2) Local DB → 3) Online fetch
        Returns {content, is_synced} or None."""
        # Normalise inputs — use tag data as fallback
        if not artist or not title:
            p = Path(path)
            meta = self._read_tags(str(p.resolve()), p.suffix.lower(), False)
            artist = artist or meta.get('artist') or ''
            title  = title  or meta.get('title')  or p.stem

        # 1. Local .lrc file — same folder, same stem as the audio file
        #    e.g. /music/song.mp3 → /music/song.lrc
        try:
            lrc_path = Path(path).with_suffix('.lrc')
            if lrc_path.exists():
                lrc_text = lrc_path.read_text(encoding='utf-8', errors='replace').strip()
                if lrc_text:
                    print(f"[Lyrics] Found local .lrc: {lrc_path.name}")
                    # Detect if it has timestamp tags → synced
                    import re as _re
                    is_synced = bool(_re.search(r'\[\d+:\d+', lrc_text))
                    # Save to DB so future lookups skip disk read
                    if artist and title:
                        self._lyric_cache.save(artist, title, lrc_text, is_synced)
                    return {"content": lrc_text, "is_synced": is_synced}
        except Exception as e:
            print(f"[Lyrics] .lrc read error: {e}")

        if not artist or not title:
            return None

        # 2. Local DB
        cached = self._lyric_cache.get(artist, title)
        if cached:
            return cached

        # 3. Online fetch (synchronous — called from JS, runs in thread)
        result = self._lyric_cache.fetch_online(artist, title, duration)
        return result


    def get_cover_art_blob(self, path):
        """Return cover art as base64 PNG for use with navigator.mediaSession.
        Falls back to None if no art is available."""
        # Reuse the existing art cache logic
        try:
            art = self._art_cache.get_art(path)
            if art:
                return art  # already base64 data-url
        except Exception:
            pass
        return None

    def _get_duration(self, path):
        """Fallback duration reader using mutagen for any file type."""
        try:
            audio_file = mutagen.File(path)
            if audio_file and audio_file.info:
                return int(audio_file.info.length)
        except Exception:
            pass
        # For video files, try cv2
        try:
            import cv2
            cap = cv2.VideoCapture(path)
            fps    = cap.get(cv2.CAP_PROP_FPS)
            frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
            cap.release()
            if fps and fps > 0 and frames > 0:
                return int(frames / fps)
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
            loaded = None
            # FIX: Try main file first; fall back to .tmp if main is corrupt/missing
            # (handles crash-during-rename edge case)
            for candidate in [fpath, fpath + '.tmp']:
                if not os.path.exists(candidate):
                    continue
                try:
                    with open(candidate, 'r', encoding='utf-8') as f:
                        loaded = json.load(f)
                    break  # success
                except (json.JSONDecodeError, OSError) as e:
                    print(f"[MACAN] Could not load {candidate}: {e}")
            if loaded is not None:
                setattr(self, attr, loaded)
            else:
                setattr(self, attr, {} if attr == 'settings' else [])

    def _save_settings(self):
        """Public-safe wrapper — acquires lock then saves."""
        with self._settings_lock:
            self._save_settings_locked()

    def _save_settings_locked(self):
        """Must only be called while _settings_lock is held.
        FIX: Writes to a temp file then renames atomically to prevent
        truncated/corrupt settings.json if the process is killed mid-write."""
        try:
            fpath = os.path.join(self._get_app_data(), 'settings.json')
            os.makedirs(os.path.dirname(fpath), exist_ok=True)
            tmp_path = fpath + '.tmp'
            with open(tmp_path, 'w', encoding='utf-8') as f:
                json.dump(self.settings, f, indent=2)
            # Atomic rename — on POSIX this is guaranteed; on Windows it may
            # raise FileExistsError on older Python, so we remove first.
            try:
                os.replace(tmp_path, fpath)
            except OSError:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                raise
        except Exception as e:
            print(f"[MACAN] Save settings error: {e}")

    def _save_playlist(self):
        """FIX: Atomic write via temp file to prevent corruption on crash."""
        try:
            fpath = os.path.join(self._get_app_data(), 'playlist.json')
            os.makedirs(os.path.dirname(fpath), exist_ok=True)
            tmp_path = fpath + '.tmp'
            with open(tmp_path, 'w', encoding='utf-8') as f:
                json.dump(self.playlist, f, indent=2)
            try:
                os.replace(tmp_path, fpath)
            except OSError:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                raise
        except Exception as e:
            print(f"[MACAN] Save playlist error: {e}")


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
