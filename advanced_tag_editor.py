"""
Advanced Tag Editor — Enterprise Edition v4.5.0
© Macan Angkasa. All Rights Reserved.

New in v4.1.1:
  • Batch rename with template engine
  • Undo / Redo stack (per-file)
  • Export metadata → CSV  |  Import metadata ← CSV
  • Tag-completeness badge (colour-coded rows)
  • Drag-and-drop files onto the table
  • Duplicate detector
  • Missing-tag filter
  • Statistics dashboard (tab)
  • Audio analysis: bitrate, sample-rate, BPM (media_engine)
  • QDockWidget panels: Activity Log, File Queue
  • Ribbon-style labelled toolbar sections
  • Column-layout presets
  • Keyboard shortcuts overlay (F1)
"""

import sys
import os
import csv
import json
import copy
import datetime
import requests
import traceback

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QSplitter, QTreeView, QFileSystemModel, QFormLayout, QLineEdit,
    QPushButton, QLabel, QToolBar, QMessageBox, QFileDialog, QGroupBox,
    QStyle, QTabWidget, QTextEdit, QStatusBar, QTableWidget, QTableWidgetItem,
    QAbstractItemView, QHeaderView, QMenu, QSlider, QDialog, QProgressBar,
    QDialogButtonBox, QDockWidget, QListWidget, QListWidgetItem, QComboBox,
    QFrame, QScrollArea, QSizePolicy, QCheckBox, QSpinBox
)
from PySide6.QtGui import QAction, QPixmap, QIcon, QPalette, QColor, QFont, QDragEnterEvent, QDropEvent
from PySide6.QtCore import Qt, QDir, QSize, QSettings, QThread, Signal, QMimeData, QTimer

import mutagen
from mutagen.id3 import ID3, APIC, USLT
from mutagen.flac import FLAC, Picture as FLACPicture
from mutagen.mp4 import MP4, MP4Cover

import subprocess

# media_engine (Rust): native module used for BOTH BPM detection and
# playback preview (see PlayerEngine below) -- gantiin subprocess
# `ffmpeg`/tempfile-WAV decode + pure-Python autocorrelation lama, DAN
# QMediaPlayer/QAudioOutput dari QtMultimedia sekaligus. Semua decode
# audio sekarang jalan di proses yang sama (bukan spawn ffmpeg.exe lewat
# subprocess lagi), jadi gak perlu ffmpeg terinstal terpisah di PATH.
try:
    import media_engine
    _MEDIA_ENGINE = True
except ImportError:
    _MEDIA_ENGINE = False

# Nama lama dipertahankan sebagai alias (dipakai di beberapa tempat UI di
# bawah buat nge-disable tombol/nampilin tooltip) supaya diff-nya minimal.
FFMPEG_AVAILABLE = _MEDIA_ENGINE


def _detect_bpm_media_engine(file_path, sample_rate=44100):
    """
    Detect BPM via media_engine: decode full-track PCM in-process
    (media_engine.decode_audio), then run the same energy-autocorrelation
    beat tracker used elsewhere in the suite (media_engine.detect_bpm,
    implemented in Rust -- no per-sample Python loop / temp WAV file
    anymore). Returns float BPM or raises RuntimeError.
    """
    if not _MEDIA_ENGINE:
        raise RuntimeError("media_engine module not found/built.")
    try:
        y = media_engine.decode_audio(file_path, sample_rate)
    except Exception as e:
        raise RuntimeError(f"media_engine decode error: {e}")
    if y is None or len(y) == 0:
        raise RuntimeError("media_engine could not decode this file (unsupported format?).")
    try:
        bpm = media_engine.detect_bpm(y, sample_rate)
    except Exception as e:
        raise RuntimeError(f"media_engine BPM error: {e}")
    if not bpm or bpm <= 0:
        raise RuntimeError("Audio too short or too quiet for BPM analysis.")
    return round(float(bpm), 1)


# ══════════════════════════════════════════════════════════════════════════════
#  Helper: colour for tag completeness
# ══════════════════════════════════════════════════════════════════════════════
def completeness_color(title, artist, album, year, genre):
    filled = sum(bool(x) for x in [title, artist, album, year, genre])
    if filled == 5:
        return QColor(39, 174, 96)   # green
    elif filled >= 3:
        return QColor(243, 156, 18)  # amber
    else:
        return QColor(192, 57, 43)   # red


# ══════════════════════════════════════════════════════════════════════════════
#  Progress Dialog
# ══════════════════════════════════════════════════════════════════════════════
class ProgressDialog(QDialog):
    def __init__(self, title="Processing...", parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setWindowModality(Qt.ApplicationModal)
        self.setMinimumWidth(460)
        self.setFixedHeight(140)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 16, 20, 16)
        layout.setSpacing(8)

        self.lbl_task = QLabel("Initializing...")
        self.lbl_task.setAlignment(Qt.AlignLeft)
        bold = QFont(); bold.setBold(True)
        self.lbl_task.setFont(bold)
        layout.addWidget(self.lbl_task)

        self.progress_bar = QProgressBar()
        self.progress_bar.setMinimum(0)
        self.progress_bar.setValue(0)
        self.progress_bar.setTextVisible(True)
        self.progress_bar.setFixedHeight(22)
        layout.addWidget(self.progress_bar)

        self.lbl_detail = QLabel("")
        self.lbl_detail.setAlignment(Qt.AlignLeft)
        self.lbl_detail.setStyleSheet("font-size: 11px; color: #aaa;")
        layout.addWidget(self.lbl_detail)

    def set_range(self, mn, mx):
        self.progress_bar.setMinimum(mn)
        self.progress_bar.setMaximum(mx)

    def set_value(self, v):
        self.progress_bar.setValue(v)
        QApplication.processEvents()

    def set_task(self, t):
        self.lbl_task.setText(t)
        QApplication.processEvents()

    def set_detail(self, t):
        self.lbl_detail.setText(t)
        QApplication.processEvents()


# ══════════════════════════════════════════════════════════════════════════════
#  Batch Rename Dialog
# ══════════════════════════════════════════════════════════════════════════════
class BatchRenameDialog(QDialog):
    TEMPLATES = [
        "{artist} - {title}",
        "{tracknumber}. {title}",
        "{tracknumber}. {artist} - {title}",
        "{album} - {tracknumber} - {title}",
        "{artist} - {album} - {title}",
        "Custom…",
    ]

    def __init__(self, rows, parent=None):
        """rows: list of dicts with keys filename,title,artist,album,year,genre,tracknumber,path"""
        super().__init__(parent)
        self.rows = rows
        self.setWindowTitle("Batch Rename Files")
        self.setMinimumWidth(680)
        self.setMinimumHeight(460)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)

        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        # Template selector
        top = QHBoxLayout()
        top.addWidget(QLabel("Template:"))
        self.cmb_template = QComboBox()
        self.cmb_template.addItems(self.TEMPLATES)
        self.cmb_template.currentIndexChanged.connect(self._on_template_changed)
        top.addWidget(self.cmb_template, 1)
        layout.addLayout(top)

        # Custom field
        self.le_custom = QLineEdit()
        self.le_custom.setPlaceholderText(
            "Use {title} {artist} {album} {year} {genre} {tracknumber}")
        self.le_custom.setEnabled(False)
        self.le_custom.textChanged.connect(self._refresh_preview)
        layout.addWidget(self.le_custom)

        # Preview table
        layout.addWidget(QLabel("Preview (original → new name):"))
        self.preview_table = QTableWidget()
        self.preview_table.setColumnCount(2)
        self.preview_table.setHorizontalHeaderLabels(["Original Filename", "New Filename"])
        self.preview_table.horizontalHeader().setStretchLastSection(True)
        self.preview_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.preview_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.preview_table.setSelectionMode(QAbstractItemView.NoSelection)
        layout.addWidget(self.preview_table)

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

        self._refresh_preview()

    def _on_template_changed(self, idx):
        is_custom = (self.cmb_template.currentText() == "Custom…")
        self.le_custom.setEnabled(is_custom)
        self._refresh_preview()

    def _get_template(self):
        t = self.cmb_template.currentText()
        if t == "Custom…":
            return self.le_custom.text()
        return t

    def _apply_template(self, tmpl, row):
        name = tmpl
        for key in ["title", "artist", "album", "year", "genre", "tracknumber"]:
            val = row.get(key, "") or ""
            # Sanitize for filesystem
            val = "".join(c for c in val if c not in r'\/:*?"<>|')
            name = name.replace("{" + key + "}", val)
        ext = os.path.splitext(row.get("filename", ""))[1]
        return name.strip() + ext

    def _refresh_preview(self):
        tmpl = self._get_template()
        self.preview_table.setRowCount(len(self.rows))
        for i, row in enumerate(self.rows):
            old = row.get("filename", "")
            new = self._apply_template(tmpl, row) if tmpl.strip() else old
            old_item = QTableWidgetItem(old)
            new_item = QTableWidgetItem(new)
            if old != new:
                new_item.setForeground(QColor(39, 174, 96))
            self.preview_table.setItem(i, 0, old_item)
            self.preview_table.setItem(i, 1, new_item)

    def get_rename_pairs(self):
        """Returns list of (old_path, new_path)"""
        tmpl = self._get_template()
        pairs = []
        for row in self.rows:
            new_name = self._apply_template(tmpl, row)
            old_path = row["path"]
            new_path = os.path.join(os.path.dirname(old_path), new_name)
            pairs.append((old_path, new_path))
        return pairs


# ══════════════════════════════════════════════════════════════════════════════
#  Statistics / Dashboard Dialog
# ══════════════════════════════════════════════════════════════════════════════
class StatsDashboard(QDialog):
    def __init__(self, rows, parent=None):
        """rows: list of dicts from file table"""
        super().__init__(parent)
        self.setWindowTitle("Library Statistics Dashboard")
        self.setMinimumSize(700, 560)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)

        layout = QVBoxLayout(self)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        inner = QWidget()
        inner_layout = QVBoxLayout(inner)
        inner_layout.setSpacing(14)
        scroll.setWidget(inner)
        layout.addWidget(scroll)

        total = len(rows)
        total_dur = sum(r.get("duration_sec", 0) for r in rows)
        total_mb = sum(r.get("size_mb", 0.0) for r in rows)
        mins, secs = divmod(int(total_dur), 60)
        hrs, mins = divmod(mins, 60)

        # ── Summary cards ──
        cards_layout = QHBoxLayout()
        cards_layout.setSpacing(12)
        card_data = [
            ("Total Files", str(total), "#2980b9"),
            ("Total Duration", f"{hrs}h {mins}m {secs}s", "#27ae60"),
            ("Total Size", f"{total_mb:.1f} MB", "#8e44ad"),
            ("Formats", self._count_formats(rows), "#e67e22"),
        ]
        for title, val, color in card_data:
            card = QGroupBox(title)
            card.setFixedHeight(80)
            cl = QVBoxLayout(card)
            lbl = QLabel(val)
            lbl.setAlignment(Qt.AlignCenter)
            f = QFont(); f.setPointSize(18); f.setBold(True)
            lbl.setFont(f)
            lbl.setStyleSheet(f"color: {color};")
            cl.addWidget(lbl)
            cards_layout.addWidget(card)
        inner_layout.addLayout(cards_layout)

        # ── Tag completeness ──
        complete = sum(1 for r in rows if all([r.get("title"), r.get("artist"),
                                               r.get("album"), r.get("year"), r.get("genre")]))
        partial = sum(1 for r in rows if not all([r.get("title"), r.get("artist"),
                                                   r.get("album"), r.get("year"), r.get("genre")])
                      and any([r.get("title"), r.get("artist"), r.get("album")]))
        empty = total - complete - partial

        comp_group = QGroupBox("Tag Completeness")
        comp_layout = QVBoxLayout(comp_group)
        bar_data = [("Complete (all 5 tags)", complete, "#27ae60"),
                    ("Partial (some tags)", partial, "#f39c12"),
                    ("Empty (no tags)", empty, "#c0392b")]
        for label, count, color in bar_data:
            row_w = QWidget()
            row_l = QHBoxLayout(row_w)
            row_l.setContentsMargins(0, 0, 0, 0)
            lbl_name = QLabel(label)
            lbl_name.setFixedWidth(220)
            bar = QProgressBar()
            bar.setMaximum(max(total, 1))
            bar.setValue(count)
            bar.setTextVisible(False)
            bar.setFixedHeight(16)
            bar.setStyleSheet(
                f"QProgressBar::chunk {{ background-color: {color}; border-radius: 3px; }}"
                "QProgressBar { border: 1px solid #444; border-radius: 3px; }")
            lbl_count = QLabel(f"{count} ({100*count//max(total,1)}%)")
            lbl_count.setFixedWidth(80)
            row_l.addWidget(lbl_name)
            row_l.addWidget(bar, 1)
            row_l.addWidget(lbl_count)
            comp_layout.addWidget(row_w)
        inner_layout.addWidget(comp_group)

        # ── Top Genres ──
        genre_counts = {}
        for r in rows:
            g = r.get("genre", "") or "Unknown"
            genre_counts[g] = genre_counts.get(g, 0) + 1
        top_genres = sorted(genre_counts.items(), key=lambda x: -x[1])[:8]

        gen_group = QGroupBox("Top Genres")
        gen_layout = QVBoxLayout(gen_group)
        colors = ["#3498db","#2ecc71","#e74c3c","#9b59b6",
                  "#f39c12","#1abc9c","#e67e22","#34495e"]
        for i, (genre, cnt) in enumerate(top_genres):
            rw = QWidget()
            rl = QHBoxLayout(rw)
            rl.setContentsMargins(0, 0, 0, 0)
            ln = QLabel(genre[:30])
            ln.setFixedWidth(200)
            b = QProgressBar()
            b.setMaximum(max(total, 1))
            b.setValue(cnt)
            b.setTextVisible(False)
            b.setFixedHeight(14)
            b.setStyleSheet(
                f"QProgressBar::chunk {{ background-color: {colors[i % len(colors)]}; border-radius: 2px; }}"
                "QProgressBar { border: 1px solid #444; border-radius: 2px; }")
            lc = QLabel(str(cnt))
            lc.setFixedWidth(50)
            rl.addWidget(ln); rl.addWidget(b, 1); rl.addWidget(lc)
            gen_layout.addWidget(rw)
        inner_layout.addWidget(gen_group)

        # ── Year distribution ──
        year_counts = {}
        for r in rows:
            y = str(r.get("year", "") or "")[:4]
            if y.isdigit() and 1900 <= int(y) <= 2100:
                year_counts[y] = year_counts.get(y, 0) + 1
        if year_counts:
            yr_group = QGroupBox("Tracks by Decade")
            yr_layout = QVBoxLayout(yr_group)
            decades = {}
            for y, c in year_counts.items():
                d = f"{y[:3]}0s"
                decades[d] = decades.get(d, 0) + c
            for dec, cnt in sorted(decades.items()):
                rw = QWidget(); rl = QHBoxLayout(rw); rl.setContentsMargins(0, 0, 0, 0)
                ln = QLabel(dec); ln.setFixedWidth(60)
                b = QProgressBar(); b.setMaximum(max(total, 1)); b.setValue(cnt)
                b.setTextVisible(False); b.setFixedHeight(14)
                b.setStyleSheet(
                    "QProgressBar::chunk { background-color: #2980b9; border-radius: 2px; }"
                    "QProgressBar { border: 1px solid #444; border-radius: 2px; }")
                lc = QLabel(str(cnt)); lc.setFixedWidth(50)
                rl.addWidget(ln); rl.addWidget(b, 1); rl.addWidget(lc)
                yr_layout.addWidget(rw)
            inner_layout.addWidget(yr_group)

        inner_layout.addStretch()

        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.accept)
        layout.addWidget(close_btn)

    def _count_formats(self, rows):
        fmts = set()
        for r in rows:
            ext = os.path.splitext(r.get("filename", ""))[1].upper()
            if ext:
                fmts.add(ext)
        return " / ".join(sorted(fmts)) if fmts else "–"


