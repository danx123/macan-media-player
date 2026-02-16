import os
import sys
import json
import base64
import threading
import http.server
import socketserver
import secrets
import mimetypes
import urllib.parse
from pathlib import Path
import webview

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


_media_server = _MediaServer()


# ─── MAIN API CLASS ───────────────────────────────────────────────────────────

class MacanMediaAPI:
    """Bridge Class: Methods callable from JavaScript"""

    def __init__(self):
        self._window = None
        self.playlist = []
        self.settings = {}
        self._load_settings()

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
        file_types = (
            'Media Files (*.mp3;*.mp4;*.wav;*.flac;*.ogg;*.aac;*.mkv;*.avi;*.webm;*.m4a;*.opus)',
            'Audio (*.mp3;*.wav;*.flac;*.ogg;*.aac;*.m4a;*.opus)',
            'Video (*.mp4;*.mkv;*.avi;*.webm)',
            'All files (*.*)'
        )
        result = self._open_dialog(allow_multiple=True, file_types=file_types)
        if result:
            return [self._build_track_meta(f) for f in result]
        return []

    def browse_folder(self):
        result = self._folder_dialog()
        if result and len(result) > 0:
            return self._scan_media_folder(result[0])
        return []

    def get_file_url(self, path):
        """Return an http:// URL for a local media file, served via MediaServer.
        This bypasses EdgeWebView2's file:// CORS block on Windows."""
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

    def add_tracks(self, tracks):
        for track in tracks:
            if not any(t['path'] == track['path'] for t in self.playlist):
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
        try:
            from mutagen.id3 import ID3
            audio = ID3(path)
            for tag in audio.values():
                if hasattr(tag, 'data') and tag.data:
                    encoded = base64.b64encode(tag.data).decode('utf-8')
                    return f"data:image/jpeg;base64,{encoded}"
        except Exception:
            pass
        try:
            import mutagen
            audio = mutagen.File(path)
            if audio and hasattr(audio, 'pictures') and audio.pictures:
                pic = audio.pictures[0]
                encoded = base64.b64encode(pic.data).decode('utf-8')
                return f"data:{pic.mime};base64,{encoded}"
        except Exception:
            pass
        return None

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
        duration = self._get_duration(filepath)
        abs_path = str(p.resolve())
        # url starts as file:// but is overridden to http:// by get_file_url() at play time
        return {
            "name":         p.stem,
            "path":         abs_path,
            "url":          p.resolve().as_uri(),
            "ext":          ext.lstrip('.').upper(),
            "is_video":     is_video,
            "duration":     duration,
            "duration_str": self._format_duration(duration)
        }

    def _scan_media_folder(self, folder):
        extensions = {'.mp3', '.mp4', '.wav', '.flac', '.ogg', '.aac',
                      '.mkv', '.avi', '.webm', '.m4a', '.opus', '.mov', '.wmv'}
        tracks = []
        for root, dirs, files in os.walk(folder):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for f in sorted(files):
                if Path(f).suffix.lower() in extensions:
                    tracks.append(self._build_track_meta(os.path.join(root, f)))
        return tracks

    def _get_duration(self, path):
        try:
            import mutagen
            audio = mutagen.File(path)
            if audio and audio.info:
                return int(audio.info.length)
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