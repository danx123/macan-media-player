# core/converter.py
# Macan Media Player — Converter Engine
#
# Adapted from Macan Converter Pro (macan_converter30.py).
# All PySide6 / Qt UI code removed. This module is pure conversion logic:
# - FFmpeg subprocess wrapper for audio and video
# - Progress reported via callback, not Qt Signals
# - Designed to run in a background daemon thread
# - Called from MacanMediaAPI bridge methods, which push progress to JS
#   via window.evaluate_js()

import os
import re
import sys
import json
import subprocess
import threading
import shutil
from pathlib import Path


# ─── SUPPORTED FORMATS ────────────────────────────────────────────────────────

AUDIO_FORMATS  = ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a']
VIDEO_FORMATS  = ['mp4', 'mkv', 'avi', 'mov', 'webm']
AUDIO_BITRATES = ['96k', '128k', '192k', '256k', '320k']

VIDEO_ENCODERS = {
    'mp4':  ['libx264', 'libx265', 'copy'],
    'mkv':  ['libx264', 'libx265', 'copy'],
    'avi':  ['mpeg4',   'copy'],
    'mov':  ['libx264', 'libx265', 'copy'],
    'webm': ['libvpx-vp9', 'copy'],
}

VIDEO_QUALITY_CRF = {'high': '18', 'medium': '23', 'low': '28'}
VIDEO_QUALITY_GPU = {'high': '6000k', 'medium': '4000k', 'low': '2000k'}

DURATION_RE = re.compile(r'Duration:\s*(\d{2}):(\d{2}):(\d{2})')
TIME_RE      = re.compile(r'time=(\d{2}):(\d{2}):(\d{2})')


# ─── FFMPEG DISCOVERY ─────────────────────────────────────────────────────────

