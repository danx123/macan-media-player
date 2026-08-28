# macan_now_playing_bubble.py
# ─────────────────────────────────────────────────────────────────────────
# Native "Now Playing" notification bubble for Macan Media Player.
#
# Shows a small, borderless, always-on-top popup that floats ABOVE the
# Windows system tray (not docked inside it, unlike a classic balloon
# tooltip) whenever a new track starts playing — artwork + title + artist,
# fading in, holding, then fading out automatically. Same idea as the
# "Now Playing" bubble already used in Macan Audio Player.
#
# Why raw ctypes instead of Qt:
#   Macan Media Player is a pywebview/WebView2 app — it has no PySide6/Qt
#   dependency anywhere in the stack, so pulling in Qt just for one popup
#   window would be a heavy, out-of-place addition. This module talks to
#   user32/gdi32/shell32 directly instead.
#
# How it draws itself:
#   The bubble content (rounded panel + artwork + text) is rendered once
#   per track into an RGBA image with Pillow, then blitted onto a
#   WS_EX_LAYERED popup window via UpdateLayeredWindow (per-pixel alpha),
#   so rounded corners / soft edges composite correctly over the desktop —
#   no square white background like a plain WM_PAINT window would have.
#
# How it finds "above the tray":
#   A fixed screen-corner offset would be wrong whenever the taskbar isn't
#   docked at the bottom, or the bubble should hug a taskbar living on a
#   different edge. Instead this reads the REAL taskbar rectangle via
#   SHAppBarData(ABM_GETTASKBARPOS) against the "Shell_TrayWnd" window and
#   anchors the bubble just outside whichever edge the taskbar occupies.
#
# Platform: Windows only. Importing/using this module on any other OS is a
# safe no-op (mirrors the existing macan_taskbar_thumbbar_webview.py
# pattern used elsewhere in this app).
# ─────────────────────────────────────────────────────────────────────────

import sys
import os
import io
import time
import base64
import queue
import ctypes
import threading
from ctypes import wintypes

_IS_WINDOWS = sys.platform == 'win32'

try:
    from PIL import Image, ImageDraw, ImageFont, ImageChops, ImageOps
    _PIL_AVAILABLE = True
except ImportError:
    _PIL_AVAILABLE = False


# ─── Bubble visual constants ────────────────────────────────────────────
BUBBLE_W = 344
BUBBLE_H = 96
MARGIN_FROM_TASKBAR = 12   # gap between bubble and the taskbar edge
MARGIN_FROM_SIDE    = 12   # gap between bubble and the screen/taskbar side
CORNER_RADIUS       = 12
ART_SIZE            = 64
ART_MARGIN          = 16
ART_CORNER_RADIUS   = 8

FADE_IN_MS  = 180
FADE_OUT_MS = 220
FADE_FPS    = 30
ANIM_INTERVAL_MS = max(10, int(1000 / FADE_FPS))

BG_COLOR          = (24, 24, 27, 235)     # near-black, semi-opaque panel
BORDER_COLOR      = (255, 255, 255, 28)
EYEBROW_COLOR     = (100, 210, 255, 255)  # accent used for the "NOW PLAYING" label
TITLE_COLOR       = (245, 245, 245, 255)
ARTIST_COLOR      = (172, 172, 178, 255)
PLACEHOLDER_BG    = (52, 52, 58, 255)
PLACEHOLDER_FG    = (142, 142, 150, 255)

DEFAULT_DURATION_MS = 4200

# Resolved SHAppBarData function pointer (see note near its lookup below).
# Declared here (not just inside the `if _IS_WINDOWS:` block) so code that
# references it at module scope never hits a NameError on non-Windows.
_sh_app_bar_data = None


