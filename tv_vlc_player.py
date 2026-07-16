#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════
# MACAN TV — Standalone fullscreen TV player powered by libVLC
# Ported from Macan Vision's TV engine (macan_vision_build39.py) and
# adapted to run as an independent process launched by Macan Media
# Player's main.py (MacanMediaAPI.open_tv_player).
#
# WHY A SEPARATE PROCESS:
# Macan Media Player's UI is a pywebview/WebView2 page. WebView2 does not
# expose a native child HWND that libVLC can render video into, and Qt's
# QApplication must own the main thread of whatever process runs it — so
# it cannot simply be started on a background thread inside the pywebview
# process. Running it as its own process gives libVLC a real native
# window to draw into, which is what lets it play streams/codecs that
# the browser's <video> element rejects.
#
# Usage:
#   python tv_vlc_player.py [--source URL] [--db PATH]
# ═══════════════════════════════════════════════════════════════

import sys
import os
import re
import json
import shutil
import hashlib
import sqlite3
import argparse
import datetime
import subprocess
import random
from urllib.parse import urlparse

# ── libvlc.dll next to this script (Windows) ──────────────────────────────
if sys.platform.startswith('win'):
    _proj_root = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(_proj_root, 'libvlc.dll')):
        os.add_dll_directory(_proj_root)
        os.environ['PATH'] = _proj_root + os.pathsep + os.environ.get('PATH', '')

import requests
import vlc

from PySide6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout, QPushButton,
    QListWidget, QListWidgetItem, QLineEdit, QLabel, QSlider, QComboBox,
    QFileDialog, QMenu, QMessageBox, QFrame, QTabWidget, QSizePolicy
)
from PySide6.QtCore import Qt, QTimer, QSettings, Signal, Slot, QObject, QSize
from PySide6.QtGui import QColor, QCursor, QDesktopServices, QFont
from PySide6.QtCore import QUrl


# ═══════════════════════════════════════════════════════════════
# TV SOURCES — kept identical to index.html's #tv-source-select
# ═══════════════════════════════════════════════════════════════
TV_SOURCES = {
    "Github (ID)":       "https://iptv-org.github.io/iptv/countries/id.m3u",
    "Github (Global)":   "https://iptv-org.github.io/iptv/index.m3u",
    "Vizio TV":          "https://www.apsattv.com/vizio.m3u",
    "Local Now":         "https://www.apsattv.com/localnow.m3u",
    "LG Channels":       "https://www.apsattv.com/lg.m3u",
    "Tablo":             "https://www.apsattv.com/tablo.m3u",
    "Xiaomi":            "https://www.apsattv.com/xiaomi.m3u",
    "Fire TV":           "https://www.apsattv.com/firetv.m3u",
    "Xumo":              "https://www.apsattv.com/xumo.m3u",
    "The Roku Channel":  "https://www.apsattv.com/rok.m3u",
    "Distro":            "https://www.apsattv.com/distro.m3u",
    "TCL TV Plus":       "https://www.apsattv.com/tclplus.m3u",
}
DEFAULT_SOURCE = list(TV_SOURCES.values())[0]


# ═══════════════════════════════════════════════════════════════
# CHANNEL CACHE (SQLite) — same design as Macan Vision's TvChannelCache
# ═══════════════════════════════════════════════════════════════
class TvChannelCache:
    _TABLE = "tv_channel_cache"

    def __init__(self, db_path: str):
        self._path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._ensure_table()

    def _connect(self):
        conn = sqlite3.connect(self._path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def _key(self, url: str) -> str:
        return hashlib.sha256(url.encode()).hexdigest()

    def _ensure_table(self):
        with self._connect() as conn:
            conn.execute(f"""
                CREATE TABLE IF NOT EXISTS {self._TABLE} (
                    source_key  TEXT NOT NULL,
                    name        TEXT NOT NULL,
                    url         TEXT NOT NULL,
                    fetched_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
                )
            """)
            conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{self._TABLE}_key ON {self._TABLE}(source_key)")

    def is_empty(self, source_url: str) -> bool:
        key = self._key(source_url)
        with self._connect() as conn:
            row = conn.execute(f"SELECT COUNT(*) FROM {self._TABLE} WHERE source_key=?", (key,)).fetchone()
            return row[0] == 0

    def load(self, source_url: str):
        key = self._key(source_url)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT name, url FROM {self._TABLE} WHERE source_key=? ORDER BY name", (key,)
            ).fetchall()
        return [{"name": r["name"], "url": r["url"]} for r in rows]

    def save(self, source_url: str, channels: list):
        key = self._key(source_url)
        rows = [(key, c["name"], c["url"]) for c in channels if c.get("name") and c.get("url")]
        with self._connect() as conn:
            conn.execute(f"DELETE FROM {self._TABLE} WHERE source_key=?", (key,))
            conn.executemany(f"INSERT INTO {self._TABLE}(source_key,name,url) VALUES(?,?,?)", rows)

    def invalidate(self, source_url: str):
        key = self._key(source_url)
        with self._connect() as conn:
            conn.execute(f"DELETE FROM {self._TABLE} WHERE source_key=?", (key,))