# ══════════════════════════════════════════════════════════════════════════════
#  Keyboard Shortcuts Overlay
# ══════════════════════════════════════════════════════════════════════════════
class ShortcutsDialog(QDialog):
    SHORTCUTS = [
        ("Ctrl+S",   "Save current metadata"),
        ("Ctrl+Z",   "Undo last change"),
        ("Ctrl+Y",   "Redo last change"),
        ("F1",       "Show this shortcuts panel"),
        ("F5",       "Refresh / reload folder"),
        ("Delete",   "Remove artwork from current file"),
        ("Ctrl+A",   "Select all files in table"),
        ("Ctrl+E",   "Export metadata to CSV"),
        ("Ctrl+I",   "Import metadata from CSV"),
        ("Ctrl+R",   "Batch rename selected files"),
        ("Ctrl+D",   "Detect duplicates"),
        ("Ctrl+M",   "Show missing-tag report"),
        ("Ctrl+B",   "Run BPM detection (requires media_engine)"),
        ("Ctrl+T",   "Auto Tag selected files"),
        ("Ctrl+L",   "Fetch lyrics from LRCLIB"),
        ("Space",    "Play / Pause current track"),
    ]

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Keyboard Shortcuts")
        self.setMinimumWidth(440)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)
        layout = QVBoxLayout(self)
        tbl = QTableWidget(len(self.SHORTCUTS), 2)
        tbl.setHorizontalHeaderLabels(["Shortcut", "Action"])
        tbl.horizontalHeader().setStretchLastSection(True)
        tbl.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        tbl.setEditTriggers(QAbstractItemView.NoEditTriggers)
        tbl.setSelectionMode(QAbstractItemView.NoSelection)
        tbl.verticalHeader().setVisible(False)
        for i, (key, desc) in enumerate(self.SHORTCUTS):
            ki = QTableWidgetItem(key)
            ki.setFont(QFont("Courier New", 9))
            tbl.setItem(i, 0, ki)
            tbl.setItem(i, 1, QTableWidgetItem(desc))
        layout.addWidget(tbl)
        btn = QPushButton("Close")
        btn.clicked.connect(self.accept)
        layout.addWidget(btn)