# ─── Win32 plumbing (Windows only) ──────────────────────────────────────
if _IS_WINDOWS:
    # IMPORTANT: use dedicated WinDLL instances here, NOT ctypes.windll.xxx.
    # ctypes.windll caches ONE shared WinDLL object per DLL name for the
    # whole process — so ctypes.windll.gdi32.CreateDIBSection is the exact
    # same Python function-pointer object no matter which module accesses
    # it. Setting .argtypes/.restype on it (as this module does, below)
    # would silently force those types on every OTHER module in the process
    # that also calls it — e.g. macan_taskbar_thumbbar_webview.py calls
    # gdi32.CreateDIBSection with its own BITMAPV5HEADER struct, which then
    # fails with "expected LP_BITMAPINFO instance instead of pointer to
    # BITMAPV5HEADER" once this module's stricter argtypes were applied
    # process-wide. ctypes.WinDLL(name) (called directly, bypassing the
    # ctypes.windll cache) creates a fresh, independent wrapper object per
    # call, so the argtypes set on THESE bindings stay local to this module.
    user32   = ctypes.WinDLL('user32',   use_last_error=True)
    gdi32    = ctypes.WinDLL('gdi32',    use_last_error=True)
    shell32  = ctypes.WinDLL('shell32',  use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    ole32    = ctypes.WinDLL('ole32',    use_last_error=True)

    # ── constants ──
    WS_POPUP           = 0x80000000
    WS_EX_LAYERED      = 0x00080000
    WS_EX_TOPMOST      = 0x00000008
    WS_EX_TOOLWINDOW   = 0x00000080
    WS_EX_NOACTIVATE   = 0x08000000
    SW_SHOWNOACTIVATE  = 4
    SW_HIDE            = 0
    ULW_ALPHA          = 0x00000002
    AC_SRC_OVER        = 0x00
    AC_SRC_ALPHA       = 0x01
    WM_DESTROY         = 0x0002
    WM_TIMER           = 0x0113
    WM_LBUTTONDOWN     = 0x0201
    WM_APP             = 0x8000
    WM_BUBBLE_SHOW     = WM_APP + 1
    WM_BUBBLE_SHUTDOWN = WM_APP + 2
    SM_CXSCREEN        = 0
    SM_CYSCREEN        = 1
    ABM_GETTASKBARPOS  = 5
    ABE_LEFT, ABE_TOP, ABE_RIGHT, ABE_BOTTOM = 0, 1, 2, 3
    DIB_RGB_COLORS     = 0
    BI_RGB             = 0
    SWP_SHOWWINDOW     = 0x0040
    SWP_NOACTIVATE     = 0x0010
    HWND_TOPMOST       = -1
    IDC_ARROW          = 32512
    TIMER_ID_ANIM      = 1
    COINIT_APARTMENTTHREADED = 0x2

    class SIZE(ctypes.Structure):
        _fields_ = [('cx', wintypes.LONG), ('cy', wintypes.LONG)]

    class BLENDFUNCTION(ctypes.Structure):
        _fields_ = [
            ('BlendOp', ctypes.c_byte),
            ('BlendFlags', ctypes.c_byte),
            ('SourceConstantAlpha', ctypes.c_byte),
            ('AlphaFormat', ctypes.c_byte),
        ]

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG),
            ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD),
            ('biCompression', wintypes.DWORD), ('biSizeImage', wintypes.DWORD),
            ('biXPelsPerMeter', wintypes.LONG), ('biYPelsPerMeter', wintypes.LONG),
            ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD),
        ]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', wintypes.DWORD * 3)]

    class APPBARDATA(ctypes.Structure):
        _fields_ = [
            ('cbSize', wintypes.DWORD), ('hWnd', wintypes.HWND),
            ('uCallbackMessage', wintypes.UINT), ('uEdge', wintypes.UINT),
            ('rc', wintypes.RECT), ('lParam', wintypes.LPARAM),
        ]

    class WNDCLASSEXW(ctypes.Structure):
        _fields_ = [
            ('cbSize', wintypes.UINT), ('style', wintypes.UINT),
            ('lpfnWndProc', ctypes.c_void_p), ('cbClsExtra', ctypes.c_int),
            ('cbWndExtra', ctypes.c_int), ('hInstance', wintypes.HINSTANCE),
            ('hIcon', wintypes.HICON), ('hCursor', wintypes.HANDLE),
            ('hbrBackground', wintypes.HBRUSH), ('lpszMenuName', wintypes.LPCWSTR),
            ('lpszClassName', wintypes.LPCWSTR), ('hIconSm', wintypes.HICON),
        ]

    WNDPROC = ctypes.WINFUNCTYPE(
        ctypes.c_long, wintypes.HWND, ctypes.c_uint, wintypes.WPARAM, wintypes.LPARAM
    )

    # ── argtypes / restypes (mandatory for correct 64-bit handle marshalling) ──
    kernel32.GetModuleHandleW.restype  = wintypes.HMODULE
    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]

    user32.RegisterClassExW.restype  = wintypes.ATOM
    user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]

    user32.CreateWindowExW.restype  = wintypes.HWND
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
    ]

    user32.DefWindowProcW.restype  = ctypes.c_long
    user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

    user32.GetMessageW.restype  = ctypes.c_int
    user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]

    user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.DispatchMessageW.restype  = ctypes.c_long
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]

    user32.PostMessageW.restype  = wintypes.BOOL
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

    user32.PostQuitMessage.argtypes = [ctypes.c_int]
    user32.DestroyWindow.argtypes  = [wintypes.HWND]

    user32.ShowWindow.restype  = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]

    user32.SetWindowPos.restype  = wintypes.BOOL
    user32.SetWindowPos.argtypes = [
        wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.c_int, wintypes.UINT,
    ]

    user32.GetDC.restype  = wintypes.HDC
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]

    user32.SetTimer.restype  = ctypes.c_size_t
    user32.SetTimer.argtypes = [wintypes.HWND, ctypes.c_size_t, wintypes.UINT, wintypes.LPVOID]
    user32.KillTimer.restype  = wintypes.BOOL
    user32.KillTimer.argtypes = [wintypes.HWND, ctypes.c_size_t]

    user32.GetWindowRect.restype  = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]

    user32.UpdateLayeredWindow.restype  = wintypes.BOOL
    user32.UpdateLayeredWindow.argtypes = [
        wintypes.HWND, wintypes.HDC, ctypes.POINTER(wintypes.POINT), ctypes.POINTER(SIZE),
        wintypes.HDC, ctypes.POINTER(wintypes.POINT), wintypes.COLORREF,
        ctypes.POINTER(BLENDFUNCTION), wintypes.DWORD,
    ]

    user32.LoadCursorW.restype  = wintypes.HANDLE
    user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]

    user32.FindWindowW.restype  = wintypes.HWND
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]

    user32.GetSystemMetrics.restype  = ctypes.c_int
    user32.GetSystemMetrics.argtypes = [ctypes.c_int]

    # SHAppBarData: on some shell32.dll builds (varies by Windows version)
    # this is exported only by ordinal 92, not by name — a by-name lookup
    # via ctypes.windll.shell32.SHAppBarData then raises AttributeError at
    # import time and takes the whole app down with it. Try by name first,
    # fall back to the ordinal, and if neither resolves, leave it as None —
    # _compute_position() checks for that and falls back to a fixed
    # screen-corner position instead of crashing.
    try:
        _sh_app_bar_data = shell32.SHAppBarData
    except (AttributeError, OSError):
        try:
            _sh_app_bar_data = shell32[92]
        except (AttributeError, OSError):
            _sh_app_bar_data = None
    if _sh_app_bar_data is not None:
        _sh_app_bar_data.restype  = ctypes.c_size_t
        _sh_app_bar_data.argtypes = [wintypes.DWORD, ctypes.POINTER(APPBARDATA)]

    gdi32.CreateCompatibleDC.restype  = wintypes.HDC
    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]

    gdi32.CreateDIBSection.restype  = wintypes.HBITMAP
    gdi32.CreateDIBSection.argtypes = [
        wintypes.HDC, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
        ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD,
    ]

    gdi32.SelectObject.restype  = wintypes.HGDIOBJ
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteDC.argtypes     = [wintypes.HDC]

    # CoInitializeEx: some shell32 builds touch COM internally when servicing
    # ABM_GETTASKBARPOS (SHAppBarData), and calling into that from a raw
    # thread that never entered a COM apartment is a classic source of
    # intermittent access violations. restype is c_long (signed HRESULT) so
    # failure (negative) is a plain `< 0` check, no masking needed.
    ole32.CoInitializeEx.restype  = ctypes.c_long
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole32.CoUninitialize.restype  = None
    ole32.CoUninitialize.argtypes = []