def parse_m3u_content(content: str):
    """Same parsing rule as radio-tv.js parseM3U() / Macan Vision parse_m3u_content()."""
    channels = []
    lines = content.strip().split('\n')
    for i, line in enumerate(lines):
        line = line.strip()
        if line.startswith('#EXTINF:'):
            try:
                name = line.split(',')[-1].strip()
                if i + 1 < len(lines) and lines[i + 1].strip().startswith(('http', 'rtsp', 'rtmp')):
                    url = lines[i + 1].strip()
                    if name and url:
                        channels.append({'name': name, 'url': url})
            except IndexError:
                continue
    return channels


# ═══════════════════════════════════════════════════════════════
# BACKGROUND FETCH WORKER (Qt-thread based, no extra deps)
# ═══════════════════════════════════════════════════════════════
class _FetchSignals(QObject):
    done  = Signal(object)
    error = Signal(str)


class _FetchThread(QObject):
    """Lightweight one-shot fetch runner using QTimer.singleShot(0, ...) +
    Python's own threading, avoiding a hard dependency on QThreadPool quirks."""
    def __init__(self, fn, *args, **kwargs):
        super().__init__()
        self.fn, self.args, self.kwargs = fn, args, kwargs
        self.signals = _FetchSignals()

    def start(self):
        import threading
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            result = self.fn(*self.args, **self.kwargs)
        except Exception as e:
            self.signals.error.emit(str(e))
        else:
            self.signals.done.emit(result)