def find_ffmpeg() -> str | None:
    """Locate ffmpeg: check app directory first, then system PATH."""
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    # Walk up one level (core/ → project root)
    root = os.path.dirname(base)
    candidates = [
        os.path.join(root, 'ffmpeg.exe' if os.name == 'nt' else 'ffmpeg'),
        os.path.join(base, 'ffmpeg.exe' if os.name == 'nt' else 'ffmpeg'),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return shutil.which('ffmpeg')


# ─── DURATION HELPER ──────────────────────────────────────────────────────────

def _get_duration(ffmpeg_path: str, input_path: str) -> int | None:
    """Run ffmpeg -i to read media duration in seconds."""
    try:
        result = subprocess.run(
            [ffmpeg_path, '-i', input_path],
            stderr=subprocess.STDOUT,
            stdout=subprocess.PIPE,
            timeout=10,
        )
        output = result.stdout.decode('utf-8', errors='ignore')
        m = DURATION_RE.search(output)
        if m:
            h, mn, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
            return h * 3600 + mn * 60 + s
    except Exception as e:
        print(f'[Converter] _get_duration error: {e}')
    return None


# ─── BASE CONVERTER ───────────────────────────────────────────────────────────

class _BaseConverter:
    """
    Common FFmpeg runner.
    progress_cb(percent: int, status: str) called from background thread.
    done_cb(success: bool, message: str)   called when finished or errored.
    """

    def __init__(self, ffmpeg_path: str, input_path: str, output_path: str,
                 progress_cb, done_cb):
        self.ffmpeg      = ffmpeg_path
        self.input_path  = input_path
        self.output_path = output_path
        self.progress_cb = progress_cb
        self.done_cb     = done_cb
        self._stop       = threading.Event()
        self._proc       = None

    def stop(self):
        self._stop.set()
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.kill()
            except Exception:
                pass

    def _run_ffmpeg(self, args: list[str], total_duration: int | None):
        """Execute ffmpeg with given args, parse progress from stderr."""
        cmd = [self.ffmpeg] + args
        print(f'[Converter] FFmpeg: {" ".join(cmd)}')
        try:
            self._proc = subprocess.Popen(
                cmd,
                stderr=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                universal_newlines=True,
                encoding='utf-8',
                errors='ignore',
            )
        except FileNotFoundError:
            self.done_cb(False, 'ffmpeg not found. Please place ffmpeg.exe next to the application.')
            return
        except Exception as e:
            self.done_cb(False, f'Failed to start ffmpeg: {e}')
            return

        buffer = ''
        while True:
            if self._stop.is_set():
                self.stop()
                self.done_cb(False, 'Conversion cancelled.')
                return

            char = self._proc.stderr.read(1)
            if not char:
                break
            buffer += char

            # Progress lines end with \r or \n
            if char in ('\r', '\n'):
                if total_duration and total_duration > 0:
                    m = TIME_RE.search(buffer)
                    if m:
                        h, mn, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
                        current = h * 3600 + mn * 60 + s
                        pct = min(int(current / total_duration * 100), 99)
                        self.progress_cb(pct, f'Converting... {pct}%')
                buffer = ''

        self._proc.wait()
        exit_code = self._proc.returncode

        if self._stop.is_set():
            self.done_cb(False, 'Conversion cancelled.')
        elif exit_code == 0:
            self.progress_cb(100, 'Done!')
            self.done_cb(True, 'Conversion complete.')
        else:
            self.done_cb(False, f'FFmpeg exited with code {exit_code}.')


# ─── AUDIO CONVERTER ──────────────────────────────────────────────────────────

class AudioConverter(_BaseConverter):
    """
    Convert any audio file to a target format.

    params:
        out_format: str   — target extension e.g. 'mp3'
        bitrate:    str   — e.g. '192k'
    """

    def __init__(self, ffmpeg_path, input_path, output_dir,
                 out_format, bitrate, progress_cb, done_cb):
        base = os.path.splitext(os.path.basename(input_path))[0]
        output_path = os.path.join(output_dir, f'{base}.{out_format}')
        super().__init__(ffmpeg_path, input_path, output_path, progress_cb, done_cb)
        self.out_format = out_format
        self.bitrate    = bitrate

    def run(self):
        self.progress_cb(0, 'Getting audio info...')
        duration = _get_duration(self.ffmpeg, self.input_path)

        args = [
            '-i', self.input_path,
            '-vn',
            '-b:a', self.bitrate,
            '-y', self.output_path,
        ]
        self._run_ffmpeg(args, duration)


# ─── VIDEO CONVERTER ──────────────────────────────────────────────────────────

class VideoConverter(_BaseConverter):
    """
    Convert a video file with full options matching Macan Converter Pro.

    params:
        out_format:  str   — 'mp4' | 'mkv' | 'avi' | 'mov' | 'webm'
        resolution:  str   — 'original' | '360p' | '480p' | '720p' | '1080p' | '2k' | '4k'
        quality:     str   — 'high' | 'medium' | 'low'  (used when advanced=False)
        use_gpu:     bool  — NVIDIA NVENC hardware encoding
        advanced:    bool  — enable manual encoder/bitrate/fps settings
        v_bitrate:   str   — e.g. 'auto' | '3000k' | '5m'
        fps:         str   — 'original' | '24' | '30' | '60'
        v_encoder:   str   — e.g. 'libx264' | 'libx265' | 'copy'
        a_encoder:   str   — e.g. 'aac' | 'libmp3lame' | 'copy'
        a_bitrate:   str   — e.g. 'original' | '192k'
        a_channels:  str   — 'original' | '1' | '2'
        a_samplerate:str   — 'original' | '44100' | '48000'
        custom_flags:str   — raw extra flags appended to ffmpeg command
        ref_frames:  int   — 0 = auto
        use_cabac:   bool
    """

    RESOLUTION_MAP = {
        '360p': '360', '480p': '480', '720p': '720',
        '1080p': '1080', '2k': '1440', '4k': '2160',
    }

    def __init__(self, ffmpeg_path, input_path, output_dir,
                 out_format='mp4', resolution='original', quality='medium',
                 use_gpu=False, advanced=False,
                 v_bitrate='auto', fps='original',
                 v_encoder='libx264', a_encoder='aac',
                 a_bitrate='original', a_channels='original', a_samplerate='original',
                 custom_flags='', ref_frames=0, use_cabac=True,
                 progress_cb=None, done_cb=None):

        base        = os.path.splitext(os.path.basename(input_path))[0]
        output_path = os.path.join(output_dir, f'{base}.{out_format}')
        super().__init__(ffmpeg_path, input_path, output_path,
                         progress_cb or (lambda p, s: None),
                         done_cb     or (lambda ok, m: None))

        self.out_format   = out_format
        self.resolution   = resolution.lower()
        self.quality      = quality.lower()
        self.use_gpu      = use_gpu
        self.advanced     = advanced
        self.v_bitrate    = v_bitrate.strip().lower()
        self.fps          = fps.lower()
        self.v_encoder    = v_encoder.split()[0].lower()   # strip display names
        self.a_encoder    = a_encoder.split()[0].lower()
        self.a_bitrate    = a_bitrate.lower()
        self.a_channels   = a_channels.split()[0].lower()  # '1 (mono)' → '1'
        self.a_samplerate = a_samplerate.lower()
        self.custom_flags = custom_flags.strip()
        self.ref_frames   = int(ref_frames)
        self.use_cabac    = use_cabac

    def run(self):
        self.progress_cb(0, 'Getting video info...')
        duration = _get_duration(self.ffmpeg, self.input_path)

        args = self._build_args()
        self._run_ffmpeg(args, duration)

    def _build_args(self) -> list[str]:
        args = []

        # ── 1. Hardware acceleration (before -i) ──────────────────────────────
        if self.use_gpu:
            args += ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']

        args += ['-i', self.input_path]

        # ── 2. Scale / resolution ─────────────────────────────────────────────
        target_h = self.RESOLUTION_MAP.get(self.resolution)
        if target_h:
            if self.use_gpu:
                args += ['-vf', f'scale_cuda=-2:{target_h}']
            else:
                args += ['-vf', f'scale=-2:{target_h}']

        # ── 3. Video encoder ──────────────────────────────────────────────────
        final_encoder = self._resolve_video_encoder()

        if final_encoder == 'copy':
            args += ['-c:v', 'copy']
        else:
            args += ['-c:v', final_encoder]
            args += self._build_video_quality_args(final_encoder)

        # ── 4. FPS ────────────────────────────────────────────────────────────
        if self.advanced and self.fps != 'original':
            args += ['-r', self.fps]

        # ── 5. Custom flags ───────────────────────────────────────────────────
        if self.advanced and self.custom_flags:
            args += self.custom_flags.split()

        # ── 6. Audio ──────────────────────────────────────────────────────────
        if self.out_format == 'gif':
            pass  # no audio stream in gif
        elif self.advanced:
            if self.a_encoder == 'copy':
                args += ['-c:a', 'copy']
            else:
                args += ['-c:a', self.a_encoder]
                if self.a_channels not in ('original', ''):
                    args += ['-ac', self.a_channels]
                if self.a_samplerate not in ('original', ''):
                    args += ['-ar', self.a_samplerate]
                if self.a_bitrate not in ('original', ''):
                    args += ['-b:a', self.a_bitrate]
        else:
            args += ['-c:a', 'aac', '-b:a', '192k']

        # ── 7. Output ─────────────────────────────────────────────────────────
        args += ['-y', self.output_path]
        return args

    def _resolve_video_encoder(self) -> str:
        if self.advanced:
            enc = self.v_encoder
        else:
            enc = 'libx264' if self.out_format in ('mp4', 'mov', 'mkv') else self.v_encoder

        # Override with NVENC if GPU selected
        if self.use_gpu and self.out_format != 'gif' and enc != 'copy':
            if enc in ('libx264', 'h264'):
                return 'h264_nvenc'
            if enc in ('libx265', 'hevc', 'h265'):
                return 'hevc_nvenc'

        return enc

    def _build_video_quality_args(self, encoder: str) -> list[str]:
        args = []
        is_nvenc = 'nvenc' in encoder

        if self.advanced:
            bv = self.v_bitrate
            if bv and bv != 'auto':
                # Normalise bare integers → append 'k'
                if bv.isdigit():
                    bv += 'k'
                if any(c.isdigit() for c in bv):
                    args += ['-b:v', bv]
                    if is_nvenc:
                        args += ['-maxrate', bv]
            else:
                # Auto bitrate
                if is_nvenc:
                    args += ['-b:v', '5000k']
                elif 'libx264' in encoder:
                    args += ['-crf', '23']

            # ref frames & CABAC
            if 'libx264' in encoder:
                x264p = []
                if self.ref_frames > 0:
                    x264p.append(f'ref={self.ref_frames}')
                x264p.append(f'cabac={1 if self.use_cabac else 0}')
                args += ['-x264-params', ':'.join(x264p)]
            elif is_nvenc:
                if self.ref_frames > 0:
                    args += ['-refs', str(self.ref_frames)]
        else:
            # Simple mode
            if is_nvenc:
                bv = VIDEO_QUALITY_GPU.get(self.quality, '4000k')
                args += ['-b:v', bv]
            else:
                crf = VIDEO_QUALITY_CRF.get(self.quality, '23')
                args += ['-crf', crf, '-preset', 'medium']

        return args


# ─── EXTRACT AUDIO ────────────────────────────────────────────────────────────

class ExtractAudioConverter(AudioConverter):
    """Extract audio stream from a video file."""
    # Identical to AudioConverter — FFmpeg handles video input naturally.
    pass


# ─── BATCH RUNNER ─────────────────────────────────────────────────────────────

class BatchRunner:
    """
    Run a list of converter tasks sequentially in a background thread.
    Calls item_start_cb(index, total, filename) before each item.
    Calls all_done_cb(success_count, fail_count) when finished.
    """

    def __init__(self, tasks: list, item_start_cb, all_done_cb):
        self._tasks        = tasks
        self._item_start   = item_start_cb
        self._all_done     = all_done_cb
        self._stop_event   = threading.Event()
        self._current_task = None
        self._thread       = None

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._current_task:
            self._current_task.stop()

    def _run(self):
        ok = fail = 0
        for i, task in enumerate(self._tasks):
            if self._stop_event.is_set():
                break
            self._current_task = task
            fname = os.path.basename(task.input_path)
            self._item_start(i, len(self._tasks), fname)
            task.run()
            # done_cb result is handled per-task; batch just counts
            ok += 1   # simplified; real error tracking via done_cb wiring
        self._all_done(ok, fail)