class NowPlayingBubble:
    """
    Native Windows "Now Playing" popup — artwork + title + artist, anchored
    just above the system tray, auto-dismissing after a short delay.

    Usage:
        bubble = NowPlayingBubble(app_name="Macan Media Player")
        bubble.start()   # spawns the worker thread + creates the (hidden) window
        bubble.show(title="Song Name", artist="Some Artist",
                    artwork_data_url="data:image/jpeg;base64,...")   # or None

    `start()` is deliberately separate from `__init__` (and does NOT block
    the calling thread) so that simply constructing this object never
    delays app startup. This matters here specifically because the taskbar
    thumbnail toolbar (macan_taskbar_thumbbar_webview.py) is timing-
    sensitive about exactly when the main window becomes visible relative
    to Explorer creating its taskbar button — call `start()` only after
    the main window is up (e.g. from `set_window()`, alongside
    `TaskbarThumbBar.init_buttons()`), not during early API construction.

    Safe to call `show()` from any thread — internally hands off to a
    dedicated worker thread that owns the Win32 window + message loop.
    No-op everywhere except Windows, and no-op if Pillow isn't installed
    (the rendering path needs it). Calling `show()` before `start()` (or
    before the worker thread has finished creating its window) is also a
    safe no-op — it simply does nothing rather than queuing up.
    """

    def __init__(self, app_name: str = 'Macan Media Player'):
        self.app_name = app_name
        self._enabled = _IS_WINDOWS and _PIL_AVAILABLE
        self._hwnd = None
        self._started = False

        if not self._enabled:
            reason = 'not running on Windows' if not _IS_WINDOWS else 'Pillow (PIL) is not installed'
            print(f'[NowPlayingBubble] Disabled — {reason}.')
            return

        self._queue            = queue.Queue()
        self._hInstance         = None
        self._wndproc_ref       = None   # must keep a reference alive — ctypes GC pitfall
        self._font_eyebrow = self._font_title = self._font_artist = None
        self._anim_phase   = 'idle'      # idle | in | hold | out
        self._anim_start   = 0.0
        self._current_payload = None
        self._on_click = None
        self._thread = None
        # Cached (edge, rc) from the first successful SHAppBarData lookup.
        # The taskbar's position practically never changes within a session,
        # so re-querying it via a raw Win32 shell call on every single track
        # change is pure waste — look it up once and reuse it.
        self._taskbar_cache = None

    def start(self):
        """Spawn the worker thread that creates the (initially hidden)
        bubble window. Non-blocking — returns immediately. Safe to call
        more than once (subsequent calls are no-ops)."""
        if not self._enabled or self._started:
            return
        self._started = True
        self._thread = threading.Thread(target=self._run, name='NowPlayingBubble', daemon=True)
        self._thread.start()

    # ─── Public API ───────────────────────────────────────────────────

    def show(self, title: str, artist: str = '', artwork_data_url=None,
              duration_ms: int = DEFAULT_DURATION_MS, on_click=None):
        """Queue a bubble update for the current track. Safe to call from
        any thread (e.g. the pywebview JS→Python bridge thread)."""
        if not self._enabled or not self._hwnd:
            return
        self._on_click = on_click
        self._queue.put({
            'title':            title or '',
            'artist':           artist or '',
            'artwork_data_url': artwork_data_url,
            'duration_ms':      max(1500, int(duration_ms)),
        })
        try:
            user32.PostMessageW(self._hwnd, WM_BUBBLE_SHOW, 0, 0)
        except Exception as e:
            print(f'[NowPlayingBubble] PostMessage(show) failed: {e}')

    def close(self):
        """Hide immediately, skipping any fade-out in progress."""
        if not self._enabled or not self._hwnd:
            return
        try:
            user32.ShowWindow(self._hwnd, SW_HIDE)
        except Exception:
            pass
        self._anim_phase = 'idle'
        self._current_payload = None

    def shutdown(self):
        """Stop the worker thread and destroy the window. Optional — as a
        daemon thread it would be torn down with the process anyway, but
        call this from close_app() for a clean, immediate teardown."""
        if not self._enabled or not self._hwnd:
            return
        try:
            user32.PostMessageW(self._hwnd, WM_BUBBLE_SHUTDOWN, 0, 0)
        except Exception:
            pass

    # ─── Worker thread: owns the window + message loop ────────────────

    def _run(self):
        # This thread owns the window, the message loop, and (per Bug #1)
        # the taskbar lookup — so it needs a COM apartment initialized on it
        # before anything else runs. COINIT_APARTMENTTHREADED matches how a
        # window-owning UI thread is expected to enter COM. hr can be S_OK
        # (0) or S_FALSE (1, already-initialized) on success; only a
        # negative HRESULT is a real failure, and even then we keep going
        # rather than disabling the whole bubble over a non-fatal COM quirk
        # — CoUninitialize is simply skipped in that case.
        com_hr = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
        if com_hr < 0:
            print(f'[NowPlayingBubble] CoInitializeEx failed (hr={com_hr:#x}), continuing without COM init')

        try:
            try:
                self._register_class()
                self._hwnd = self._create_window()
                self._load_fonts()
            except Exception as e:
                print(f'[NowPlayingBubble] Init failed, disabling: {e}')
                self._enabled = False
                return

            msg = wintypes.MSG()
            while True:
                ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if ret == 0 or ret == -1:
                    break
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        finally:
            if com_hr >= 0:
                try:
                    ole32.CoUninitialize()
                except Exception:
                    pass

    def _register_class(self):
        self._hInstance = kernel32.GetModuleHandleW(None)
        # Keep a reference to the WINFUNCTYPE wrapper alive for the whole
        # process lifetime — if it gets garbage-collected, Windows ends up
        # calling into freed memory the next time it dispatches a message.
        self._wndproc_ref = WNDPROC(self._wnd_proc)

        wc = WNDCLASSEXW()
        wc.cbSize        = ctypes.sizeof(WNDCLASSEXW)
        wc.style         = 0
        wc.lpfnWndProc   = ctypes.cast(self._wndproc_ref, ctypes.c_void_p)
        wc.hInstance     = self._hInstance
        wc.hCursor       = user32.LoadCursorW(None, ctypes.cast(IDC_ARROW, wintypes.LPCWSTR))
        wc.hbrBackground = None
        wc.lpszMenuName  = None
        wc.lpszClassName = 'MacanNowPlayingBubbleClass'
        wc.hIcon         = None
        wc.hIconSm       = None

        atom = user32.RegisterClassExW(ctypes.byref(wc))
        if not atom:
            raise OSError('RegisterClassExW failed')

    def _create_window(self):
        style    = WS_POPUP
        ex_style = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        hwnd = user32.CreateWindowExW(
            ex_style, 'MacanNowPlayingBubbleClass', self.app_name, style,
            0, 0, BUBBLE_W, BUBBLE_H, None, None, self._hInstance, None,
        )
        if not hwnd:
            raise OSError('CreateWindowExW failed')
        return hwnd

    def _load_fonts(self):
        fonts_dir = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')

        def _f(filename, size):
            try:
                return ImageFont.truetype(os.path.join(fonts_dir, filename), size)
            except Exception:
                return ImageFont.load_default()

        # Segoe UI ships with every Windows install this app targets.
        self._font_eyebrow = _f('segoeuib.ttf', 11)
        self._font_title   = _f('segoeuib.ttf', 15)
        self._font_artist  = _f('segoeui.ttf', 13)

    def _wnd_proc(self, hwnd, msg, wparam, lparam):
        try:
            if msg == WM_BUBBLE_SHOW:
                self._handle_show_request()
                return 0
            if msg == WM_BUBBLE_SHUTDOWN:
                try:
                    user32.KillTimer(hwnd, TIMER_ID_ANIM)
                except Exception:
                    pass
                user32.DestroyWindow(hwnd)
                return 0
            if msg == WM_TIMER and wparam == TIMER_ID_ANIM:
                self._tick_animation()
                return 0
            if msg == WM_LBUTTONDOWN:
                self._on_bubble_clicked()
                return 0
            if msg == WM_DESTROY:
                user32.PostQuitMessage(0)
                return 0
        except Exception as e:
            print(f'[NowPlayingBubble] WndProc error (msg={msg}): {e}')
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    # ─── Show request handling ──────────────────────────────────────────

    def _handle_show_request(self):
        try:
            payload = self._queue.get_nowait()
        except queue.Empty:
            return

        try:
            base_img = self._render_bubble_image(
                payload['title'], payload['artist'], payload['artwork_data_url']
            )
        except Exception as e:
            print(f'[NowPlayingBubble] Render failed: {e}')
            return

        self._current_payload = {'image': base_img, 'duration_ms': payload['duration_ms']}

        x, y = self._compute_position(base_img.width, base_img.height)
        try:
            user32.SetWindowPos(
                self._hwnd, HWND_TOPMOST, x, y, base_img.width, base_img.height,
                SWP_SHOWWINDOW | SWP_NOACTIVATE,
            )
        except Exception as e:
            print(f'[NowPlayingBubble] SetWindowPos failed: {e}')

        # Start fully transparent, then let the animation timer fade it in.
        self._blit_frame(base_img, alpha_factor=0.0)
        user32.ShowWindow(self._hwnd, SW_SHOWNOACTIVATE)

        self._anim_phase = 'in'
        self._anim_start = time.monotonic()
        user32.SetTimer(self._hwnd, TIMER_ID_ANIM, ANIM_INTERVAL_MS, None)

    def _on_bubble_clicked(self):
        # Clicking skips straight to fade-out instead of waiting out the hold.
        if self._anim_phase in ('in', 'hold'):
            self._anim_phase = 'out'
            self._anim_start = time.monotonic()
        cb = self._on_click
        if callable(cb):
            try:
                cb()
            except Exception as e:
                print(f'[NowPlayingBubble] on_click callback error: {e}')

    def _tick_animation(self):
        payload = self._current_payload
        if not payload:
            return
        now = time.monotonic()
        elapsed_ms = (now - self._anim_start) * 1000.0

        if self._anim_phase == 'in':
            factor = min(1.0, elapsed_ms / FADE_IN_MS)
            self._blit_frame(payload['image'], factor)
            if factor >= 1.0:
                self._anim_phase = 'hold'
                self._anim_start = now

        elif self._anim_phase == 'hold':
            if elapsed_ms >= payload['duration_ms']:
                self._anim_phase = 'out'
                self._anim_start = now

        elif self._anim_phase == 'out':
            factor = max(0.0, 1.0 - (elapsed_ms / FADE_OUT_MS))
            self._blit_frame(payload['image'], factor)
            if factor <= 0.0:
                self._anim_phase = 'idle'
                self._current_payload = None
                try:
                    user32.KillTimer(self._hwnd, TIMER_ID_ANIM)
                except Exception:
                    pass
                user32.ShowWindow(self._hwnd, SW_HIDE)

    # ─── Rendering (Pillow → RGBA image) ────────────────────────────────

    def _render_bubble_image(self, title, artist, artwork_data_url):
        img = Image.new('RGBA', (BUBBLE_W, BUBBLE_H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rounded_rectangle(
            [0, 0, BUBBLE_W - 1, BUBBLE_H - 1], radius=CORNER_RADIUS,
            fill=BG_COLOR, outline=BORDER_COLOR, width=1,
        )

        art = self._load_artwork(artwork_data_url)
        art_x, art_y = ART_MARGIN, (BUBBLE_H - ART_SIZE) // 2
        img.paste(art, (art_x, art_y), art)

        text_x = art_x + ART_SIZE + 14
        text_w = BUBBLE_W - text_x - 14

        draw.text((text_x, 14), 'NOW PLAYING', font=self._font_eyebrow, fill=EYEBROW_COLOR)

        title_txt = self._ellipsize(draw, title or 'Unknown Title', self._font_title, text_w)
        draw.text((text_x, 32), title_txt, font=self._font_title, fill=TITLE_COLOR)

        artist_txt = self._ellipsize(draw, artist or 'Unknown Artist', self._font_artist, text_w)
        draw.text((text_x, 57), artist_txt, font=self._font_artist, fill=ARTIST_COLOR)

        return img

    def _load_artwork(self, data_url):
        if data_url and isinstance(data_url, str) and data_url.startswith('data:') and ';base64,' in data_url:
            try:
                b64 = data_url.split(';base64,', 1)[1]
                raw = base64.b64decode(b64)
                art = Image.open(io.BytesIO(raw)).convert('RGBA')
                art = ImageOps.fit(art, (ART_SIZE, ART_SIZE), Image.LANCZOS)
                mask = Image.new('L', (ART_SIZE, ART_SIZE), 0)
                ImageDraw.Draw(mask).rounded_rectangle(
                    [0, 0, ART_SIZE - 1, ART_SIZE - 1], radius=ART_CORNER_RADIUS, fill=255,
                )
                art.putalpha(mask)
                return art
            except Exception as e:
                print(f'[NowPlayingBubble] Artwork decode failed, using placeholder: {e}')

        # Placeholder: rounded tile with a simple music-note glyph.
        art = Image.new('RGBA', (ART_SIZE, ART_SIZE), (0, 0, 0, 0))
        d = ImageDraw.Draw(art)
        d.rounded_rectangle([0, 0, ART_SIZE - 1, ART_SIZE - 1], radius=ART_CORNER_RADIUS, fill=PLACEHOLDER_BG)
        d.ellipse([21, 39, 31, 49], fill=PLACEHOLDER_FG)
        d.ellipse([39, 33, 49, 43], fill=PLACEHOLDER_FG)
        d.line([26, 44, 26, 20, 44, 16, 44, 38], fill=PLACEHOLDER_FG, width=2)
        return art

    @staticmethod
    def _ellipsize(draw, text, font, max_width):
        if draw.textlength(text, font=font) <= max_width:
            return text
        ell = '…'
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if draw.textlength(text[:mid] + ell, font=font) <= max_width:
                lo = mid
            else:
                hi = mid - 1
        return text[:lo] + ell

    # ─── Blitting (UpdateLayeredWindow) ─────────────────────────────────

    def _blit_frame(self, base_rgba_img, alpha_factor):
        """Push `base_rgba_img` (straight alpha) to the layered window,
        scaling overall opacity by `alpha_factor` (0.0–1.0) for fades.

        UpdateLayeredWindow expects a TOP-DOWN, 32bpp, BGRA buffer with
        PRE-multiplied alpha (AC_SRC_ALPHA). We recompute this per frame
        rather than juggling SetLayeredWindowAttributes on top of an
        already per-pixel-alpha window — a bit more CPU per frame, but
        unambiguously correct, and the bubble is tiny (~344×96 px) so the
        cost is negligible even across a full fade animation.
        """
        w, h = base_rgba_img.size
        r, g, b, a = base_rgba_img.split()
        if alpha_factor < 0.999:
            factor = max(0.0, alpha_factor)
            a = a.point(lambda v, f=factor: int(v * f))
        # Premultiply: ImageChops.multiply(x, a) == (x * a) / 255 per pixel,
        # which is exactly what "premultiplied alpha" means here.
        pre_r = ImageChops.multiply(r, a)
        pre_g = ImageChops.multiply(g, a)
        pre_b = ImageChops.multiply(b, a)
        # Merge in B,G,R,A order — Image.merge()/tobytes() preserves band
        # order physically, so this yields real BGRA bytes without PIL
        # needing an actual "BGRA" mode (which doesn't exist).
        bgra = Image.merge('RGBA', (pre_b, pre_g, pre_r, a))
        buf = bgra.tobytes()

        hdc_screen = user32.GetDC(None)
        if not hdc_screen:
            return
        hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
        if not hdc_mem:
            user32.ReleaseDC(None, hdc_screen)
            return

        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize        = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth       = w
        bmi.bmiHeader.biHeight      = -h  # negative = top-down, matches PIL row order
        bmi.bmiHeader.biPlanes      = 1
        bmi.bmiHeader.biBitCount    = 32
        bmi.bmiHeader.biCompression = BI_RGB

        ppv_bits = ctypes.c_void_p()
        h_bitmap = gdi32.CreateDIBSection(
            hdc_mem, ctypes.byref(bmi), DIB_RGB_COLORS, ctypes.byref(ppv_bits), None, 0
        )
        if not h_bitmap or not ppv_bits:
            gdi32.DeleteDC(hdc_mem)
            user32.ReleaseDC(None, hdc_screen)
            return

        ctypes.memmove(ppv_bits, buf, len(buf))
        old_bmp = gdi32.SelectObject(hdc_mem, h_bitmap)

        try:
            rect = wintypes.RECT()
            user32.GetWindowRect(self._hwnd, ctypes.byref(rect))
            pt_dst   = wintypes.POINT(rect.left, rect.top)
            pt_src   = wintypes.POINT(0, 0)
            size_wnd = SIZE(w, h)
            blend    = BLENDFUNCTION(AC_SRC_OVER, 0, 255, AC_SRC_ALPHA)

            user32.UpdateLayeredWindow(
                self._hwnd, hdc_screen, ctypes.byref(pt_dst), ctypes.byref(size_wnd),
                hdc_mem, ctypes.byref(pt_src), 0, ctypes.byref(blend), ULW_ALPHA,
            )
        except Exception as e:
            print(f'[NowPlayingBubble] UpdateLayeredWindow failed: {e}')
        finally:
            gdi32.SelectObject(hdc_mem, old_bmp)
            gdi32.DeleteObject(h_bitmap)
            gdi32.DeleteDC(hdc_mem)
            user32.ReleaseDC(None, hdc_screen)

    # ─── Positioning: just outside the real taskbar edge ────────────────

    def _compute_position(self, w, h):
        cached = self._taskbar_cache
        if cached is None:
            try:
                taskbar_hwnd = user32.FindWindowW('Shell_TrayWnd', None)
                if taskbar_hwnd and _sh_app_bar_data is not None:
                    abd = APPBARDATA()
                    abd.cbSize = ctypes.sizeof(APPBARDATA)
                    abd.hWnd   = taskbar_hwnd
                    _sh_app_bar_data(ABM_GETTASKBARPOS, ctypes.byref(abd))
                    # Copy uEdge/rc out of the transient APPBARDATA into a
                    # plain tuple so the cache doesn't hold a reference into
                    # a ctypes struct that's about to go out of scope.
                    rc = abd.rc
                    cached = (abd.uEdge, (rc.left, rc.top, rc.right, rc.bottom))
                    self._taskbar_cache = cached
            except Exception as e:
                print(f'[NowPlayingBubble] Taskbar position lookup failed: {e}')

        if cached is not None:
            edge, (left, top, right, bottom) = cached

            if edge == ABE_BOTTOM:
                x = right - w - MARGIN_FROM_SIDE
                y = top - h - MARGIN_FROM_TASKBAR
            elif edge == ABE_TOP:
                x = right - w - MARGIN_FROM_SIDE
                y = bottom + MARGIN_FROM_TASKBAR
            elif edge == ABE_LEFT:
                x = right + MARGIN_FROM_TASKBAR
                y = bottom - h - MARGIN_FROM_SIDE
            else:  # ABE_RIGHT
                x = left - w - MARGIN_FROM_TASKBAR
                y = bottom - h - MARGIN_FROM_SIDE
            return int(x), int(y)

        # Fallback: bottom-right of the primary monitor.
        # trade-off: only used if SHAppBarData couldn't be resolved at all,
        # or the per-call lookup above failed (e.g. taskbar hidden/unusual
        # shell); doesn't know the real taskbar height in that case, so it
        # estimates one instead of reading it.
        screen_w = user32.GetSystemMetrics(SM_CXSCREEN)
        screen_h = user32.GetSystemMetrics(SM_CYSCREEN)
        return screen_w - w - MARGIN_FROM_SIDE, screen_h - h - 56