# ═══════════════════════════════════════════════════════════════
# CHANNEL SWITCHER OVERLAY (right-side slide-in panel, autohide)
# Mirrors radio-tv.js's #tv-ch-switcher behaviour.
# ═══════════════════════════════════════════════════════════════
class ChannelSwitcher(QFrame):
    channelChosen = Signal(dict)
    favToggled    = Signal(str)

    def __init__(self, parent, favorites_getter):
        super().__init__(parent)
        self._favorites_getter = favorites_getter
        self._all_channels = []
        self._query = ''
        self.setObjectName("chSwitcher")
        self.setFixedWidth(300)
        self.setStyleSheet("""
            #chSwitcher {
                background-color: rgba(10,10,10,235);
                border-left: 1px solid rgba(232,255,0,0.18);
            }
            QLineEdit {
                background-color: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 4px; color: #eee; padding: 6px 8px;
            }
            QListWidget {
                background: transparent; border: none; color: #ddd;
                font-size: 12px;
            }
            QListWidget::item { padding: 7px 6px; border-radius: 3px; }
            QListWidget::item:selected { background-color: rgba(232,255,0,0.16); color: #E8FF00; }
            QTabBar::tab { padding: 5px 10px; color: #aaa; }
            QTabBar::tab:selected { color: #E8FF00; }
        """)

        v = QVBoxLayout(self)
        v.setContentsMargins(10, 10, 10, 10)
        v.setSpacing(8)

        title = QLabel("CHANNELS")
        title.setStyleSheet("color:#E8FF00; font-weight:700; letter-spacing:2px; font-size:12px;")
        self.count_lbl = QLabel("")
        self.count_lbl.setStyleSheet("color:#888; font-size:10px;")
        top_row = QHBoxLayout()
        top_row.addWidget(title)
        top_row.addStretch()
        top_row.addWidget(self.count_lbl)
        v.addLayout(top_row)

        self.search = QLineEdit()
        self.search.setPlaceholderText("Filter…")
        self.search.textChanged.connect(self._on_search)
        v.addWidget(self.search)

        self.tabs = QTabWidget()
        self.list_all = QListWidget()
        self.list_fav = QListWidget()
        self.tabs.addTab(self.list_all, "All")
        self.tabs.addTab(self.list_fav, "★ Favorites")
        v.addWidget(self.tabs, 1)

        for lw in (self.list_all, self.list_fav):
            lw.itemDoubleClicked.connect(self._on_item_activated)
            lw.setContextMenuPolicy(Qt.CustomContextMenu)
            lw.customContextMenuRequested.connect(lambda pos, w=lw: self._ctx_menu(w, pos))

        hint = QLabel("Double-click to play · Right-click to favorite\n← → switch channel · Esc close")
        hint.setStyleSheet("color:#555; font-size:9px;")
        hint.setWordWrap(True)
        v.addWidget(hint)

    def set_channels(self, channels):
        self._all_channels = channels
        self._render()

    def _on_search(self, text):
        self._query = text.lower()
        self._render()

    def _render(self):
        favs = self._favorites_getter()
        q = self._query
        filtered = [c for c in self._all_channels if q in c['name'].lower()] if q else self._all_channels
        self.count_lbl.setText(f"{len(filtered)}/{len(self._all_channels)}")

        self.list_all.clear()
        for idx, ch in enumerate(filtered, 1):
            star = "★ " if ch['name'] in favs else ""
            item = QListWidgetItem(f"{idx:>3}. {star}{ch['name']}")
            item.setData(Qt.UserRole, ch)
            if ch['name'] in favs:
                item.setForeground(QColor("#FFD700"))
            self.list_all.addItem(item)

        self.list_fav.clear()
        fav_channels = [c for c in filtered if c['name'] in favs]
        for idx, ch in enumerate(fav_channels, 1):
            item = QListWidgetItem(f"{idx:>3}. ★ {ch['name']}")
            item.setData(Qt.UserRole, ch)
            item.setForeground(QColor("#FFD700"))
            self.list_fav.addItem(item)

    def _on_item_activated(self, item):
        ch = item.data(Qt.UserRole)
        if ch:
            self.channelChosen.emit(ch)

    def _ctx_menu(self, list_widget, pos):
        item = list_widget.itemAt(pos)
        if not item:
            return
        ch = item.data(Qt.UserRole)
        favs = self._favorites_getter()
        is_fav = ch['name'] in favs
        menu = QMenu(self)
        act_play = menu.addAction("▶  Play")
        act_fav  = menu.addAction("★  Remove from Favorites" if is_fav else "☆  Add to Favorites")
        action = menu.exec(list_widget.viewport().mapToGlobal(pos))
        if action == act_play:
            self.channelChosen.emit(ch)
        elif action == act_fav:
            self.favToggled.emit(ch['name'])
            self._render()

    def current_list_and_index(self, active_name):
        """Return (ordered channel list currently shown, index of active channel)."""
        lw = self.list_fav if self.tabs.currentIndex() == 1 else self.list_all
        items = [lw.item(i).data(Qt.UserRole) for i in range(lw.count())]
        idx = next((i for i, c in enumerate(items) if c['name'] == active_name), -1)
        return items, idx