# ══════════════════════════════════════════════════════════════════════════════
#  Main Application
# ══════════════════════════════════════════════════════════════════════════════
class AdvancedTagEditor(QMainWindow):

    def __init__(self):
        super().__init__()
        self.setWindowTitle("Advanced Tag Editor — Enterprise Edition")
        self.resize(1440, 860)
        self.setAcceptDrops(True)

        icon_path = "tag.ico"
        if hasattr(sys, "_MEIPASS"):
            icon_path = os.path.join(sys._MEIPASS, icon_path)
        if os.path.exists(icon_path):
            self.setWindowIcon(QIcon(icon_path))

        self.current_file_path = None
        self.audio_file = None
        self.current_artwork_data = None
        self.art_deleted = False
        self.is_side_by_side = True
        self.current_folder = None

        # Undo/redo per file  { path: [state_dict, ...] }
        self._undo_stack = {}   # { path: [state, ...] }
        self._redo_stack = {}
        self._cached_rows = []  # for stats / export

        self.settings = QSettings("MacanAngkasa", "AdvancedTagEditor")

        # Playback lewat media_engine.PlayerEngine (gantiin QMediaPlayer +
        # QAudioOutput dari QtMultimedia). Beda arsitektur penting:
        # PlayerEngine gak punya "empty source" state -- dia dibuka
        # LANGSUNG ke sebuah file di constructor, jadi self.player di sini
        # LAZY (None sampai load_metadata() pertama kali dipanggil) dan
        # DIBUAT ULANG tiap kali file yang dimuat berganti (lihat
        # load_metadata()/_release_player_lock()/populate_file_table()).
        # PlayerEngine juga gak punya sinyal Qt (positionChanged/
        # durationChanged) -- posisi playhead di-poll lewat
        # _playback_timer (lihat _poll_playback_position()).
        self.player = None
        self._playback_volume = self.settings.value("volume", 70, type=int)
        self._playback_timer = QTimer(self)
        self._playback_timer.setInterval(100)  # sama seperti update rate QMediaPlayer dulu
        self._playback_timer.timeout.connect(self._poll_playback_position)

        self.setup_actions()
        self.setup_menu_and_toolbar()
        self.setup_ui()
        self.setup_docks()
        self.setup_statusbar()
        self.setup_shortcuts()

        saved_theme = self.settings.value("theme", "dark")
        self.apply_theme(saved_theme)
        if saved_theme == "light":
            self.theme_light_action.setChecked(True)
        else:
            self.theme_dark_action.setChecked(True)

        self.volume_slider.setValue(self._playback_volume)

    # ── Drag & Drop ───────────────────────────
    def dragEnterEvent(self, e: QDragEnterEvent):
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e: QDropEvent):
        urls = e.mimeData().urls()
        audio_exts = {".mp3", ".m4a", ".flac"}
        folders = []
        files = []
        for url in urls:
            path = url.toLocalFile()
            if os.path.isdir(path):
                folders.append(path)
            elif os.path.splitext(path)[1].lower() in audio_exts:
                files.append(path)
        if folders:
            self.populate_file_table(folders[0])
        elif files:
            self._load_dropped_files(files)

    def _load_dropped_files(self, file_paths):
        self.file_table.setRowCount(0)
        self.clear_fields()
        self._cached_rows = []
        for row, fp in enumerate(file_paths):
            self.file_table.insertRow(row)
            self._populate_row(row, fp)
        self.status_bar.showMessage(f"Loaded {len(file_paths)} dropped file(s).")

    # ── Integrasi Macan Media Player ──────────
    def _find_row_by_path(self, file_path):
        """Cari baris tabel untuk file_path (case-insensitive di Windows). -1 kalau gak ada."""
        target = os.path.normcase(os.path.abspath(file_path))
        for r in range(self.file_table.rowCount()):
            it = self.file_table.item(r, 1)
            fp = it.data(Qt.UserRole) if it else None
            if fp and os.path.normcase(os.path.abspath(fp)) == target:
                return r
        return -1

    def open_external_file(self, file_path):
        """Buka (dan pilih) satu file yang dikirim dari luar, mis. Macan Media Player.

        Kalau file sudah ada di tabel -> tinggal dipilih; kalau belum -> ditambah
        sebagai baris baru (tabel yang sudah ada gak dikosongkan, jadi beberapa
        file yang dikirim berturut-turut menumpuk di tabel yang sama).
        Return True kalau berhasil."""
        try:
            fp = os.path.abspath(file_path)
            if not os.path.isfile(fp):
                self.status_bar.showMessage(f"File not found: {fp}")
                self._log(f"External file not found: {fp}")
                return False

            row = self._find_row_by_path(fp)
            if row < 0:
                row = self.file_table.rowCount()
                self.file_table.insertRow(row)
                self._populate_row(row, fp)
                self._enable_folder_actions(True)
                self.lbl_status_info.setText(f"{self.file_table.rowCount()} files | Macan Media Player")

            # selectRow() biasanya sudah men-trigger load_metadata() lewat
            # itemSelectionChanged, tapi TIDAK kalau baris itu sudah terpilih
            # (file yang sama dikirim ulang) -- jadi sinyalnya diblok dan
            # load_metadata() dipanggil sekali secara eksplisit.
            self.file_table.blockSignals(True)
            try:
                self.file_table.selectRow(row)
            finally:
                self.file_table.blockSignals(False)
            self.file_table.scrollToItem(self.file_table.item(row, 1))
            self.load_metadata(fp)
            self._log(f"Opened from Macan Media Player: {fp}")
            return True
        except Exception as e:
            self.status_bar.showMessage(f"Error opening file: {e}")
            traceback.print_exc()
            return False

    def bring_to_front(self):
        if self.isMinimized():
            self.setWindowState(self.windowState() & ~Qt.WindowMinimized)
        self.show()
        self.raise_()
        self.activateWindow()

    def start_inbox_watch(self, inbox_dir, interval_ms=500):
        """Pantau folder inbox: Macan Media Player menaruh file *.txt berisi path
        audio di sini kalau editor sudah terbuka, jadi gak perlu spawn proses
        kedua / IPC khusus (murni file, jalan sama di Windows & Linux)."""
        self._inbox_dir = inbox_dir
        try:
            os.makedirs(inbox_dir, exist_ok=True)
        except OSError:
            return
        self._inbox_timer = QTimer(self)
        self._inbox_timer.setInterval(interval_ms)
        self._inbox_timer.timeout.connect(self._poll_inbox)
        self._inbox_timer.start()

    def _poll_inbox(self):
        try:
            names = sorted(n for n in os.listdir(self._inbox_dir) if n.endswith(".txt"))
        except OSError:
            return
        opened = False
        for n in names:
            fp = os.path.join(self._inbox_dir, n)
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    target = f.read().strip()
                os.remove(fp)
            except OSError:
                continue
            if target and self.open_external_file(target):
                opened = True
        if opened:
            self.bring_to_front()

    # ── Actions ──────────────────────────────
    def setup_actions(self):
        sp = self.style()

        self.open_dir_action = QAction(sp.standardIcon(QStyle.SP_DirIcon), "Locate Folder…", self)
        self.open_dir_action.triggered.connect(self.open_directory)

        self.save_action = QAction(sp.standardIcon(QStyle.SP_DialogSaveButton), "Save Metadata", self)
        self.save_action.setShortcut("Ctrl+S")
        self.save_action.triggered.connect(self.save_metadata)
        self.save_action.setEnabled(False)

        self.undo_action = QAction(sp.standardIcon(QStyle.SP_ArrowBack), "Undo", self)
        self.undo_action.setShortcut("Ctrl+Z")
        self.undo_action.triggered.connect(self.undo)
        self.undo_action.setEnabled(False)

        self.redo_action = QAction(sp.standardIcon(QStyle.SP_ArrowForward), "Redo", self)
        self.redo_action.setShortcut("Ctrl+Y")
        self.redo_action.triggered.connect(self.redo)
        self.redo_action.setEnabled(False)

        self.exit_action = QAction("Exit", self)
        self.exit_action.triggered.connect(self.close)

        self.auto_tag_action = QAction(sp.standardIcon(QStyle.SP_ComputerIcon), "Auto Tag (Magic)", self)
        self.auto_tag_action.triggered.connect(self.auto_tag)
        self.auto_tag_action.setEnabled(False)

        self.batch_rename_action = QAction(sp.standardIcon(QStyle.SP_FileDialogNewFolder), "Batch Rename…", self)
        self.batch_rename_action.setShortcut("Ctrl+R")
        self.batch_rename_action.triggered.connect(self.batch_rename)
        self.batch_rename_action.setEnabled(False)

        self.export_csv_action = QAction(sp.standardIcon(QStyle.SP_DialogSaveButton), "Export CSV…", self)
        self.export_csv_action.setShortcut("Ctrl+E")
        self.export_csv_action.triggered.connect(self.export_csv)
        self.export_csv_action.setEnabled(False)

        self.import_csv_action = QAction(sp.standardIcon(QStyle.SP_DialogOpenButton), "Import CSV…", self)
        self.import_csv_action.setShortcut("Ctrl+I")
        self.import_csv_action.triggered.connect(self.import_csv)
        self.import_csv_action.setEnabled(False)

        self.duplicate_action = QAction(sp.standardIcon(QStyle.SP_MessageBoxWarning), "Find Duplicates", self)
        self.duplicate_action.setShortcut("Ctrl+D")
        self.duplicate_action.triggered.connect(self.find_duplicates)
        self.duplicate_action.setEnabled(False)

        self.missing_tag_action = QAction(sp.standardIcon(QStyle.SP_MessageBoxInformation), "Missing Tags Filter", self)
        self.missing_tag_action.setShortcut("Ctrl+M")
        self.missing_tag_action.triggered.connect(self.filter_missing_tags)
        self.missing_tag_action.setEnabled(False)

        self.stats_action = QAction(sp.standardIcon(QStyle.SP_FileDialogDetailedView), "Statistics Dashboard", self)
        self.stats_action.triggered.connect(self.show_stats)
        self.stats_action.setEnabled(False)

        self.bpm_action = QAction(sp.standardIcon(QStyle.SP_MediaSeekForward), "Detect BPM", self)
        self.bpm_action.setShortcut("Ctrl+B")
        self.bpm_action.triggered.connect(self.detect_bpm)
        self.bpm_action.setEnabled(False)

        self.about_action = QAction("About", self)
        self.about_action.triggered.connect(self.show_about)

        self.shortcuts_action = QAction(sp.standardIcon(QStyle.SP_TitleBarContextHelpButton), "Keyboard Shortcuts (F1)", self)
        self.shortcuts_action.setShortcut("F1")
        self.shortcuts_action.triggered.connect(self.show_shortcuts)

        self.btn_play_pause = QAction(sp.standardIcon(QStyle.SP_MediaPlay), "Play", self)
        self.btn_play_pause.triggered.connect(self.toggle_playback)
        self.btn_play_pause.setEnabled(False)

        self.change_view_action = QAction(sp.standardIcon(QStyle.SP_FileDialogDetailedView), "Change View", self)
        self.change_view_action.setToolTip("Toggle stacked / side-by-side layout")
        self.change_view_action.triggered.connect(self.toggle_view)

        self.refresh_action = QAction(sp.standardIcon(QStyle.SP_BrowserReload), "Refresh Folder", self)
        self.refresh_action.setShortcut("F5")
        self.refresh_action.triggered.connect(self.refresh_folder)

        self.theme_dark_action = QAction("Dark Theme", self)
        self.theme_dark_action.setCheckable(True)
        self.theme_dark_action.triggered.connect(lambda: self.apply_theme("dark"))

        self.theme_light_action = QAction("Light Theme", self)
        self.theme_light_action.setCheckable(True)
        self.theme_light_action.triggered.connect(lambda: self.apply_theme("light"))

    # ── Menu & Toolbar ─────────────────────────
    def setup_menu_and_toolbar(self):
        mb = self.menuBar()

        fm = mb.addMenu("&File")
        fm.addAction(self.open_dir_action)
        fm.addAction(self.save_action)
        fm.addAction(self.undo_action)
        fm.addAction(self.redo_action)
        fm.addSeparator()
        fm.addAction(self.export_csv_action)
        fm.addAction(self.import_csv_action)
        fm.addSeparator()
        fm.addAction(self.exit_action)

        tm = mb.addMenu("&Tools")
        tm.addAction(self.auto_tag_action)
        tm.addAction(self.batch_rename_action)
        tm.addSeparator()
        tm.addAction(self.bpm_action)
        tm.addSeparator()
        tm.addAction(self.duplicate_action)
        tm.addAction(self.missing_tag_action)
        tm.addAction(self.stats_action)

        vm = mb.addMenu("&View")
        vm.addAction(self.change_view_action)
        vm.addAction(self.refresh_action)
        vm.addSeparator()
        theme_menu = vm.addMenu("Theme")
        theme_menu.addAction(self.theme_dark_action)
        theme_menu.addAction(self.theme_light_action)

        hm = mb.addMenu("&Help")
        hm.addAction(self.shortcuts_action)
        hm.addAction(self.about_action)

        # ── Ribbon-style toolbar with section labels ──
        def make_section(parent, label, actions, slider_widget=None):
            """Group of actions inside a labelled QFrame — ribbon-like appearance."""
            frame = QFrame()
            frame.setFrameShape(QFrame.StyledPanel)
            fl = QVBoxLayout(frame)
            fl.setContentsMargins(4, 2, 4, 2)
            fl.setSpacing(2)
            btn_row = QHBoxLayout()
            btn_row.setSpacing(2)
            for a in actions:
                if a is None:
                    sep = QFrame()
                    sep.setFrameShape(QFrame.VLine)
                    btn_row.addWidget(sep)
                else:
                    tb = parent.widgetForAction(a) if hasattr(parent, 'widgetForAction') else None
                    parent.addAction(a)
                    # Re-fetch after adding
            if slider_widget:
                btn_row.addWidget(slider_widget)
            fl.addLayout(btn_row)
            lbl = QLabel(label)
            lbl.setAlignment(Qt.AlignCenter)
            lbl.setStyleSheet("font-size: 9px; color: #888;")
            fl.addWidget(lbl)
            return frame

        tb = QToolBar("Main Toolbar")
        tb.setIconSize(QSize(22, 22))
        tb.setMovable(False)
        self.addToolBar(tb)

        # Section: File
        tb.addAction(self.open_dir_action)
        tb.addAction(self.save_action)
        tb.addAction(self.undo_action)
        tb.addAction(self.redo_action)
        tb.addAction(self.refresh_action)
        self._add_tb_label(tb, "FILE")

        tb.addSeparator()

        # Section: Batch
        tb.addAction(self.auto_tag_action)
        tb.addAction(self.batch_rename_action)
        tb.addAction(self.export_csv_action)
        tb.addAction(self.import_csv_action)
        self._add_tb_label(tb, "BATCH")

        tb.addSeparator()

        # Section: Analysis
        tb.addAction(self.bpm_action)
        tb.addAction(self.duplicate_action)
        tb.addAction(self.stats_action)
        self._add_tb_label(tb, "ANALYSIS")

        tb.addSeparator()

        # Section: View
        tb.addAction(self.change_view_action)
        tb.addAction(self.shortcuts_action)
        self._add_tb_label(tb, "VIEW")

        tb.addSeparator()

        # Section: Player
        tb.addAction(self.btn_play_pause)
        self.seek_slider = QSlider(Qt.Horizontal)
        self.seek_slider.setFixedWidth(180)
        self.seek_slider.setEnabled(False)
        self.seek_slider.sliderMoved.connect(self.set_position)
        tb.addWidget(self.seek_slider)
        self.lbl_time = QLabel("0:00")
        self.lbl_time.setFixedWidth(40)
        self.lbl_time.setStyleSheet("font-size: 11px;")
        tb.addWidget(self.lbl_time)
        self._add_tb_label(tb, "PLAYER")

        tb.addSeparator()

        # Section: Volume
        vol_lbl = QLabel(" 🔊 ")
        tb.addWidget(vol_lbl)
        self.volume_slider = QSlider(Qt.Horizontal)
        self.volume_slider.setFixedWidth(90)
        self.volume_slider.setRange(0, 100)
        self.volume_slider.valueChanged.connect(self.set_volume)
        tb.addWidget(self.volume_slider)
        self._add_tb_label(tb, "VOLUME")

    def _add_tb_label(self, tb, text):
        lbl = QLabel(f" {text} ")
        lbl.setStyleSheet(
            "font-size: 8px; color: #666; font-weight: bold; "
            "border-left: 1px solid #444; padding-left: 4px;")
        tb.addWidget(lbl)

    # ── Status Bar ────────────────────────────
    def setup_statusbar(self):
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        # Permanent right-side info widget
        self.lbl_status_info = QLabel("No folder loaded")
        self.lbl_status_info.setStyleSheet("font-size: 11px; color: #888; margin-right: 8px;")
        self.status_bar.addPermanentWidget(self.lbl_status_info)
        self.status_bar.showMessage("Ready — Open a folder or drag files to begin.")

    # ── Dock Widgets ──────────────────────────
    def setup_docks(self):
        # Activity Log dock
        self.log_dock = QDockWidget("Activity Log", self)
        self.log_dock.setAllowedAreas(Qt.BottomDockWidgetArea | Qt.RightDockWidgetArea)
        log_widget = QWidget()
        log_layout = QVBoxLayout(log_widget)
        log_layout.setContentsMargins(4, 4, 4, 4)
        self.log_list = QListWidget()
        self.log_list.setMaximumHeight(120)
        clear_log_btn = QPushButton("Clear Log")
        clear_log_btn.setFixedHeight(22)
        clear_log_btn.clicked.connect(self.log_list.clear)
        log_layout.addWidget(self.log_list)
        log_layout.addWidget(clear_log_btn)
        self.log_dock.setWidget(log_widget)
        self.addDockWidget(Qt.BottomDockWidgetArea, self.log_dock)

        # File Queue dock
        self.queue_dock = QDockWidget("Processing Queue", self)
        self.queue_dock.setAllowedAreas(Qt.LeftDockWidgetArea | Qt.RightDockWidgetArea)
        queue_widget = QWidget()
        queue_layout = QVBoxLayout(queue_widget)
        queue_layout.setContentsMargins(4, 4, 4, 4)
        queue_layout.addWidget(QLabel("Files queued for processing:"))
        self.queue_list = QListWidget()
        queue_layout.addWidget(self.queue_list)
        add_queue_btn = QPushButton("Add Selected to Queue")
        add_queue_btn.clicked.connect(self.add_to_queue)
        run_queue_btn = QPushButton("▶ Run Auto-Tag Queue")
        run_queue_btn.clicked.connect(self.run_queue)
        clr_queue_btn = QPushButton("Clear Queue")
        clr_queue_btn.clicked.connect(self.queue_list.clear)
        queue_layout.addWidget(add_queue_btn)
        queue_layout.addWidget(run_queue_btn)
        queue_layout.addWidget(clr_queue_btn)
        self.queue_dock.setWidget(queue_widget)
        self.addDockWidget(Qt.RightDockWidgetArea, self.queue_dock)

        # Add to View menu
        mb = self.menuBar()
        view_menu = None
        for action in mb.actions():
            if action.text() == "&View":
                view_menu = action.menu()
                break
        if view_menu:
            view_menu.addSeparator()
            view_menu.addAction(self.log_dock.toggleViewAction())
            view_menu.addAction(self.queue_dock.toggleViewAction())

    # ── Keyboard Shortcuts ────────────────────
    def setup_shortcuts(self):
        from PySide6.QtGui import QShortcut, QKeySequence
        QShortcut(QKeySequence("Space"), self, activated=self.toggle_playback)
        QShortcut(QKeySequence("Ctrl+A"), self,
                  activated=lambda: self.file_table.selectAll())

    # ── Main UI ───────────────────────────────
    def setup_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QHBoxLayout(central)
        main_layout.setContentsMargins(4, 4, 4, 4)

        self.outer_splitter = QSplitter(Qt.Horizontal)
        main_layout.addWidget(self.outer_splitter)

        # Directory tree
        self.dir_model = QFileSystemModel()
        self.dir_model.setRootPath("")
        self.dir_model.setFilter(QDir.Dirs | QDir.NoDotAndDotDot | QDir.Drives)

        self.tree_view = QTreeView()
        self.tree_view.setModel(self.dir_model)
        self.tree_view.setRootIndex(self.dir_model.index(""))
        self.tree_view.setColumnWidth(0, 220)
        self.tree_view.clicked.connect(self.on_folder_selected)
        for i in range(1, 4):
            self.tree_view.hideColumn(i)
        self.outer_splitter.addWidget(self.tree_view)

        self.tabs = QTabWidget()

        # ── Tab: Explorer & Metadata ─────────
        tab_basic = QWidget()
        basic_layout = QVBoxLayout(tab_basic)
        basic_layout.setContentsMargins(0, 0, 0, 0)

        # Column preset toolbar
        preset_bar = QWidget()
        preset_layout = QHBoxLayout(preset_bar)
        preset_layout.setContentsMargins(4, 2, 4, 2)
        preset_layout.addWidget(QLabel("Column preset:"))
        for label, cols in [("Compact", [0,1,2,6]), ("Standard", [0,1,2,3,4,5,6,7]),
                             ("Detail", list(range(9)))]:
            btn = QPushButton(label)
            btn.setFixedHeight(22)
            btn.clicked.connect(lambda checked, c=cols: self._apply_column_preset(c))
            preset_layout.addWidget(btn)
        preset_layout.addStretch()

        # Search/filter bar
        preset_layout.addWidget(QLabel("Filter:"))
        self.le_filter = QLineEdit()
        self.le_filter.setPlaceholderText("Search title / artist / album…")
        self.le_filter.setFixedWidth(220)
        self.le_filter.textChanged.connect(self._apply_filter)
        preset_layout.addWidget(self.le_filter)
        basic_layout.addWidget(preset_bar)

        self.inner_splitter = QSplitter(Qt.Horizontal)

        # File table (9 cols: + Bitrate)
        self.file_table = QTableWidget()
        self.file_table.setColumnCount(9)
        self.file_table.setHorizontalHeaderLabels(
            ["", "Filename", "Title", "Artist", "Album", "Year", "Genre", "Size", "Duration"])
        self.file_table.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
        self.file_table.horizontalHeader().setStretchLastSection(True)
        self.file_table.setColumnWidth(0, 14)   # badge column
        self.file_table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.file_table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.file_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.file_table.setAlternatingRowColors(True)
        self.file_table.setContextMenuPolicy(Qt.CustomContextMenu)
        self.file_table.customContextMenuRequested.connect(self.show_table_context_menu)
        self.file_table.itemSelectionChanged.connect(self.on_file_selected_from_table)
        self.file_table.horizontalHeader().sectionClicked.connect(self._sort_table)
        self._sort_col = -1
        self._sort_asc = True

        self.inner_splitter.addWidget(self.file_table)

        # Editor panel
        editor_widget = QWidget()
        editor_layout = QHBoxLayout(editor_widget)
        editor_layout.setContentsMargins(0, 0, 0, 0)

        info_group = QGroupBox("Metadata Properties")
        form_layout = QFormLayout(info_group)
        form_layout.setSpacing(6)
        self.field_title = QLineEdit()
        self.field_artist = QLineEdit()
        self.field_album = QLineEdit()
        self.field_year = QLineEdit()
        self.field_genre = QLineEdit()
        self.field_track = QLineEdit()

        # Track changes for undo
        for field in [self.field_title, self.field_artist, self.field_album,
                      self.field_year, self.field_genre, self.field_track]:
            field.textEdited.connect(self._on_field_edited)

        form_layout.addRow("Title:", self.field_title)
        form_layout.addRow("Artist:", self.field_artist)
        form_layout.addRow("Album:", self.field_album)
        form_layout.addRow("Year:", self.field_year)
        form_layout.addRow("Genre:", self.field_genre)
        form_layout.addRow("Track #:", self.field_track)

        # Audio analysis section
        audio_group = QGroupBox("Audio Analysis")
        audio_form = QFormLayout(audio_group)
        self.lbl_bitrate = QLabel("—")
        self.lbl_samplerate = QLabel("—")
        self.lbl_bpm = QLabel("—")
        self.lbl_format = QLabel("—")
        audio_form.addRow("Format:", self.lbl_format)
        audio_form.addRow("Bitrate:", self.lbl_bitrate)
        audio_form.addRow("Sample Rate:", self.lbl_samplerate)
        audio_form.addRow("BPM:", self.lbl_bpm)
        self.btn_detect_bpm = QPushButton("Detect BPM")
        self.btn_detect_bpm.clicked.connect(self.detect_bpm)
        self.btn_detect_bpm.setEnabled(False)
        if not FFMPEG_AVAILABLE:
            self.btn_detect_bpm.setToolTip("media_engine module not available — BPM detection disabled")
        audio_form.addRow("", self.btn_detect_bpm)

        left_col = QVBoxLayout()
        left_col.addWidget(info_group)
        left_col.addWidget(audio_group)
        left_col.addStretch()
        editor_layout.addLayout(left_col, 2)

        # Artwork group
        art_group = QGroupBox("Album Artwork & Tools")
        art_layout = QVBoxLayout(art_group)

        self.lbl_album_art = QLabel("No Artwork")
        self.lbl_album_art.setAlignment(Qt.AlignCenter)
        self.lbl_album_art.setFixedSize(220, 220)
        self.lbl_album_art.setStyleSheet(
            "background-color: #2b2b2b; color: #888; border: 1px solid #555;")

        btn_art_row1 = QHBoxLayout()
        self.btn_fetch_art = QPushButton("Fetch Art (iTunes)")
        self.btn_custom_art = QPushButton("Custom Art…")
        btn_art_row1.addWidget(self.btn_fetch_art)
        btn_art_row1.addWidget(self.btn_custom_art)

        btn_art_row2 = QHBoxLayout()
        self.btn_remove_art = QPushButton("Remove Art")
        btn_art_row2.addWidget(self.btn_remove_art)

        self.btn_auto_tag = QPushButton("⚡ Auto Tag (Magic)")
        self.btn_auto_tag.setIcon(self.style().standardIcon(QStyle.SP_ComputerIcon))

        self.btn_fetch_art.clicked.connect(self.fetch_itunes_art)
        self.btn_custom_art.clicked.connect(self.set_custom_cover_art)
        self.btn_remove_art.clicked.connect(self.remove_artwork)
        self.btn_auto_tag.clicked.connect(self.auto_tag)

        for b in [self.btn_auto_tag, self.btn_fetch_art, self.btn_custom_art, self.btn_remove_art]:
            b.setEnabled(False)

        art_layout.addWidget(self.lbl_album_art)
        art_layout.addLayout(btn_art_row1)
        art_layout.addLayout(btn_art_row2)
        art_layout.addSpacing(6)
        art_layout.addWidget(self.btn_auto_tag)
        art_layout.addStretch()

        editor_layout.addWidget(art_group, 1)

        self.inner_splitter.addWidget(editor_widget)
        self.inner_splitter.setSizes([700, 500])
        basic_layout.addWidget(self.inner_splitter)

        self.tabs.addTab(tab_basic, "🗂  Explorer & Metadata")

        # ── Tab: Lyrics ──────────────────────
        tab_lyrics = QWidget()
        lyrics_layout = QVBoxLayout(tab_lyrics)
        self.field_lyrics = QTextEdit()
        self.field_lyrics.setPlaceholderText("Lyrics will appear here…")
        self.btn_fetch_lyrics = QPushButton("Fetch Lyrics from LRCLIB")
        self.btn_fetch_lyrics.setIcon(self.style().standardIcon(QStyle.SP_FileDialogDetailedView))
        self.btn_fetch_lyrics.clicked.connect(self.fetch_lyrics)
        self.btn_fetch_lyrics.setEnabled(False)
        lyrics_layout.addWidget(self.field_lyrics)
        lyrics_layout.addWidget(self.btn_fetch_lyrics)
        self.tabs.addTab(tab_lyrics, "🎵  Lyrics")

        self.outer_splitter.addWidget(self.tabs)
        self.outer_splitter.setSizes([240, 1200])

    # ── Column presets ────────────────────────
    def _apply_column_preset(self, visible_cols):
        for i in range(self.file_table.columnCount()):
            self.file_table.setColumnHidden(i, i not in visible_cols)

    # ── Live filter ───────────────────────────
    def _apply_filter(self, text):
        text = text.lower()
        for row in range(self.file_table.rowCount()):
            match = False
            for col in [1, 2, 3, 4]:  # filename,title,artist,album
                item = self.file_table.item(row, col)
                if item and text in item.text().lower():
                    match = True
                    break
            self.file_table.setRowHidden(row, not match if text else False)

    # ── Table sort ────────────────────────────
    def _sort_table(self, col):
        if col == 0:
            return
        if self._sort_col == col:
            self._sort_asc = not self._sort_asc
        else:
            self._sort_col = col
            self._sort_asc = True
        self.file_table.sortItems(col, Qt.AscendingOrder if self._sort_asc else Qt.DescendingOrder)

    # ── Undo/Redo ─────────────────────────────
    def _snapshot(self):
        """Capture current field values for undo."""
        if not self.current_file_path:
            return
        state = {
            "title": self.field_title.text(),
            "artist": self.field_artist.text(),
            "album": self.field_album.text(),
            "year": self.field_year.text(),
            "genre": self.field_genre.text(),
            "track": self.field_track.text(),
        }
        path = self.current_file_path
        if path not in self._undo_stack:
            self._undo_stack[path] = []
        # Avoid duplicate snapshots
        if self._undo_stack[path] and self._undo_stack[path][-1] == state:
            return
        self._undo_stack[path].append(state)
        if path in self._redo_stack:
            self._redo_stack[path].clear()
        self.undo_action.setEnabled(True)
        self.redo_action.setEnabled(False)

    def _on_field_edited(self):
        self._snapshot()

    def _restore_state(self, state):
        for field, key in [(self.field_title, "title"), (self.field_artist, "artist"),
                           (self.field_album, "album"), (self.field_year, "year"),
                           (self.field_genre, "genre"), (self.field_track, "track")]:
            field.blockSignals(True)
            field.setText(state.get(key, ""))
            field.blockSignals(False)

    def undo(self):
        if not self.current_file_path:
            return
        path = self.current_file_path
        stack = self._undo_stack.get(path, [])
        if len(stack) < 2:
            self.status_bar.showMessage("Nothing to undo.", 2000)
            return
        current = stack.pop()
        if path not in self._redo_stack:
            self._redo_stack[path] = []
        self._redo_stack[path].append(current)
        self._restore_state(stack[-1])
        self.undo_action.setEnabled(len(stack) > 1)
        self.redo_action.setEnabled(True)
        self.status_bar.showMessage("Undo applied.", 2000)
        self._log(f"Undo: {os.path.basename(path)}")

    def redo(self):
        if not self.current_file_path:
            return
        path = self.current_file_path
        redo_stack = self._redo_stack.get(path, [])
        if not redo_stack:
            return
        state = redo_stack.pop()
        self._undo_stack.setdefault(path, []).append(state)
        self._restore_state(state)
        self.redo_action.setEnabled(bool(redo_stack))
        self.undo_action.setEnabled(True)
        self.status_bar.showMessage("Redo applied.", 2000)
        self._log(f"Redo: {os.path.basename(path)}")

    # ── Toggle View ───────────────────────────
    def toggle_view(self):
        self.is_side_by_side = not self.is_side_by_side
        if self.is_side_by_side:
            self.inner_splitter.setOrientation(Qt.Horizontal)
            self.inner_splitter.setSizes([700, 500])
            self.change_view_action.setText("Change View (Side-by-Side)")
        else:
            self.inner_splitter.setOrientation(Qt.Vertical)
            self.inner_splitter.setSizes([420, 300])
            self.change_view_action.setText("Change View (Stacked)")
        self.status_bar.showMessage("Layout toggled.", 2000)

    # ── Theme ────────────────────────────────
    def apply_theme(self, theme: str):
        self.settings.setValue("theme", theme)
        app = QApplication.instance()

        if theme == "dark":
            self.theme_dark_action.setChecked(True)
            self.theme_light_action.setChecked(False)
            p = QPalette()
            p.setColor(QPalette.Window,          QColor(40, 40, 40))
            p.setColor(QPalette.WindowText,      QColor(220, 220, 220))
            p.setColor(QPalette.Base,            QColor(28, 28, 28))
            p.setColor(QPalette.AlternateBase,   QColor(50, 50, 50))
            p.setColor(QPalette.ToolTipBase,     QColor(25, 25, 25))
            p.setColor(QPalette.ToolTipText,     QColor(220, 220, 220))
            p.setColor(QPalette.Text,            QColor(220, 220, 220))
            p.setColor(QPalette.Button,          QColor(55, 55, 55))
            p.setColor(QPalette.ButtonText,      QColor(220, 220, 220))
            p.setColor(QPalette.BrightText,      Qt.red)
            p.setColor(QPalette.Link,            QColor(42, 130, 218))
            p.setColor(QPalette.Highlight,       QColor(42, 130, 218))
            p.setColor(QPalette.HighlightedText, Qt.black)
            p.setColor(QPalette.Disabled, QPalette.Text,       QColor(90, 90, 90))
            p.setColor(QPalette.Disabled, QPalette.ButtonText, QColor(90, 90, 90))
            app.setPalette(p)
            app.setStyleSheet(
                "QToolTip{color:#ddd;background:#2b2b2b;border:1px solid #555;}"
                "QGroupBox{border:1px solid #4a4a4a;border-radius:5px;margin-top:10px;padding-top:8px;}"
                "QGroupBox::title{subcontrol-origin:margin;left:10px;color:#aaa;font-size:11px;}"
                "QTableWidget{gridline-color:#3a3a3a;}"
                "QHeaderView::section{background:#2d2d2d;border:1px solid #3a3a3a;padding:4px;}"
                "QDockWidget::title{background:#2d2d2d;padding:4px;font-weight:bold;}"
                "QPushButton{border-radius:4px;padding:4px 10px;}"
                "QPushButton:hover{background:#4a4a5a;}"
                "QLineEdit{border:1px solid #4a4a4a;border-radius:3px;padding:3px;}"
            )
            self.lbl_album_art.setStyleSheet(
                "background-color: #2b2b2b; color: #888; border: 1px solid #555;")
        else:
            self.theme_dark_action.setChecked(False)
            self.theme_light_action.setChecked(True)
            # Build a full explicit light palette to override OS-level dark mode
            p = QPalette()
            p.setColor(QPalette.Window,          QColor(240, 240, 240))
            p.setColor(QPalette.WindowText,      QColor(0, 0, 0))
            p.setColor(QPalette.Base,            QColor(255, 255, 255))
            p.setColor(QPalette.AlternateBase,   QColor(233, 233, 233))
            p.setColor(QPalette.ToolTipBase,     QColor(255, 255, 220))
            p.setColor(QPalette.ToolTipText,     QColor(0, 0, 0))
            p.setColor(QPalette.Text,            QColor(0, 0, 0))
            p.setColor(QPalette.Button,          QColor(225, 225, 225))
            p.setColor(QPalette.ButtonText,      QColor(0, 0, 0))
            p.setColor(QPalette.BrightText,      Qt.red)
            p.setColor(QPalette.Link,            QColor(0, 0, 255))
            p.setColor(QPalette.Highlight,       QColor(0, 120, 215))
            p.setColor(QPalette.HighlightedText, QColor(255, 255, 255))
            p.setColor(QPalette.Disabled, QPalette.Text,       QColor(160, 160, 160))
            p.setColor(QPalette.Disabled, QPalette.ButtonText, QColor(160, 160, 160))
            p.setColor(QPalette.Disabled, QPalette.WindowText, QColor(160, 160, 160))
            app.setPalette(p)
            # Explicit stylesheet with full color overrides so OS dark mode cannot bleed through
            app.setStyleSheet(
                "* { color: #000000; }"
                "QWidget { background-color: #f0f0f0; color: #000000; }"
                "QMainWindow { background-color: #f0f0f0; }"
                "QDialog { background-color: #f0f0f0; color: #000000; }"
                "QToolTip { color: #000000; background: #ffffdc; border: 1px solid #aaaaaa; }"
                "QMenuBar { background-color: #f0f0f0; color: #000000; }"
                "QMenuBar::item:selected { background-color: #0078d7; color: #ffffff; }"
                "QMenu { background-color: #ffffff; color: #000000; border: 1px solid #cccccc; }"
                "QMenu::item:selected { background-color: #0078d7; color: #ffffff; }"
                "QToolBar { background-color: #e8e8e8; border-bottom: 1px solid #cccccc; }"
                "QStatusBar { background-color: #e8e8e8; color: #000000; }"
                "QGroupBox { border: 1px solid #cccccc; border-radius: 5px; margin-top: 10px; "
                "            padding-top: 8px; background-color: #f5f5f5; color: #000000; }"
                "QGroupBox::title { subcontrol-origin: margin; left: 10px; font-size: 11px; color: #333333; }"
                "QTableWidget { background-color: #ffffff; color: #000000; gridline-color: #dddddd; "
                "               alternate-background-color: #f5f5f5; }"
                "QTableWidget::item:selected { background-color: #0078d7; color: #ffffff; }"
                "QHeaderView::section { background-color: #e0e0e0; color: #000000; "
                "                       border: 1px solid #cccccc; padding: 4px; }"
                "QDockWidget { background-color: #f0f0f0; color: #000000; }"
                "QDockWidget::title { background-color: #e0e0e0; padding: 4px; font-weight: bold; color: #000000; }"
                "QPushButton { background-color: #e1e1e1; color: #000000; border: 1px solid #adadad; "
                "              border-radius: 4px; padding: 4px 10px; }"
                "QPushButton:hover { background-color: #c8e0f4; border-color: #0078d7; }"
                "QPushButton:pressed { background-color: #0078d7; color: #ffffff; }"
                "QPushButton:disabled { background-color: #f0f0f0; color: #a0a0a0; border-color: #cccccc; }"
                "QLineEdit { background-color: #ffffff; color: #000000; border: 1px solid #bbbbbb; "
                "            border-radius: 3px; padding: 3px; }"
                "QLineEdit:focus { border-color: #0078d7; }"
                "QTextEdit { background-color: #ffffff; color: #000000; border: 1px solid #cccccc; }"
                "QComboBox { background-color: #ffffff; color: #000000; border: 1px solid #adadad; "
                "            border-radius: 3px; padding: 2px 4px; }"
                "QComboBox QAbstractItemView { background-color: #ffffff; color: #000000; "
                "                             selection-background-color: #0078d7; selection-color: #ffffff; }"
                "QListWidget { background-color: #ffffff; color: #000000; }"
                "QListWidget::item:selected { background-color: #0078d7; color: #ffffff; }"
                "QScrollBar:vertical { background: #f0f0f0; width: 14px; }"
                "QScrollBar::handle:vertical { background: #c0c0c0; border-radius: 3px; }"
                "QScrollBar:horizontal { background: #f0f0f0; height: 14px; }"
                "QScrollBar::handle:horizontal { background: #c0c0c0; border-radius: 3px; }"
                "QTabWidget::pane { border: 1px solid #cccccc; background-color: #f0f0f0; }"
                "QTabBar::tab { background-color: #e0e0e0; color: #000000; padding: 6px 12px; "
                "               border: 1px solid #cccccc; border-bottom: none; }"
                "QTabBar::tab:selected { background-color: #f0f0f0; font-weight: bold; }"
                "QSplitter::handle { background-color: #cccccc; }"
                "QProgressBar { border: 1px solid #cccccc; border-radius: 3px; background-color: #f0f0f0; }"
                "QCheckBox { color: #000000; }"
                "QLabel { color: #000000; }"
                "QSpinBox { background-color: #ffffff; color: #000000; border: 1px solid #adadad; }"
            )
            self.lbl_album_art.setStyleSheet(
                "background-color: #e8e8e8; color: #555555; border: 1px solid #bbbbbb;")

    # ── Activity Log ──────────────────────────
    def _log(self, msg):
        ts = datetime.datetime.now().strftime("%H:%M:%S")
        item = QListWidgetItem(f"[{ts}] {msg}")
        self.log_list.addItem(item)
        self.log_list.scrollToBottom()

    # ── Playback ─────────────────────────────
    def _open_player(self, file_path):
        """Buat instance media_engine.PlayerEngine baru buat file_path.
        Dipanggil dari load_metadata() tiap kali file yang dimuat berganti.
        Gagal dengan tenang (self.player tetap None) kalau media_engine gak
        ada atau file gagal dibuka -- fitur lain (edit tag, dst) tetap
        jalan tanpa preview playback."""
        if not _MEDIA_ENGINE:
            self.player = None
            return
        try:
            self.player = media_engine.PlayerEngine(file_path)
            self.player.set_volume(self._playback_volume / 100.0)
            self.update_duration(int(self.player.duration * 1000))
        except Exception as e:
            self.player = None
            self._log(f"Player error: {e}")

    def _close_player(self):
        """Hentikan polling & tutup player SEPENUHNYA (thread decode +
        stream audio cpal) supaya handle baca file bener-bener dilepas.
        Dipanggil sebelum ganti file, ganti folder, atau operasi yang
        butuh file gak lagi ke-lock (rename, dst -- lihat
        _release_player_lock())."""
        self._playback_timer.stop()
        if self.player:
            try:
                self.player.close()
            except Exception:
                pass
            self.player = None

    def toggle_playback(self):
        if not self.current_file_path or not self.player:
            return
        if self.player.is_playing():
            self.player.pause()
            self._playback_timer.stop()
            self.btn_play_pause.setIcon(self.style().standardIcon(QStyle.SP_MediaPlay))
            self.btn_play_pause.setText("Play")
        else:
            self.player.play()
            self._playback_timer.start()
            self.btn_play_pause.setIcon(self.style().standardIcon(QStyle.SP_MediaPause))
            self.btn_play_pause.setText("Pause")

    def update_seekbar(self, position):
        self.seek_slider.setValue(position)
        secs = position // 1000
        self.lbl_time.setText(f"{secs//60}:{secs%60:02d}")

    def update_duration(self, duration):
        self.seek_slider.setRange(0, duration)

    def _poll_playback_position(self):
        """Ganti positionChanged signal QMediaPlayer lama -- PlayerEngine
        gak punya sinyal Qt sama sekali, jadi posisi playback di-poll di
        sini tiap tick _playback_timer (~100ms) selama playback aktif.
        Hentikan playback otomatis begitu nyampe akhir file (dulu
        QMediaPlayer berhenti sendiri di EOF, sekarang dicek manual lewat
        is_eof())."""
        if not self.player:
            self._playback_timer.stop()
            return
        pos_ms = int(self.player.position() * 1000)
        self.update_seekbar(pos_ms)
        if self.player.is_eof():
            self._playback_timer.stop()
            self.btn_play_pause.setIcon(self.style().standardIcon(QStyle.SP_MediaPlay))
            self.btn_play_pause.setText("Play")

    def set_position(self, pos):
        """`pos` dalam milidetik (dari seek_slider, sama kayak dulu) --
        PlayerEngine.seek() sendiri pakai detik, jadi dikonversi di sini."""
        if self.player:
            self.player.seek(pos / 1000.0)

    def set_volume(self, v):
        self._playback_volume = v
        if self.player:
            self.player.set_volume(v / 100.0)
        self.settings.setValue("volume", v)

    # ── Open / Refresh ────────────────────────
    def open_directory(self):
        d = QFileDialog.getExistingDirectory(self, "Locate Music Folder", QDir.homePath())
        if d:
            idx = self.dir_model.index(d)
            self.tree_view.setCurrentIndex(idx)
            self.tree_view.scrollTo(idx)
            self.tree_view.expand(idx)
            self.populate_file_table(d)

    def refresh_folder(self):
        if self.current_folder:
            self.populate_file_table(self.current_folder)

    def on_folder_selected(self, index):
        self.populate_file_table(self.dir_model.filePath(index))

    # ── Populate Table ────────────────────────
    def populate_file_table(self, dir_path):
        self.current_folder = dir_path
        self.file_table.setRowCount(0)
        self.clear_fields()
        self.current_file_path = None
        self.audio_file = None
        self._close_player()
        self.btn_play_pause.setEnabled(False)
        self.seek_slider.setEnabled(False)
        self._cached_rows = []

        folder = QDir(dir_path)
        folder.setNameFilters(["*.mp3", "*.m4a", "*.flac"])
        folder.setFilter(QDir.Files)
        files = folder.entryInfoList()

        self.file_table.setRowCount(len(files))
        for row, fi in enumerate(files):
            self._populate_row(row, fi.absoluteFilePath())

        count = len(files)
        self.status_bar.showMessage(f"Folder loaded — {count} audio file(s) found.")
        self.lbl_status_info.setText(f"{count} files | {dir_path}")
        self._enable_folder_actions(count > 0)
        self._log(f"Opened folder: {dir_path} ({count} files)")

    def _enable_folder_actions(self, state):
        for a in [self.export_csv_action, self.import_csv_action,
                  self.duplicate_action, self.missing_tag_action,
                  self.stats_action, self.batch_rename_action]:
            a.setEnabled(state)

    def _populate_row(self, row, filepath):
        filename = os.path.basename(filepath)
        size_mb = os.path.getsize(filepath) / (1024 * 1024) if os.path.exists(filepath) else 0
        title = artist = album = year = genre = duration_str = ""
        duration_sec = 0

        try:
            f = mutagen.File(filepath, easy=True)
            if f and getattr(f, 'tags', None) is not None:
                title  = f.tags.get('title',  [''])[0]
                artist = f.tags.get('artist', [''])[0]
                album  = f.tags.get('album',  [''])[0]
                year   = f.tags.get('date', f.tags.get('year', ['']))[0]
                genre  = f.tags.get('genre',  [''])[0]
            if f and getattr(f, 'info', None) is not None:
                duration_sec = int(getattr(f.info, 'length', 0))
                m, s = divmod(duration_sec, 60)
                duration_str = f"{m}:{s:02d}"
        except Exception:
            pass

        # Completeness badge (col 0)
        badge = QTableWidgetItem("●")
        badge.setTextAlignment(Qt.AlignCenter)
        badge.setForeground(completeness_color(title, artist, album, year, genre))
        badge.setToolTip(f"Completeness: {sum(bool(x) for x in [title,artist,album,year,genre])}/5 tags")
        badge.setFlags(badge.flags() & ~Qt.ItemIsSelectable)

        item_fn = QTableWidgetItem(filename)
        item_fn.setData(Qt.UserRole, filepath)

        self.file_table.setItem(row, 0, badge)
        self.file_table.setItem(row, 1, item_fn)
        self.file_table.setItem(row, 2, QTableWidgetItem(title))
        self.file_table.setItem(row, 3, QTableWidgetItem(artist))
        self.file_table.setItem(row, 4, QTableWidgetItem(album))
        self.file_table.setItem(row, 5, QTableWidgetItem(year))
        self.file_table.setItem(row, 6, QTableWidgetItem(genre))
        self.file_table.setItem(row, 7, QTableWidgetItem(f"{size_mb:.2f} MB"))
        self.file_table.setItem(row, 8, QTableWidgetItem(duration_str))

        self._cached_rows.append({
            "filename": filename, "path": filepath,
            "title": title, "artist": artist, "album": album,
            "year": year, "genre": genre,
            "size_mb": size_mb, "duration_sec": duration_sec,
        })

    def _update_badge(self, row):
        t = self.file_table.item(row, 2)
        ar = self.file_table.item(row, 3)
        al = self.file_table.item(row, 4)
        yr = self.file_table.item(row, 5)
        gn = self.file_table.item(row, 6)
        vals = [x.text() if x else "" for x in [t, ar, al, yr, gn]]
        badge = self.file_table.item(row, 0)
        if badge:
            badge.setForeground(completeness_color(*vals))

    # ── Context Menu ──────────────────────────
    def show_table_context_menu(self, pos):
        item = self.file_table.itemAt(pos)
        if item is None:
            return
        sel_rows = sorted(set(i.row() for i in self.file_table.selectedItems()))
        multi = len(sel_rows) > 1
        menu = QMenu(self)

        menu.addAction(self.style().standardIcon(QStyle.SP_MediaPlay),
                       "Play / Pause", self.toggle_playback)
        menu.addSeparator()

        # Tag operations
        menu.addAction(self.style().standardIcon(QStyle.SP_ComputerIcon),
                       "Auto Tag Selected", self.auto_tag)
        menu.addAction(
            self.style().standardIcon(QStyle.SP_FileDialogDetailedView),
            "Fetch Lyrics (LRCLIB)", self.fetch_lyrics)
        menu.addAction(
            self.style().standardIcon(QStyle.SP_DialogDiscardButton),
            "Remove Lyrics (current file)" if not multi
                else f"Remove Lyrics ({len(sel_rows)} files)",
            self.remove_lyrics if not multi else self.batch_remove_lyrics)
        menu.addSeparator()

        # File operations
        menu.addAction(self.style().standardIcon(QStyle.SP_FileDialogNewFolder),
                       "Batch Rename Selected…", self.batch_rename)
        menu.addAction(self.style().standardIcon(QStyle.SP_FileDialogNewFolder),
                       "Smart Rename from Metadata…", self.smart_rename)
        menu.addAction("Add to Processing Queue", self.add_to_queue)
        menu.addSeparator()

        # File system operations
        menu.addAction(self.style().standardIcon(QStyle.SP_DirOpenIcon),
                       "Open Containing Folder", self.open_in_explorer)
        menu.addSeparator()
        menu.addAction(
            self.style().standardIcon(QStyle.SP_TrashIcon),
            f"Move to Recycle Bin ({len(sel_rows)} file(s))" if multi
                else "Move to Recycle Bin",
            self.move_to_recycle_bin)
        menu.addAction(
            self.style().standardIcon(QStyle.SP_MessageBoxCritical),
            f"Delete Permanently ({len(sel_rows)} file(s))" if multi
                else "Delete Permanently",
            self.delete_permanently)

        menu.exec(self.file_table.viewport().mapToGlobal(pos))

    # ── Release Player Lock ───────────────────
    def _release_player_lock(self):
        """Stop playback and fully close the player so Windows releases the
        file lock. media_engine.PlayerEngine (like QMediaPlayer before it)
        holds an exclusive read handle on Windows until it's closed --
        _close_player() tears down the decode threads + audio stream
        entirely (not just pause), which is what actually releases it."""
        self._close_player()
        self.btn_play_pause.setIcon(self.style().standardIcon(QStyle.SP_MediaPlay))
        self.btn_play_pause.setText("Play")

    # ── Smart Rename from Metadata ────────────
    def smart_rename(self):
        """Rename selected files using template tokens from metadata."""
        import re
        sel = self.file_table.selectedItems()
        if not sel:
            QMessageBox.warning(self, "No Selection", "Select files to rename.")
            return
        rows = sorted(set(i.row() for i in sel))

        dlg = QDialog(self)
        dlg.setWindowTitle("Smart Rename from Metadata")
        dlg.setMinimumWidth(560)
        lay = QVBoxLayout(dlg)
        lay.addWidget(QLabel(
            "Template tokens: {artist}, {title}, {album}, {year}, {genre}, {tracknumber}\n"
            "Illegal characters are removed automatically from each token."))

        templates = [
            "{artist} - {title}",
            "{tracknumber}. {artist} - {title}",
            "{tracknumber}. {title}",
            "{artist} - {album} - {tracknumber}. {title}",
            "{year} - {artist} - {title}",
        ]
        combo = QComboBox()
        combo.setEditable(True)
        combo.addItems(templates)
        lay.addWidget(QLabel("Template:"))
        lay.addWidget(combo)

        lay.addWidget(QLabel("Preview:"))
        prev_tbl = QTableWidget(len(rows), 2)
        prev_tbl.setHorizontalHeaderLabels(["Original", "New Name"])
        prev_tbl.horizontalHeader().setStretchLastSection(True)
        prev_tbl.setEditTriggers(QAbstractItemView.NoEditTriggers)
        lay.addWidget(prev_tbl)

        def _sanitize(s):
            return re.sub(r'[\\/:*?"<>|]', '', s).strip()

        def _preview():
            tmpl = combo.currentText()
            prev_tbl.setRowCount(len(rows))
            for idx, row in enumerate(rows):
                fp = self.file_table.item(row, 1).data(Qt.UserRole)
                ext = os.path.splitext(fp)[1]
                data = {
                    "artist":      _sanitize((self.file_table.item(row, 3) or QTableWidgetItem()).text()),
                    "title":       _sanitize((self.file_table.item(row, 2) or QTableWidgetItem()).text()),
                    "album":       _sanitize((self.file_table.item(row, 4) or QTableWidgetItem()).text()),
                    "year":        _sanitize((self.file_table.item(row, 5) or QTableWidgetItem()).text()),
                    "genre":       _sanitize((self.file_table.item(row, 6) or QTableWidgetItem()).text()),
                    "tracknumber": _sanitize((self.file_table.item(row, 7) or QTableWidgetItem()).text()),
                }
                try:
                    new_name = tmpl.format(**data).strip() + ext
                except KeyError as e:
                    new_name = f"[Bad token: {e}]"
                prev_tbl.setItem(idx, 0, QTableWidgetItem(os.path.basename(fp)))
                prev_tbl.setItem(idx, 1, QTableWidgetItem(new_name))

        combo.currentTextChanged.connect(_preview)
        _preview()

        btns = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        btns.accepted.connect(dlg.accept)
        btns.rejected.connect(dlg.reject)
        lay.addWidget(btns)

        if dlg.exec() != QDialog.Accepted:
            return

        self._release_player_lock()
        tmpl = combo.currentText()
        ok = 0; errors = []
        for row in rows:
            fp = self.file_table.item(row, 1).data(Qt.UserRole)
            ext = os.path.splitext(fp)[1]
            data = {
                "artist":      _sanitize((self.file_table.item(row, 3) or QTableWidgetItem()).text()),
                "title":       _sanitize((self.file_table.item(row, 2) or QTableWidgetItem()).text()),
                "album":       _sanitize((self.file_table.item(row, 4) or QTableWidgetItem()).text()),
                "year":        _sanitize((self.file_table.item(row, 5) or QTableWidgetItem()).text()),
                "genre":       _sanitize((self.file_table.item(row, 6) or QTableWidgetItem()).text()),
                "tracknumber": _sanitize((self.file_table.item(row, 7) or QTableWidgetItem()).text()),
            }
            try:
                new_name = tmpl.format(**data).strip() + ext
                new_path = os.path.join(os.path.dirname(fp), new_name)
                if fp == new_path:
                    continue
                if os.path.exists(new_path):
                    errors.append(f"Exists: {new_name}")
                    continue
                os.rename(fp, new_path)
                ok += 1
                self._log(f"Smart renamed: {os.path.basename(fp)} → {new_name}")
            except Exception as e:
                errors.append(str(e))

        if errors:
            QMessageBox.warning(self, "Rename Errors",
                f"{ok} file(s) renamed.\nErrors:\n" + "\n".join(errors[:10]))
        else:
            QMessageBox.information(self, "Smart Rename",
                f"{ok} file(s) renamed successfully.")
        if self.current_folder:
            self.populate_file_table(self.current_folder)

    # ── Open Containing Folder ────────────────
    def open_in_explorer(self):
        sel = self.file_table.selectedItems()
        if not sel:
            return
        fp = self.file_table.item(sel[0].row(), 1).data(Qt.UserRole)
        if not fp or not os.path.exists(fp):
            return
        import platform
        try:
            if platform.system() == "Windows":
                import ctypes
                norm = os.path.normpath(fp)
                ctypes.windll.shell32.ShellExecuteW(
                    None, "open", "explorer.exe",
                    f'/select,"{norm}"', None, 1)
            elif platform.system() == "Darwin":
                import subprocess as _sp
                _sp.Popen(["open", "-R", fp])
            else:
                import subprocess as _sp
                _sp.Popen(["xdg-open", os.path.dirname(fp)])
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Cannot open folder:\n{e}")

    # ── Move to Recycle Bin ───────────────────
    def move_to_recycle_bin(self):
        sel = self.file_table.selectedItems()
        if not sel:
            return
        rows = sorted(set(i.row() for i in sel))
        fps  = [self.file_table.item(r, 1).data(Qt.UserRole) for r in rows]
        names = "\n".join(os.path.basename(f) for f in fps[:10])
        if len(fps) > 10:
            names += f"\n… and {len(fps)-10} more"
        reply = QMessageBox.question(
            self, "Move to Recycle Bin",
            f"Move {len(fps)} file(s) to Recycle Bin?\n\n{names}",
            QMessageBox.Yes | QMessageBox.No)
        if reply != QMessageBox.Yes:
            return
        self._release_player_lock()
        ok = errors = 0
        try:
            import send2trash
            for fp in fps:
                try:
                    send2trash.send2trash(os.path.normpath(fp))
                    ok += 1
                    self._log(f"Moved to Recycle Bin: {os.path.basename(fp)}")
                except Exception as e:
                    errors += 1
                    self._log(f"Recycle Bin error {os.path.basename(fp)}: {e}")
        except ImportError:
            QMessageBox.warning(self, "send2trash Not Installed",
                "Install send2trash for Recycle Bin support:\n"
                "  pip install send2trash\n\n"
                "Falling back to permanent delete.")
            for fp in fps:
                try:
                    os.remove(fp)
                    ok += 1
                    self._log(f"Deleted (no recycle bin): {os.path.basename(fp)}")
                except Exception as e:
                    errors += 1
        if self.current_folder:
            self.populate_file_table(self.current_folder)
        self.status_bar.showMessage(
            f"Moved {ok} file(s) to Recycle Bin." +
            (f" {errors} error(s)." if errors else ""), 5000)

    # ── Delete Permanently ────────────────────
    def delete_permanently(self):
        sel = self.file_table.selectedItems()
        if not sel:
            return
        rows = sorted(set(i.row() for i in sel))
        fps  = [self.file_table.item(r, 1).data(Qt.UserRole) for r in rows]
        names = "\n".join(os.path.basename(f) for f in fps[:10])
        if len(fps) > 10:
            names += f"\n… and {len(fps)-10} more"
        reply = QMessageBox.warning(
            self, "Delete Permanently",
            f"⚠️  Permanently delete {len(fps)} file(s)? This cannot be undone.\n\n{names}",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No)
        if reply != QMessageBox.Yes:
            return
        self._release_player_lock()
        ok = errors = 0
        for fp in fps:
            try:
                os.remove(fp)
                ok += 1
                self._log(f"Permanently deleted: {os.path.basename(fp)}")
            except Exception as e:
                errors += 1
                self._log(f"Delete error {os.path.basename(fp)}: {e}")
        if self.current_folder:
            self.populate_file_table(self.current_folder)
        self.status_bar.showMessage(
            f"Deleted {ok} file(s) permanently." +
            (f" {errors} error(s)." if errors else ""), 5000)

    # ── Remove Lyrics Helpers ─────────────────
    def _remove_lyrics_from_file(self, fp):
        """Remove embedded lyrics from a single file. Returns True on success."""
        ext = fp.lower().split('.')[-1]
        if ext == 'mp3':
            a = ID3(fp)
            a.delall("USLT")
            a.save()
        elif ext == 'm4a':
            a = MP4(fp)
            a.pop('\xa9lyr', None)
            a.save()
        elif ext == 'flac':
            a = FLAC(fp)
            a.pop('lyrics', None)
            a.pop('unsyncedlyrics', None)
            a.save()
        else:
            return False
        return True

    def remove_lyrics(self):
        """Remove lyrics from the currently loaded file."""
        if not self.current_file_path:
            QMessageBox.warning(self, "No File", "Select a file first.")
            return
        reply = QMessageBox.question(
            self, "Remove Lyrics",
            f"Remove embedded lyrics from:\n{os.path.basename(self.current_file_path)}?",
            QMessageBox.Yes | QMessageBox.No)
        if reply != QMessageBox.Yes:
            return
        try:
            self._remove_lyrics_from_file(self.current_file_path)
            self.field_lyrics.clear()
            self.status_bar.showMessage(
                f"Lyrics removed: {os.path.basename(self.current_file_path)}", 4000)
            self._log(f"Lyrics removed: {os.path.basename(self.current_file_path)}")
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Could not remove lyrics:\n{e}")

    def batch_remove_lyrics(self):
        """Remove embedded lyrics from all selected files."""
        sel = self.file_table.selectedItems()
        if not sel:
            QMessageBox.warning(self, "No Selection", "Select files to remove lyrics from.")
            return
        rows = sorted(set(i.row() for i in sel))
        names = "\n".join(
            os.path.basename(self.file_table.item(r, 1).data(Qt.UserRole))
            for r in rows[:10])
        if len(rows) > 10:
            names += f"\n… and {len(rows) - 10} more"
        reply = QMessageBox.question(
            self, "Remove Lyrics",
            f"Remove embedded lyrics from {len(rows)} file(s)?\n\n{names}",
            QMessageBox.Yes | QMessageBox.No)
        if reply != QMessageBox.Yes:
            return
        prog = ProgressDialog("Removing Lyrics…", self)
        prog.set_range(0, len(rows))
        prog.show()
        ok = errors = 0
        for idx, row in enumerate(rows):
            fp = self.file_table.item(row, 1).data(Qt.UserRole)
            prog.set_value(idx)
            prog.set_task(f"Removing {idx + 1}/{len(rows)}")
            prog.set_detail(os.path.basename(fp))
            QApplication.processEvents()
            try:
                self._remove_lyrics_from_file(fp)
                ok += 1
                self._log(f"Lyrics removed: {os.path.basename(fp)}")
                if fp == self.current_file_path:
                    self.field_lyrics.clear()
            except Exception as e:
                errors += 1
                self._log(f"Lyrics remove error {os.path.basename(fp)}: {e}")
        prog.set_value(len(rows))
        prog.close()
        QMessageBox.information(self, "Remove Lyrics Complete",
                                f"Lyrics removed: {ok}  |  Errors: {errors}")

    def on_file_selected_from_table(self):
        sel = self.file_table.selectedItems()
        if not sel:
            return
        row = sel[0].row()
        fp = self.file_table.item(row, 1).data(Qt.UserRole)
        if fp:
            self.load_metadata(fp)

    # ── Artwork ──────────────────────────────
    def display_artwork(self, data):
        self.current_artwork_data = data
        self.art_deleted = False
        px = QPixmap()
        px.loadFromData(data)
        self.lbl_album_art.setPixmap(px.scaled(220, 220, Qt.KeepAspectRatio, Qt.SmoothTransformation))

    def remove_artwork(self):
        self.current_artwork_data = None
        self.art_deleted = True
        self.lbl_album_art.clear()
        self.lbl_album_art.setText("No Artwork\n(Will be removed on Save)")

    def set_custom_cover_art(self):
        fp, _ = QFileDialog.getOpenFileName(
            self, "Select Cover Art", QDir.homePath(),
            "Images (*.jpg *.jpeg *.png *.bmp *.webp)")
        if not fp:
            return
        try:
            with open(fp, "rb") as f:
                data = f.read()
            self.display_artwork(data)
            self.status_bar.showMessage(f"Custom art loaded: {os.path.basename(fp)}", 4000)
            self._log(f"Custom art loaded: {os.path.basename(fp)}")
        except Exception as e:
            QMessageBox.critical(self, "Error", str(e))

    # ── Load Metadata ─────────────────────────
    def load_metadata(self, file_path):
        self.current_file_path = file_path
        self.current_artwork_data = None
        self.art_deleted = False

        # media_engine.PlayerEngine gak punya "setSource()" -- ganti file
        # berarti tutup instance lama (lepas handle + thread decode-nya)
        # terus buka instance baru buat file_path ini lewat _open_player()
        # (gak dipaksa berhasil -- kalau media_engine gak ada / file gagal
        # dibuka, self.player tetap None dan tombol play dinonaktifkan di
        # bawah, edit tag lain tetap jalan seperti biasa).
        self._close_player()
        self._open_player(file_path)
        self.btn_play_pause.setIcon(self.style().standardIcon(QStyle.SP_MediaPlay))
        self.btn_play_pause.setText("Play")
        self.btn_play_pause.setEnabled(self.player is not None)
        self.seek_slider.setEnabled(self.player is not None)
        self.seek_slider.setValue(0)
        self.lbl_time.setText("0:00")

        self.field_title.clear(); self.field_artist.clear()
        self.field_album.clear(); self.field_year.clear()
        self.field_genre.clear(); self.field_track.clear()
        self.field_lyrics.clear()
        self.lbl_album_art.clear(); self.lbl_album_art.setText("No Artwork")
        self.lbl_bitrate.setText("—"); self.lbl_samplerate.setText("—")
        self.lbl_bpm.setText("—"); self.lbl_format.setText("—")

        try:
            try:
                self.audio_file = mutagen.File(file_path, easy=True)
                if self.audio_file is None:
                    raise ValueError("Unsupported format")
                if self.audio_file.tags is None:
                    self.audio_file.add_tags()
            except Exception:
                self.audio_file = mutagen.File(file_path)
                if getattr(self.audio_file, 'tags', None) is None:
                    self.audio_file.add_tags()

            tags = self.audio_file.tags or {}
            self.field_title.setText(tags.get('title',  [''])[0])
            self.field_artist.setText(tags.get('artist', [''])[0])
            self.field_album.setText(tags.get('album',  [''])[0])
            yr = tags.get('date', tags.get('year', ['']))[0]
            self.field_year.setText(str(yr))
            self.field_genre.setText(tags.get('genre',       [''])[0])
            self.field_track.setText(str(tags.get('tracknumber', [''])[0]))

            # Audio info
            info = getattr(self.audio_file, 'info', None)
            if info:
                br = getattr(info, 'bitrate', 0)
                sr = getattr(info, 'sample_rate', 0)
                self.lbl_bitrate.setText(f"{br} kbps" if br else "—")
                self.lbl_samplerate.setText(f"{sr} Hz" if sr else "—")
            ext = file_path.lower().split('.')[-1].upper()
            self.lbl_format.setText(ext)

            # Art + lyrics
            ext_low = file_path.lower().split('.')[-1]
            try:
                if ext_low == 'mp3':
                    id3 = ID3(file_path)
                    apic = id3.getall('APIC')
                    if apic: self.display_artwork(apic[0].data)
                    for k in id3.keys():
                        if k.startswith('USLT'):
                            self.field_lyrics.setPlainText(id3[k].text); break
                elif ext_low == 'm4a':
                    mp4 = MP4(file_path)
                    covr = mp4.tags.get('covr')
                    if covr: self.display_artwork(covr[0])
                    lyr = mp4.tags.get('\xa9lyr')
                    if lyr: self.field_lyrics.setPlainText(lyr[0])
                elif ext_low == 'flac':
                    flac = FLAC(file_path)
                    if flac.pictures: self.display_artwork(flac.pictures[0].data)
                    lyr = flac.get('lyrics') or flac.get('unsyncedlyrics')
                    if lyr: self.field_lyrics.setPlainText(lyr[0])
            except Exception:
                pass

            fn = os.path.basename(file_path)
            sz = os.path.getsize(file_path) / (1024*1024)
            dur = getattr(self.audio_file.info, 'length', 0) if hasattr(self.audio_file, 'info') else 0
            m, s = divmod(int(dur), 60)
            self.status_bar.showMessage(
                f"Editing: {fn}  |  {ext_low.upper()}  |  {sz:.2f} MB  |  {m}:{s:02d}")

            for a in [self.save_action, self.auto_tag_action, self.bpm_action]:
                a.setEnabled(True)
            for b in [self.btn_auto_tag, self.btn_fetch_art, self.btn_custom_art,
                      self.btn_remove_art, self.btn_fetch_lyrics, self.btn_detect_bpm]:
                b.setEnabled(True)

            self._snapshot()  # initial undo snapshot

        except Exception as e:
            self.current_file_path = None
            self.status_bar.showMessage(f"Error loading: {e}")
            self.save_action.setEnabled(False)

    # ── Save Metadata ─────────────────────────
    def save_metadata(self):
        if not self.current_file_path:
            QMessageBox.warning(self, "No File", "Select a file first.")
            return
        if self.audio_file is None:
            try:
                self.audio_file = mutagen.File(self.current_file_path, easy=True)
                if self.audio_file is None:
                    raise ValueError("Unsupported file.")
                if self.audio_file.tags is None:
                    self.audio_file.add_tags()
            except Exception as e:
                QMessageBox.critical(self, "Error", str(e)); return

        try:
            if self.audio_file.tags is None:
                self.audio_file.add_tags()
            year  = self.field_year.text().strip()
            track = self.field_track.text().strip()
            self.audio_file.tags['title']       = [self.field_title.text().strip()]
            self.audio_file.tags['artist']      = [self.field_artist.text().strip()]
            self.audio_file.tags['album']       = [self.field_album.text().strip()]
            self.audio_file.tags['date']        = [self.field_year.text()]
            self.audio_file.tags['genre']       = [self.field_genre.text().strip()]
            track = self.field_track.text().strip()
            # year
            if year:
                self.audio_file.tags['date'] = [year]
            else:
                self.audio_file.tags.pop('date', None)
            # track
            if track:
                self.audio_file.tags['tracknumber'] = [track]
            else:
                try:
                    del self.audio_file.tags['tracknumber'] 
                except:
                    pass
            
            self.audio_file.save()

            ext = self.current_file_path.lower().split('.')[-1]
            lyrics = self.field_lyrics.toPlainText().strip()

            if ext == 'mp3':
                a = ID3(self.current_file_path)
                if self.art_deleted: a.delall("APIC")
                elif self.current_artwork_data:
                    a.delall("APIC")
                    a.add(APIC(encoding=3, mime='image/jpeg', type=3,
                               desc='Cover', data=self.current_artwork_data))
                a.delall("USLT")
                if lyrics: a.add(USLT(encoding=3, lang='eng', desc='', text=lyrics))
                a.save()
            elif ext == 'm4a':
                a = MP4(self.current_file_path)
                if self.art_deleted: a.pop('covr', None)
                elif self.current_artwork_data:
                    a['covr'] = [MP4Cover(self.current_artwork_data, imageformat=MP4Cover.FORMAT_JPEG)]
                if lyrics: a['\xa9lyr'] = [lyrics]
                else: a.pop('\xa9lyr', None)
                a.save()
            elif ext == 'flac':
                a = FLAC(self.current_file_path)
                if self.art_deleted: a.clear_pictures()
                elif self.current_artwork_data:
                    pic = FLACPicture(); pic.type = 3
                    pic.mime = "image/jpeg"; pic.desc = "Front Cover"
                    pic.data = self.current_artwork_data
                    a.clear_pictures(); a.add_picture(pic)
                if lyrics: a['lyrics'] = [lyrics]
                else: a.pop('lyrics', None); a.pop('unsyncedlyrics', None)
                a.save()

            sel = self.file_table.selectedItems()
            if sel:
                r = sel[0].row()
                for col, val in [(2, self.field_title.text()),
                                 (3, self.field_artist.text()),
                                 (4, self.field_album.text()),
                                 (5, self.field_year.text()),
                                 (6, self.field_genre.text())]:
                    self.file_table.setItem(r, col, QTableWidgetItem(val))
                self._update_badge(r)

            self.audio_file = mutagen.File(self.current_file_path, easy=True)
            if self.audio_file and self.audio_file.tags is None:
                self.audio_file.add_tags()

            fn = os.path.basename(self.current_file_path)
            self.status_bar.showMessage(f"✅ Saved: {fn}", 4000)
            self._log(f"Saved: {fn}")
            self._snapshot()
            self.save_action.setEnabled(False)  # re-arm only on next edit

            if sel:
                nxt = sel[0].row() + 1
                if nxt < self.file_table.rowCount():
                    self.file_table.selectRow(nxt)
                    self.file_table.scrollToItem(self.file_table.item(nxt, 0))
                else:
                    self.status_bar.showMessage("✅ End of list — all done!", 4000)

        except Exception as e:
            err = traceback.format_exc()

            print(err)

            QMessageBox.critical(
                self,
                "Save Error",
                f"{e}\n\n{err}"
            )

    # ── Clear Fields ──────────────────────────
    def clear_fields(self):
        for f in [self.field_title, self.field_artist, self.field_album,
                  self.field_year, self.field_genre, self.field_track]:
            f.clear()
        self.field_lyrics.clear()
        self.lbl_album_art.clear(); self.lbl_album_art.setText("No Artwork")
        self.lbl_bitrate.setText("—"); self.lbl_samplerate.setText("—")
        self.lbl_bpm.setText("—"); self.lbl_format.setText("—")

    # ── Auto Tag ──────────────────────────────
    def auto_tag(self):
        sel = self.file_table.selectedItems()
        if not sel: return
        rows = sorted(set(i.row() for i in sel))
        prog = ProgressDialog("Auto Tagging Files…", self)
        prog.set_range(0, len(rows)); prog.show()
        ok = 0
        for idx, row in enumerate(rows):
            fp = self.file_table.item(row, 1).data(Qt.UserRole)
            t  = (self.file_table.item(row, 2) or QTableWidgetItem()).text()
            ar = (self.file_table.item(row, 3) or QTableWidgetItem()).text()
            q  = f"{t} {ar}".strip() or os.path.splitext(os.path.basename(fp))[0]
            prog.set_value(idx)
            prog.set_task(f"Processing {idx+1}/{len(rows)}")
            prog.set_detail(os.path.basename(fp))
            self.status_bar.showMessage(f"Auto-tagging: {os.path.basename(fp)}")
            try:
                r = requests.get(
                    f"https://itunes.apple.com/search?term={q}&entity=song&limit=1", timeout=5)
                if r.status_code == 200:
                    data = r.json()
                    if data['resultCount'] > 0:
                        tk = data['results'][0]
                        nt = tk.get('trackName', t)
                        na = tk.get('artistName', ar)
                        nb = tk.get('collectionName', "")
                        ny = (tk.get('releaseDate', '') or '')[:4]
                        ng = tk.get('primaryGenreName', "")
                        nn = str(tk.get('trackNumber', ''))
                        art = None
                        url100 = tk.get('artworkUrl100', '')
                        if url100:
                            ir = requests.get(url100.replace('100x100bb', '600x600bb'))
                            if ir.status_code == 200: art = ir.content
                        self._save_metadata_to_file(fp, nt, na, nb, ny, ng, nn, art)
                        for col, val in [(2,nt),(3,na),(4,nb),(5,ny),(6,ng)]:
                            self.file_table.setItem(row, col, QTableWidgetItem(val))
                        self._update_badge(row)
                        ok += 1
                        self._log(f"Auto-tagged: {os.path.basename(fp)}")
            except Exception as e:
                self._log(f"Error tagging {os.path.basename(fp)}: {e}")
        prog.set_value(len(rows)); prog.set_task("Done!")
        prog.set_detail(f"Tagged {ok}/{len(rows)} files."); prog.close()
        if self.current_file_path:
            self.load_metadata(self.current_file_path)
        self.auto_tag_action.setEnabled(True)
        self.btn_auto_tag.setEnabled(True)
        QMessageBox.information(self, "Auto Tag Complete",
                                f"Successfully tagged {ok} / {len(rows)} files.")
        self.status_bar.showMessage(f"Auto-tag complete — {ok}/{len(rows)} files.", 5000)

    def _save_metadata_to_file(self, fp, title, artist, album, year, genre, track, art=None):
        try:
            a = mutagen.File(fp, easy=True)
            if a is None: return
            if a.tags is None: a.add_tags()
            a.tags['title']=[title]; a.tags['artist']=[artist]; a.tags['album']=[album]
            a.tags['date']=[year]; a.tags['genre']=[genre]; a.tags['tracknumber']=[track]
            a.save()
            if art:
                ext = fp.lower().split('.')[-1]
                if ext == 'mp3':
                    i = ID3(fp); i.delall("APIC")
                    i.add(APIC(encoding=3, mime='image/jpeg', type=3, desc='Cover', data=art))
                    i.save()
                elif ext == 'm4a':
                    m = MP4(fp)
                    m['covr'] = [MP4Cover(art, imageformat=MP4Cover.FORMAT_JPEG)]; m.save()
                elif ext == 'flac':
                    f = FLAC(fp); p = FLACPicture()
                    p.type=3; p.mime='image/jpeg'; p.desc='Front Cover'; p.data=art
                    f.clear_pictures(); f.add_picture(p); f.save()
        except Exception as e:
            self._log(f"Background save error: {e}")

    # ── Batch Rename ──────────────────────────
    def batch_rename(self):
        sel = self.file_table.selectedItems()
        if not sel:
            QMessageBox.warning(self, "No Selection", "Select files to rename.")
            return
        rows_data = []
        seen = set()
        for item in sel:
            row = item.row()
            if row in seen: continue
            seen.add(row)
            fp = self.file_table.item(row, 1).data(Qt.UserRole)
            rows_data.append({
                "path": fp,
                "filename": os.path.basename(fp),
                "title":  (self.file_table.item(row, 2) or QTableWidgetItem()).text(),
                "artist": (self.file_table.item(row, 3) or QTableWidgetItem()).text(),
                "album":  (self.file_table.item(row, 4) or QTableWidgetItem()).text(),
                "year":   (self.file_table.item(row, 5) or QTableWidgetItem()).text(),
                "genre":  (self.file_table.item(row, 6) or QTableWidgetItem()).text(),
                "tracknumber": "",
            })
        dlg = BatchRenameDialog(rows_data, self)
        if dlg.exec() != QDialog.Accepted:
            return
        pairs = dlg.get_rename_pairs()
        ok = 0; errors = []
        for old, new in pairs:
            if old == new: continue
            if os.path.exists(new):
                errors.append(f"Exists: {os.path.basename(new)}")
                continue
            try:
                os.rename(old, new)
                ok += 1
                self._log(f"Renamed: {os.path.basename(old)} → {os.path.basename(new)}")
            except Exception as e:
                errors.append(str(e))
        if errors:
            QMessageBox.warning(self, "Rename Errors",
                                f"{ok} file(s) renamed.\nErrors:\n" + "\n".join(errors[:10]))
        else:
            QMessageBox.information(self, "Batch Rename",
                                    f"{ok} file(s) renamed successfully.")
        if self.current_folder:
            self.populate_file_table(self.current_folder)

    # ── Export CSV ────────────────────────────
    def export_csv(self):
        if not self._cached_rows:
            QMessageBox.warning(self, "No Data", "Load a folder first.")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "Export Metadata to CSV", QDir.homePath(), "CSV Files (*.csv)")
        if not path:
            return
        fields = ["filename", "title", "artist", "album", "year", "genre", "path"]
        try:
            with open(path, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
                w.writeheader()
                w.writerows(self._cached_rows)
            self.status_bar.showMessage(f"Exported {len(self._cached_rows)} rows → {path}", 5000)
            self._log(f"Exported CSV: {path}")
        except Exception as e:
            QMessageBox.critical(self, "Export Error", str(e))

    # ── Import CSV ────────────────────────────
    def import_csv(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "Import Metadata from CSV", QDir.homePath(), "CSV Files (*.csv)")
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                rows = list(reader)
        except Exception as e:
            QMessageBox.critical(self, "Import Error", str(e))
            return

        prog = ProgressDialog("Importing Metadata…", self)
        prog.set_range(0, len(rows)); prog.show()
        ok = 0
        for idx, row in enumerate(rows):
            fp = row.get("path", "")
            if not os.path.exists(fp):
                prog.set_value(idx + 1); continue
            prog.set_task(f"Importing {idx+1}/{len(rows)}")
            prog.set_detail(os.path.basename(fp))
            try:
                self._save_metadata_to_file(
                    fp,
                    row.get("title",""), row.get("artist",""), row.get("album",""),
                    row.get("year",""),  row.get("genre",""),  "", None)
                ok += 1
                self._log(f"Imported: {os.path.basename(fp)}")
            except Exception as e:
                self._log(f"Import error {os.path.basename(fp)}: {e}")
            prog.set_value(idx + 1)
        prog.close()
        if self.current_folder:
            self.populate_file_table(self.current_folder)
        QMessageBox.information(self, "Import Complete",
                                f"Successfully imported {ok}/{len(rows)} files.")

    # ── Find Duplicates ───────────────────────
    def find_duplicates(self):
        if not self._cached_rows:
            QMessageBox.warning(self, "No Data", "Load a folder first.")
            return
        seen = {}
        dupes = []
        for r in self._cached_rows:
            key = (r.get("title","").lower().strip(),
                   r.get("artist","").lower().strip())
            if key in seen:
                dupes.append((seen[key], r))
            else:
                seen[key] = r

        if not dupes:
            QMessageBox.information(self, "No Duplicates",
                                    "No duplicate title+artist combinations found.")
            return

        dlg = QDialog(self)
        dlg.setWindowTitle(f"Duplicates Found — {len(dupes)} pair(s)")
        dlg.setMinimumSize(600, 400)
        lay = QVBoxLayout(dlg)
        lay.addWidget(QLabel(f"Found {len(dupes)} duplicate pair(s) (same Title + Artist):"))
        tbl = QTableWidget(len(dupes)*2, 3)
        tbl.setHorizontalHeaderLabels(["Filename", "Title", "Artist"])
        tbl.horizontalHeader().setStretchLastSection(True)
        tbl.setEditTriggers(QAbstractItemView.NoEditTriggers)
        for i, (a, b) in enumerate(dupes):
            for j, row in enumerate([a, b]):
                ri = i*2 + j
                tbl.setItem(ri, 0, QTableWidgetItem(row.get("filename","")))
                tbl.setItem(ri, 1, QTableWidgetItem(row.get("title","")))
                tbl.setItem(ri, 2, QTableWidgetItem(row.get("artist","")))
                if j == 0:
                    for c in range(3):
                        it = tbl.item(ri, c)
                        if it: it.setBackground(QColor(60, 40, 40))
        lay.addWidget(tbl)
        btn = QPushButton("Close")
        btn.clicked.connect(dlg.accept)
        lay.addWidget(btn)
        dlg.exec()
        self._log(f"Duplicate scan: {len(dupes)} pair(s) found")

    # ── Missing Tags Filter ───────────────────
    def filter_missing_tags(self):
        if not self._cached_rows:
            return
        dlg = QDialog(self)
        dlg.setWindowTitle("Missing Tags Report")
        dlg.setMinimumSize(560, 420)
        lay = QVBoxLayout(dlg)

        # Which tags to check
        chk_layout = QHBoxLayout()
        chk_layout.addWidget(QLabel("Show files missing: "))
        checks = {}
        for tag in ["title","artist","album","year","genre"]:
            cb = QCheckBox(tag.capitalize())
            cb.setChecked(True)
            checks[tag] = cb
            chk_layout.addWidget(cb)
        lay.addLayout(chk_layout)

        tbl = QTableWidget()
        tbl.setColumnCount(6)
        tbl.setHorizontalHeaderLabels(["Filename","Title","Artist","Album","Year","Genre"])
        tbl.horizontalHeader().setStretchLastSection(True)
        tbl.setEditTriggers(QAbstractItemView.NoEditTriggers)
        lay.addWidget(tbl)

        def refresh():
            required = [tag for tag, cb in checks.items() if cb.isChecked()]
            missing = [r for r in self._cached_rows
                       if any(not r.get(tag,"") for tag in required)]
            tbl.setRowCount(len(missing))
            for i, r in enumerate(missing):
                tbl.setItem(i, 0, QTableWidgetItem(r.get("filename","")))
                for j, tag in enumerate(["title","artist","album","year","genre"]):
                    val = r.get(tag,"")
                    item = QTableWidgetItem(val)
                    if not val:
                        item.setBackground(QColor(80, 30, 30))
                    tbl.setItem(i, j+1, item)
            lbl_count.setText(f"{len(missing)} file(s) with missing tags")

        lbl_count = QLabel("")
        lay.addWidget(lbl_count)
        for cb in checks.values():
            cb.stateChanged.connect(refresh)
        refresh()

        btn = QPushButton("Close")
        btn.clicked.connect(dlg.accept)
        lay.addWidget(btn)
        dlg.exec()

    # ── Statistics Dashboard ──────────────────
    def show_stats(self):
        if not self._cached_rows:
            QMessageBox.warning(self, "No Data", "Load a folder first.")
            return
        dlg = StatsDashboard(self._cached_rows, self)
        dlg.exec()
        self._log("Opened statistics dashboard")

    # ── BPM Detection ─────────────────────────
    def detect_bpm(self):
        if not self.current_file_path:
            return
        if not FFMPEG_AVAILABLE:
            QMessageBox.warning(self, "media_engine Not Available",
                                "The media_engine native module is not available, "
                                "so BPM detection is disabled.\n\n"
                                "Make sure the app was built with the media_engine "
                                "module included.")
            return
        self.lbl_bpm.setText("Analyzing…")
        self.btn_detect_bpm.setEnabled(False)
        QApplication.setOverrideCursor(Qt.WaitCursor)
        QApplication.processEvents()
        try:
            bpm = _detect_bpm_media_engine(self.current_file_path)
            self.lbl_bpm.setText(f"{bpm:.1f} BPM")
            self.status_bar.showMessage(f"BPM detected: {bpm:.1f}", 5000)
            self._log(f"BPM: {os.path.basename(self.current_file_path)} → {bpm:.1f}")
        except Exception as e:
            self.lbl_bpm.setText("Error")
            self._log(f"BPM error: {e}")
        finally:
            self.btn_detect_bpm.setEnabled(True)
            QApplication.restoreOverrideCursor()

    # ── Processing Queue ─────────────────────
    def add_to_queue(self):
        sel = self.file_table.selectedItems()
        if not sel: return
        seen = set()
        for item in sel:
            row = item.row()
            if row in seen: continue
            seen.add(row)
            fp = self.file_table.item(row, 1).data(Qt.UserRole)
            fn = os.path.basename(fp)
            # Avoid dupes in queue
            existing = [self.queue_list.item(i).data(Qt.UserRole)
                        for i in range(self.queue_list.count())]
            if fp not in existing:
                qi = QListWidgetItem(fn)
                qi.setData(Qt.UserRole, fp)
                self.queue_list.addItem(qi)
        self._log(f"Added {len(seen)} file(s) to queue")

    def run_queue(self):
        if self.queue_list.count() == 0:
            QMessageBox.information(self, "Empty Queue", "Queue is empty.")
            return
        prog = ProgressDialog("Processing Queue…", self)
        prog.set_range(0, self.queue_list.count()); prog.show()
        ok = 0
        paths = [self.queue_list.item(i).data(Qt.UserRole)
                 for i in range(self.queue_list.count())]
        for idx, fp in enumerate(paths):
            prog.set_value(idx)
            prog.set_task(f"Auto-tagging {idx+1}/{len(paths)}")
            prog.set_detail(os.path.basename(fp))
            fn = os.path.basename(fp)
            q = os.path.splitext(fn)[0]
            try:
                r = requests.get(
                    f"https://itunes.apple.com/search?term={q}&entity=song&limit=1", timeout=5)
                if r.status_code == 200:
                    data = r.json()
                    if data['resultCount'] > 0:
                        tk = data['results'][0]
                        art = None
                        url100 = tk.get('artworkUrl100', '')
                        if url100:
                            ir = requests.get(url100.replace('100x100bb','600x600bb'))
                            if ir.status_code == 200: art = ir.content
                        self._save_metadata_to_file(
                            fp,
                            tk.get('trackName',''), tk.get('artistName',''),
                            tk.get('collectionName',''),
                            (tk.get('releaseDate','') or '')[:4],
                            tk.get('primaryGenreName',''),
                            str(tk.get('trackNumber','')), art)
                        ok += 1
                        self._log(f"Queue: tagged {fn}")
            except Exception as e:
                self._log(f"Queue error {fn}: {e}")
        prog.set_value(len(paths)); prog.close()
        self.queue_list.clear()
        if self.current_folder:
            self.populate_file_table(self.current_folder)
        QMessageBox.information(self, "Queue Complete",
                                f"Processed {ok}/{len(paths)} files from queue.")

    # ── Lyrics (LRCLIB exact → LRCLIB search → Musixmatch) ──
    def fetch_lyrics(self):
        title  = self.field_title.text().strip()
        artist = self.field_artist.text().strip()
        album  = self.field_album.text().strip()
        if not title or not artist:
            QMessageBox.warning(self, "Missing Info", "Title and Artist are required.")
            return
        dur = getattr(self.audio_file.info, 'length', 0) if self.audio_file else 0
        self.btn_fetch_lyrics.setText("Searching…")
        self.btn_fetch_lyrics.setEnabled(False)
        QApplication.setOverrideCursor(Qt.WaitCursor)
        QApplication.processEvents()
        lyrics = None
        source = ""
        try:
            # ── Source 1: LRCLIB (exact match) ────
            if dur > 0:
                try:
                    r = requests.get("https://lrclib.net/api/get", timeout=7,
                                     params={'track_name': title, 'artist_name': artist,
                                             'album_name': album, 'duration': int(dur)})
                    if r.status_code == 200:
                        d = r.json()
                        lyrics = d.get('syncedLyrics') or d.get('plainLyrics')
                        if lyrics: source = "LRCLIB"
                except Exception:
                    pass

            # ── Source 2: LRCLIB (broad search) ───
            if not lyrics:
                try:
                    r = requests.get("https://lrclib.net/api/search", timeout=7,
                                     params={'track_name': title, 'artist_name': artist})
                    if r.status_code == 200:
                        d = r.json()
                        if d:
                            lyrics = d[0].get('syncedLyrics') or d[0].get('plainLyrics')
                            if lyrics: source = "LRCLIB"
                except Exception:
                    pass

            # ── Source 3: Musixmatch (unofficial widget API) ──
            if not lyrics:
                try:
                    r = requests.get(
                        "https://api.musixmatch.com/ws/1.1/matcher.lyrics.get",
                        params={
                            "q_track":  title,
                            "q_artist": artist,
                            "apikey":   "b25b959554ed76058ac220b7b2e0a026",
                            "format":   "json"
                        }, timeout=7)
                    if r.status_code == 200:
                        body = r.json().get("message", {}).get("body", {})
                        lyr  = body.get("lyrics", {}).get("lyrics_body", "")
                        if lyr and "******* This Lyrics" not in lyr:
                            lyrics = lyr.strip()
                            source = "Musixmatch"
                except Exception:
                    pass

            if lyrics:
                self.field_lyrics.setPlainText(lyrics)
                self.status_bar.showMessage(f"Lyrics fetched from {source}!", 5000)
                self.tabs.setCurrentIndex(1)
                self._log(f"Lyrics fetched ({source}): {title} — {artist}")
            else:
                QMessageBox.information(self, "Not Found",
                    "No lyrics found on LRCLIB or Musixmatch.\n\n"
                    "Try editing the Title / Artist fields and searching again.")
        except Exception as e:
            QMessageBox.critical(self, "Network Error", str(e))
        finally:
            self.btn_fetch_lyrics.setText("Fetch Lyrics from LRCLIB")
            self.btn_fetch_lyrics.setEnabled(True)
            QApplication.restoreOverrideCursor()

    # ── Cover Art (iTunes → MusicBrainz → Last.fm) ───────────
    def fetch_itunes_art(self):
        artist = self.field_artist.text().strip()
        album  = self.field_album.text().strip()
        title  = self.field_title.text().strip()
        if not artist:
            QMessageBox.warning(self, "Missing Info", "Artist field is required."); return
        self.btn_fetch_art.setText("Searching…")
        self.btn_fetch_art.setEnabled(False)
        QApplication.setOverrideCursor(Qt.WaitCursor)
        QApplication.processEvents()
        art_data = None
        source   = ""
        try:
            # ── Source 1: iTunes ──────────────────
            query = f"{artist} {album or title}".strip()
            try:
                r = requests.get(
                    "https://itunes.apple.com/search",
                    params={"term": query, "entity": "album", "limit": 1},
                    timeout=6)
                if r.status_code == 200:
                    d = r.json()
                    if d.get('resultCount', 0) > 0:
                        url = d['results'][0]['artworkUrl100'].replace(
                            '100x100bb', '600x600bb')
                        ir = requests.get(url, timeout=6)
                        if ir.status_code == 200:
                            art_data = ir.content
                            source = "iTunes"
            except Exception:
                pass

            # ── Source 2: MusicBrainz + Cover Art Archive ──
            if not art_data:
                try:
                    headers = {"User-Agent": "AdvancedTagEditor/4.1 (macanangkasa@local)"}
                    r = requests.get(
                        "https://musicbrainz.org/ws/2/release",
                        params={
                            "query": f'artist:"{artist}" release:"{album or title}"',
                            "fmt": "json", "limit": 1
                        },
                        headers=headers, timeout=7)
                    if r.status_code == 200:
                        releases = r.json().get("releases", [])
                        if releases:
                            mbid = releases[0]["id"]
                            caa = requests.get(
                                f"https://coverartarchive.org/release/{mbid}/front",
                                timeout=7, allow_redirects=True)
                            if caa.status_code == 200:
                                art_data = caa.content
                                source = "MusicBrainz / Cover Art Archive"
                except Exception:
                    pass

            # ── Source 3: Last.fm ─────────────────
            if not art_data:
                try:
                    lfm = requests.get(
                        "https://ws.audioscrobbler.com/2.0/",
                        params={
                            "method":  "album.getinfo",
                            "artist":  artist,
                            "album":   album or title,
                            "api_key": "b25b959554ed76058ac220b7b2e0a026",
                            "format":  "json"
                        }, timeout=7)
                    if lfm.status_code == 200:
                        images = lfm.json().get("album", {}).get("image", [])
                        for img in reversed(images):
                            url = img.get("#text", "")
                            if url:
                                ir = requests.get(url, timeout=6)
                                if ir.status_code == 200 and len(ir.content) > 1000:
                                    art_data = ir.content
                                    source = "Last.fm"
                                    break
                except Exception:
                    pass

            if art_data:
                self.display_artwork(art_data)
                self.status_bar.showMessage(f"Cover art fetched from {source}", 5000)
                self._log(f"Cover art fetched ({source}): {artist} — {album or title}")
            else:
                QMessageBox.information(self, "Not Found",
                    "No cover art found on iTunes, MusicBrainz, or Last.fm.\n\n"
                    "Try using 'Custom Art…' to load an image manually.")
        except Exception as e:
            QMessageBox.critical(self, "Error", str(e))
        finally:
            self.btn_fetch_art.setText("Fetch Art (iTunes)")
            self.btn_fetch_art.setEnabled(True)
            QApplication.restoreOverrideCursor()

    # ── Keyboard shortcuts dialog ─────────────
    def show_shortcuts(self):
        ShortcutsDialog(self).exec()

    # ── About ────────────────────────────────
    def show_about(self):
        html = """
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
            <h2 style="color: #2980b9;">Advanced Tag Editor</h2>
            <b>Enterprise Edition v4.5.0</b>
            <hr>
            <p>Professional-grade audio metadata management for archivists, engineers,
            and audiophiles.</p>
            <p><b>v4.5.0 Enterprise Features:</b></p>
            <ul>
                <li>Batch rename with template engine</li>
                <li>Undo / Redo per-file history stack</li>
                <li>Export / Import metadata via CSV</li>
                <li>Tag-completeness colour badges</li>
                <li>Drag-and-drop files onto table</li>
                <li>Duplicate detector</li>
                <li>Missing-tag filter & report</li>
                <li>Statistics Dashboard</li>
                <li>Audio analysis: bitrate, sample-rate, BPM (media_engine)</li>
                <li>QDockWidget panels: Activity Log, Processing Queue</li>
                <li>Ribbon-style labelled toolbar sections</li>
                <li>Column-layout presets + live search filter</li>
                <li>Sortable table columns</li>
                <li>Keyboard shortcuts overlay (F1)</li>
                <li>Light / Dark themes with QSettings persistence</li>
            </ul>
            <div style="text-align: center; font-size: 11px; color: #666;">
                <i>&copy; Macan Angkasa. All Rights Reserved.</i>
            </div>
        </div>"""
        QMessageBox.about(self, "About Advanced Tag Editor", html)


# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Advanced Tag Editor")
    parser.add_argument("--file", help="Audio file to open right away (sent from Macan Media Player)")
    parser.add_argument("--inbox", help="Inbox folder watched for extra files while the editor is open")
    args, qt_args = parser.parse_known_args()

    app = QApplication([sys.argv[0]] + qt_args)
    app.setStyle("Fusion")
    window = AdvancedTagEditor()
    window.show()
    if args.inbox:
        window.start_inbox_watch(args.inbox)
    if args.file:
        QTimer.singleShot(0, lambda: window.open_external_file(args.file))
    sys.exit(app.exec())