# ═══════════════════════════════════════════════════════════════
# MAIN TV WINDOW
# ═══════════════════════════════════════════════════════════════
class TvVlcWindow(QWidget):
    def __init__(self, db_path: str, initial_source: str = None):
        super().__init__()
        self.setWindowTitle("Macan TV")
        self.setStyleSheet("background-color:#000;")
        self.setAttribute(Qt.WA_DeleteOnClose)

        self.settings = QSettings("MacanAngkasa", "MacanTvPlayer")
        self.cache = TvChannelCache(db_path)

        self.channels = []
        self.current_channel = None
        self.current_source = initial_source or self.settings.value("last_source", DEFAULT_SOURCE)
        self._favorites = set(self.settings.value("favorites", []) or [])
        self._switcher_visible = False
        self._hide_timer = QTimer(self)
        self._hide_timer.setSingleShot(True)
        self._hide_timer.timeout.connect(self._hide_switcher)

        # ── libVLC ──────────────────────────────────────────────────────
        vlc_args = ["--no-xlib"] if not sys.platform.startswith('win') else []
        self.vlc_instance = vlc.Instance(*vlc_args)
        self.vlc_player = self.vlc_instance.media_player_new()
        self._current_stream_url = None

        events = self.vlc_player.event_manager()
        events.event_attach(vlc.EventType.MediaPlayerEncounteredError, self._vlc_error_cb)
        events.event_attach(vlc.EventType.MediaPlayerPlaying, self._vlc_playing_cb)

        # ── layout ──────────────────────────────────────────────────────
        self.video_frame = QFrame(self)
        self.video_frame.setStyleSheet("background-color:black;")

        root = QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        root.addWidget(self.video_frame, 1)

        self.switcher = ChannelSwitcher(self, lambda: self._favorites)
        self.switcher.channelChosen.connect(self._play_channel)
        self.switcher.favToggled.connect(self._toggle_favorite)
        self.switcher.hide()

        # top bar (always visible, not auto-hidden)
        self.top_bar = QWidget(self)
        self.top_bar.setStyleSheet("background: rgba(0,0,0,150);")
        tb = QHBoxLayout(self.top_bar)
        tb.setContentsMargins(16, 8, 16, 8)

        self.title_lbl = QLabel("— SELECT A CHANNEL —")
        self.title_lbl.setStyleSheet("color:#fff; font-size:13px; font-weight:600; letter-spacing:1px;")

        self.source_combo = QComboBox()
        self.source_combo.addItems(TV_SOURCES.keys())
        for name, url in TV_SOURCES.items():
            if url == self.current_source:
                self.source_combo.setCurrentText(name)
                break
        self.source_combo.currentTextChanged.connect(self._on_source_changed)
        self.source_combo.setFixedWidth(160)

        self.btn_m3u = QPushButton("M3U")
        self.btn_m3u.clicked.connect(self._load_local_m3u)

        self.btn_refresh = QPushButton("⟳")
        self.btn_refresh.setFixedWidth(34)
        self.btn_refresh.clicked.connect(lambda: self._fetch_source(self.current_source, force=True))

        self.btn_record = QPushButton("⏺ REC")
        self.btn_record.clicked.connect(self._toggle_recording)
        self._is_recording = False
        self._record_process = None
        self._record_filepath = None

        self.btn_close = QPushButton("✕ CLOSE")
        self.btn_close.setStyleSheet("QPushButton{color:#ff2d55;} QPushButton:hover{background:#ff2d55; color:#fff;}")
        self.btn_close.clicked.connect(self.close)

        for w in (self.title_lbl,):
            tb.addWidget(w)
        tb.addStretch()
        tb.addWidget(self.source_combo)
        tb.addWidget(self.btn_m3u)
        tb.addWidget(self.btn_refresh)
        tb.addWidget(self.btn_record)
        tb.addWidget(self.btn_close)

        # bottom custom-url bar (always visible, small)
        self.url_bar = QWidget(self)
        self.url_bar.setStyleSheet("background: rgba(0,0,0,150);")
        ub = QHBoxLayout(self.url_bar)
        ub.setContentsMargins(16, 6, 16, 8)
        self.url_input = QLineEdit()
        self.url_input.setPlaceholderText("Custom stream / .m3u URL — press Enter to play")
        self.url_input.returnPressed.connect(self._play_from_url_input)
        self.vol_slider = QSlider(Qt.Horizontal)
        self.vol_slider.setRange(0, 100)
        self.vol_slider.setValue(int(self.settings.value("volume", 80)))
        self.vol_slider.setFixedWidth(120)
        self.vol_slider.valueChanged.connect(self._on_volume_changed)
        ub.addWidget(self.url_input, 1)
        ub.addWidget(QLabel("Vol"))
        ub.addWidget(self.vol_slider)

        for style_target in (self.title_lbl,):
            pass

        # Make top_bar/url_bar float over the video frame
        self.top_bar.setParent(self)
        self.url_bar.setParent(self)

        self.setMouseTracking(True)
        self.video_frame.setMouseTracking(True)

        # ── Cursor polling (NOT Qt mouse events) ───────────────────────
        # Once libVLC is bound to video_frame's HWND, it creates its own
        # native child window there and takes over mouse input directly at
        # the OS level — those events never reach Qt's event loop, so
        # mouseMoveEvent()/eventFilter() never fire while the cursor is over
        # the playing video. QCursor.pos() reads the OS cursor position
        # directly regardless of which native window currently owns mouse
        # input, so a timer-based poll is what actually works here.
        self._last_cursor_pos = QCursor.pos()
        self._poll_timer = QTimer(self)
        self._poll_timer.setInterval(120)
        self._poll_timer.timeout.connect(self._poll_mouse_position)
        self._poll_timer.start()

        self.vlc_player.audio_set_volume(self.vol_slider.value())

        # go fullscreen immediately
        self.showFullScreen()
        QTimer.singleShot(0, self._bind_hwnd)
        QTimer.singleShot(0, self._reposition_overlays)

        self._fetch_source(self.current_source, force=False)

    # ── window plumbing ───────────────────────────────────────────────
    def _bind_hwnd(self):
        wid = int(self.video_frame.winId())
        if sys.platform.startswith('win'):
            self.vlc_player.set_hwnd(wid)
        elif sys.platform == 'darwin':
            self.vlc_player.set_nsobject(wid)
        else:
            self.vlc_player.set_xwindow(wid)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._reposition_overlays()

    def _reposition_overlays(self):
        w, h = self.width(), self.height()
        self.top_bar.setGeometry(0, 0, w, 48)
        self.url_bar.setGeometry(0, h - 44, w, 44)
        sw_w = self.switcher.width()
        self.switcher.setGeometry(w - sw_w, 48, sw_w, h - 48)

    def mouseMoveEvent(self, event):
        # Kept as a cheap extra trigger for the parts of the window that ARE
        # real Qt widgets (top_bar, url_bar, switcher itself) — but the video
        # area itself relies on _poll_mouse_position() below.
        self._show_switcher_briefly()
        super().mouseMoveEvent(event)

    def _poll_mouse_position(self):
        """Runs every 120ms. Reads the OS cursor position directly (bypasses
        Qt's event system entirely) so movement is detected even while the
        cursor sits over libVLC's native video surface."""
        if not self.isVisible():
            return

        pos = QCursor.pos()
        moved = pos != self._last_cursor_pos
        self._last_cursor_pos = pos

        # Keep the panel open (and reset its auto-hide countdown) the whole
        # time the cursor rests inside it, even if it isn't actively moving —
        # mirrors the mouseenter/mouseleave pause behaviour of the original
        # web-based channel switcher.
        hovering_switcher = self._switcher_visible and self._point_in_switcher(pos)

        if moved or hovering_switcher:
            self._show_switcher_briefly()

    def _point_in_switcher(self, global_pos):
        if not self.switcher.isVisible():
            return False
        top_left = self.switcher.mapToGlobal(self.switcher.rect().topLeft())
        rect = self.switcher.rect()
        rect.moveTopLeft(top_left)
        return rect.contains(global_pos)

    def _show_switcher_briefly(self):
        if not self._switcher_visible:
            self.switcher.show()
            self.switcher.raise_()
            self._switcher_visible = True
        self._hide_timer.start(3500)

    def _hide_switcher(self):
        self.switcher.hide()
        self._switcher_visible = False

    def keyPressEvent(self, event):
        key = event.key()
        if key == Qt.Key_Escape:
            if self._switcher_visible:
                self._hide_switcher()
            else:
                self.close()
            return
        if key == Qt.Key_Right:
            self._navigate(1); return
        if key == Qt.Key_Left:
            self._navigate(-1); return
        if key == Qt.Key_Up:
            self.vol_slider.setValue(min(100, self.vol_slider.value() + 5)); return
        if key == Qt.Key_Down:
            self.vol_slider.setValue(max(0, self.vol_slider.value() - 5)); return
        if key == Qt.Key_Space:
            self._toggle_play_pause(); return
        super().keyPressEvent(event)

    def closeEvent(self, event):
        if hasattr(self, '_poll_timer'):
            self._poll_timer.stop()
        if self._is_recording:
            self._stop_recording()
        try:
            self.settings.setValue("volume", self.vol_slider.value())
            self.settings.setValue("last_source", self.current_source)
            self.settings.setValue("favorites", list(self._favorites))
        except Exception:
            pass
        try:
            self.vlc_player.stop()
            self.vlc_player.release()
            self.vlc_instance.release()
        except Exception:
            pass
        event.accept()
        QApplication.quit()

    # ── channel fetch / cache ──────────────────────────────────────────
    def _on_source_changed(self, name):
        url = TV_SOURCES.get(name)
        if url:
            self.current_source = url
            self._fetch_source(url, force=False)

    def _fetch_source(self, url, force=False):
        self.title_lbl.setText("LOADING CHANNELS…")
        if not force and not self.cache.is_empty(url):
            worker = _FetchThread(self.cache.load, url)
            worker.signals.done.connect(lambda ch: self._on_channels_ready(ch, url))
            worker.signals.error.connect(self._on_fetch_error)
            worker.start()
            self._worker_ref = worker
        else:
            if force:
                self.cache.invalidate(url)
            worker = _FetchThread(self._download_m3u, url)
            worker.signals.done.connect(lambda ch: self._on_channels_ready(ch, url, persist=True))
            worker.signals.error.connect(self._on_fetch_error)
            worker.start()
            self._worker_ref = worker

    def _download_m3u(self, url):
        resp = requests.get(url, timeout=15, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        })
        resp.raise_for_status()
        channels = parse_m3u_content(resp.text)
        if not channels:
            raise ValueError("No valid channels found in this source.")
        channels.sort(key=lambda c: c['name'])
        return channels

    @Slot(object)
    def _on_channels_ready(self, channels, url, persist=False):
        if not channels:
            self.title_lbl.setText("NO CHANNELS FOUND")
            return
        self.channels = channels
        if persist:
            self.cache.save(url, channels)
        self.switcher.set_channels(channels)
        self.title_lbl.setText(f"{len(channels)} CHANNELS LOADED — move mouse to browse")

    def _on_fetch_error(self, msg):
        self.title_lbl.setText(f"FAILED TO LOAD: {msg}")

    def _load_local_m3u(self):
        path, _ = QFileDialog.getOpenFileName(self, "Open M3U File", "", "Playlist Files (*.m3u *.m3u8)")
        if not path:
            return
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            channels = parse_m3u_content(content)
            if not channels:
                QMessageBox.warning(self, "M3U", "No valid channels found in this file.")
                return
            channels.sort(key=lambda c: c['name'])
            self.channels = channels
            self.switcher.set_channels(channels)
            self.title_lbl.setText(f"{len(channels)} CHANNELS LOADED (local file)")
        except Exception as e:
            QMessageBox.critical(self, "M3U", f"Failed to read file:\n{e}")

    # ── playback ────────────────────────────────────────────────────
    def _play_channel(self, channel: dict):
        self.current_channel = channel
        self._play_stream(channel.get('url'), channel.get('name'))

    def _play_from_url_input(self):
        url = self.url_input.text().strip()
        if not url:
            return
        if url.lower().endswith(('.m3u', '.m3u8')):
            self.current_source = url
            self._fetch_source(url, force=True)
            self.url_input.clear()
            return
        try:
            hostname = urlparse(url).hostname or "Custom URL"
        except Exception:
            hostname = "Custom URL"
        name = f"{hostname} (Custom)"
        self.current_channel = {'name': name, 'url': url}
        self._play_stream(url, name)
        self.url_input.clear()

    def _play_stream(self, url, name):
        if not url:
            return
        media = self.vlc_instance.media_new(url)
        media.add_option(':network-caching=3000')
        media.add_option(':live-caching=3000')
        self.vlc_player.set_media(media)
        self.vlc_player.play()
        self._current_stream_url = url
        self.title_lbl.setText(f"● LIVE — {name}")

    def _toggle_play_pause(self):
        if self.vlc_player.is_playing():
            self.vlc_player.pause()
        elif self.current_channel:
            self.vlc_player.play()

    def _navigate(self, direction):
        items, idx = self.switcher.current_list_and_index(
            self.current_channel['name'] if self.current_channel else None
        )
        if not items:
            return
        new_idx = (idx + direction) % len(items) if idx >= 0 else 0
        self._play_channel(items[new_idx])

    def _on_volume_changed(self, val):
        self.vlc_player.audio_set_volume(val)

    def _toggle_favorite(self, name):
        if name in self._favorites:
            self._favorites.discard(name)
        else:
            self._favorites.add(name)
        self.settings.setValue("favorites", list(self._favorites))

    # ── VLC callbacks (auto-skip on error, like Macan Vision) ─────────
    def _vlc_error_cb(self, event):
        QTimer.singleShot(0, lambda: self._navigate(1))

    def _vlc_playing_cb(self, event):
        pass

    # ── recording (ffmpeg passthrough, same approach as Macan Vision) ─
    def _find_ffmpeg(self):
        base = os.path.dirname(os.path.abspath(__file__))
        for candidate in ("ffmpeg.exe", "ffmpeg"):
            full = os.path.join(base, candidate)
            if os.path.exists(full):
                return full
        return shutil.which("ffmpeg")

    def _toggle_recording(self):
        if self._is_recording:
            self._stop_recording()
        else:
            self._start_recording()

    def _start_recording(self):
        if not self._current_stream_url:
            QMessageBox.warning(self, "Record", "No stream is currently playing.")
            return
        ffmpeg = self._find_ffmpeg()
        if not ffmpeg:
            QMessageBox.warning(self, "Record",
                                 "ffmpeg not found. Place ffmpeg.exe next to the app or add it to PATH.")
            return
        videos_dir = os.path.join(os.path.expanduser("~"), "Videos", "MacanTV_Recordings")
        os.makedirs(videos_dir, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        name = "".join(c if (c.isalnum() or c in " _-") else "_"
                       for c in (self.current_channel or {}).get('name', 'stream'))[:40]
        out_path = os.path.join(videos_dir, f"{name}_{ts}.ts")

        cmd = [ffmpeg, "-y",
               "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
               "-i", self._current_stream_url, "-c", "copy", out_path]
        try:
            si, cf = None, 0
            if sys.platform == 'win32':
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                cf = subprocess.CREATE_NO_WINDOW
            self._record_process = subprocess.Popen(
                cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, startupinfo=si, creationflags=cf)
            self._record_filepath = out_path
            self._is_recording = True
            self.btn_record.setText("⏹ STOP")
            self.btn_record.setStyleSheet("background:#ff2d55; color:#fff;")
        except Exception as e:
            QMessageBox.critical(self, "Record", f"Failed to start ffmpeg:\n{e}")

    def _stop_recording(self):
        if self._record_process and self._record_process.poll() is None:
            self._record_process.terminate()
            try:
                self._record_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._record_process.kill()
        self._record_process = None
        self._is_recording = False
        self.btn_record.setText("⏺ REC")
        self.btn_record.setStyleSheet("")
        if self._record_filepath:
            path = self._record_filepath
            self._record_filepath = None
            reply = QMessageBox.question(
                self, "Recording Saved",
                f"Saved to:\n{path}\n\nOpen the folder?",
                QMessageBox.Yes | QMessageBox.No
            )
            if reply == QMessageBox.Yes:
                QDesktopServices.openUrl(QUrl.fromLocalFile(os.path.dirname(path)))


def main():
    parser = argparse.ArgumentParser(description="Macan TV — libVLC fullscreen TV player")
    parser.add_argument('--source', default=None, help='Initial M3U source URL')
    parser.add_argument('--db', default=None, help='Path to the channel-cache SQLite database')
    args = parser.parse_args()

    db_path = args.db or os.path.join(
        os.getenv('LOCALAPPDATA', os.path.expanduser('~')),
        'MacanMediaPlayer', 'tv_channels.db'
    )

    app = QApplication(sys.argv)
    app.setApplicationName("Macan TV")
    window = TvVlcWindow(db_path=db_path, initial_source=args.source)
    window.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
