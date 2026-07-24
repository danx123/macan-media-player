# -*- coding: utf-8 -*-
"""
macan_taskbar_thumbbar_webview.py
==================================
Varian `macan_taskbar_thumbbar.py` yang dirombak total buat app yang JENDELANYA
BUKAN PySide6/Qt — di sini spesifik buat Macan Media Player yang pakai
`pywebview` (backend EdgeWebView2/WinForms di Windows).

KENAPA VARIAN INI DIPERLUKAN (BEDA SAMA VERSI QT)
--------------------------------------------------------------------------
Versi asli `macan_taskbar_thumbbar.py` (dipakai di Macan Vision / Macan Video
Player / dll) bergantung ke:
  - `window.winId()`               -> method PySide6/Qt, gak ada di objek
                                       `webview.Window` milik pywebview.
  - `QApplication.instance()`      -> buat pasang `QAbstractNativeEventFilter`
                                       (cara Qt nangkep pesan Win32).
  - `QIcon` / `QImage`             -> buat render ikon jadi HICON.

Karena main.py app ini SAMA SEKALI gak punya QApplication (murni pywebview,
gak ada PySide6 di process ini), tiga hal di atas gak bisa dipakai. Makanya
modul ini ditulis ulang dari nol dengan pendekatan yang toolkit-agnostic:

  1. HWND diambil langsung dari native window pywebview (`window.native.Handle`
     kalau backend WinForms/EdgeWebView2 nyediain itu), dengan fallback
     `FindWindowW` berdasarkan judul jendela kalau atribut itu gak ada/berubah
     di versi pywebview tertentu.
  2. Nangkep klik tombol thumbbar & broadcast "TaskbarButtonCreated" TIDAK
     lewat Qt event filter, dan TIDAK lewat window-subclassing ctypes
     (`SetWindowLongPtrW`) — teknik itu ternyata gak reliable buat HWND
     yang dihost WinForms/EdgeWebView2 (tombolnya gak kepencet). Sebagai
     gantinya dipakai `System.Windows.Forms.IMessageFilter` lewat
     pythonnet (`Application.AddMessageFilter()`), mekanisme RESMI WinForms
     buat numpang intip tiap pesan Win32 persis di message loop-nya
     sendiri. `PreFilterMessage` SELALU return `(False, m)` (`m` gak diubah)
     supaya pesan tetap diteruskan normal ke handler aslinya — drag, resize,
     input WebView2, dst gak keganggu.
  3. Ikon tombol (Prev/Play/Pause/Next) digambar langsung jadi bitmap RGBA
     lewat kalkulasi piksel manual (segitiga/bar sederhana) — TIDAK pakai
     QIcon/QImage ataupun file aset eksternal. Modul ini pakai `ctypes`
     (bawaan Python) buat ITaskbarList3/COM/GDI, dan `pythonnet` (`clr`)
     buat IMessageFilter WinForms — keduanya sudah pasti ke-load duluan
     oleh pywebview backend edgechromium, jadi gak nambah dependency baru.

CATATAN PENTING
--------------------------------------------------------------------------
Versi awal modul ini pakai window-subclassing ctypes (`SetWindowLongPtrW`)
buat nangkep klik tombol thumbbar, tapi ternyata gak reliable di HWND yang
dihost WinForms/EdgeWebView2 — WM_COMMAND dari THBN_CLICKED gak selalu
lewat window-proc yang di-subclass, jadi tombolnya kelihatan ada tapi gak
berfungsi. Sekarang dipakai `System.Windows.Forms.IMessageFilter` lewat
`Application.AddMessageFilter()`, cara resmi WinForms buat intersep pesan
di message loop-nya sendiri. Kalau pas dites ternyata ada efek samping
aneh (drag frameless window jadi lag, atau WebView2 kehilangan sebagian
input), nonaktifkan dengan gampang lewat guard
`TASKBAR_THUMBBAR_ENABLED = False` di bagian bawah file ini, tanpa perlu
bongkar kode lain.

Threading/COM: `CoCreateInstance` butuh COM ter-inisialisasi di thread yang
sama dengan HWND. WinForms (yang menghost EdgeWebView2) sendiri jalan di
apartment STA, jadi modul ini defensif manggil `CoInitializeEx` (mode STA)
sebelum bikin `ITaskbarList3` — kalau ternyata sudah ter-inisialisasi duluan
oleh WinForms, panggilan ini aman (COM cuma nambah refcount, gak nge-reset
apa-apa), dan di-`CoUninitialize()` balik saat `shutdown()`.

Pemakaian (lihat integrasi lengkap di main.py):
    from macan_taskbar_thumbbar_webview import TaskbarThumbBar

    tb = TaskbarThumbBar(window_title="Macan Media Player")
    tb.previous_requested.connect(lambda: window.evaluate_js('prevTrack()'))
    tb.play_pause_requested.connect(lambda: window.evaluate_js('togglePlayPause()'))
    tb.next_requested.connect(lambda: window.evaluate_js('nextTrack()'))

    # panggil setelah window pywebview benar-benar tampil (window.events.shown):
    tb.init_buttons()

    # tiap kali JS lapor balik status play/pause berubah:
    tb.set_playing(True)   # -> tombol tengah jadi ikon pause

    # saat app mau ditutup:
    tb.shutdown()

Non-Windows -> otomatis no-op (aman dipanggil tanpa try/except di caller).
"""

import sys
import time
import threading

IS_WINDOWS = sys.platform == "win32"

# Guard darurat: kalau window-subclassing ternyata bikin masalah di build
# tertentu, cukup ubah ini jadi False — seluruh fitur taskbar thumbbar mati
# bersih tanpa perlu ubah kode integrasi di main.py.
TASKBAR_THUMBBAR_ENABLED = True


class _Signal:
    """Pengganti minimalis Qt Signal — gak butuh QObject/QApplication sama
    sekali. API-nya sengaja dibikin mirip (`.connect()` / `.emit()`) biar
    kode pemanggil di main.py tetap terasa konsisten dengan modul-modul
    Macan lain yang berbasis Qt."""

    def __init__(self):
        self._slots = []

    def connect(self, fn):
        self._slots.append(fn)

    def emit(self, *args, **kwargs):
        for fn in list(self._slots):
            try:
                fn(*args, **kwargs)
            except Exception as e:
                print(f"[TaskbarThumbBar] Handler error: {e}")


if IS_WINDOWS and TASKBAR_THUMBBAR_ENABLED:
    import ctypes
    from ctypes import wintypes

    # ── Siapin pythonnet: dipakai buat IMessageFilter WinForms (pengganti
    # window-subclassing ctypes SetWindowLongPtrW yang lama). WinForms yang
    # ngehost EdgeWebView2 sudah pasti nge-load pythonnet duluan (itu cara
    # pywebview backend edgechromium jalan), jadi `clr` di sini gak nambah
    # dependency baru — cuma numpang reference yang sudah ke-load.
    import clr
    clr.AddReference("System.Windows.Forms")
    from System.Windows.Forms import Application, IMessageFilter, MethodInvoker

    ole32 = ctypes.windll.ole32
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32

    CLSCTX_INPROC_SERVER = 0x1
    S_OK = 0
    COINIT_APARTMENTTHREADED = 0x2
    S_FALSE = 1
    RPC_E_CHANGED_MODE = -2147417850  # 0x80010106 (signed)

    WM_COMMAND = 0x0111
    THBN_CLICKED = 0x1800

    THB_BITMAP = 0x1
    THB_ICON = 0x2
    THB_TOOLTIP = 0x4
    THB_FLAGS = 0x8

    THBF_ENABLED = 0x0
    THBF_DISABLED = 0x1

    # ID 200/201/202 (versi lama) ada di range kecil yang lazim dipakai
    # buat control/command ID internal Win32/WinForms umum, jadi dinaikin
    # ke range yang jauh lebih gak lazim dipakai siapapun. Konvensi umum di
    # dunia Win32/MFC/VS resource compiler adalah command ID custom mulai
    # dari 40001 ke atas (persis default _APS_NEXT_COMMAND_VALUE), jadi
    # dipakai basis yang sama di sini biar konsisten dengan konvensi yang
    # sudah dikenal luas dan jauh dari ID kecil bawaan sistem.
    BTN_ID_PREV = 40001
    BTN_ID_PLAYPAUSE = 40002
    BTN_ID_NEXT = 40003

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_ulong),
            ("Data2", ctypes.c_ushort),
            ("Data3", ctypes.c_ushort),
            ("Data4", ctypes.c_ubyte * 8),
        ]

        def __init__(self, guid_str):
            super().__init__()
            ole32.CLSIDFromString(ctypes.c_wchar_p(guid_str), ctypes.byref(self))

    CLSID_TaskbarList = GUID("{56FDF344-FD6D-11D0-958A-006097C9A090}")
    IID_ITaskbarList3 = GUID("{EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF}")

    class THUMBBUTTON(ctypes.Structure):
        _fields_ = [
            ("dwMask", wintypes.DWORD),
            ("iId", wintypes.UINT),
            ("iBitmap", wintypes.UINT),
            ("hIcon", wintypes.HICON),
            ("szTip", wintypes.WCHAR * 260),
            ("dwFlags", wintypes.DWORD),
        ]

    class ICONINFO(ctypes.Structure):
        _fields_ = [
            ("fIcon", wintypes.BOOL),
            ("xHotspot", wintypes.DWORD),
            ("yHotspot", wintypes.DWORD),
            ("hbmMask", wintypes.HBITMAP),
            ("hbmColor", wintypes.HBITMAP),
        ]

    class BITMAPV5HEADER(ctypes.Structure):
        _fields_ = [
            ("bV5Size", wintypes.DWORD),
            ("bV5Width", ctypes.c_long),
            ("bV5Height", ctypes.c_long),
            ("bV5Planes", wintypes.WORD),
            ("bV5BitCount", wintypes.WORD),
            ("bV5Compression", wintypes.DWORD),
            ("bV5SizeImage", wintypes.DWORD),
            ("bV5XPelsPerMeter", ctypes.c_long),
            ("bV5YPelsPerMeter", ctypes.c_long),
            ("bV5ClrUsed", wintypes.DWORD),
            ("bV5ClrImportant", wintypes.DWORD),
            ("bV5RedMask", wintypes.DWORD),
            ("bV5GreenMask", wintypes.DWORD),
            ("bV5BlueMask", wintypes.DWORD),
            ("bV5AlphaMask", wintypes.DWORD),
            ("bV5CSType", wintypes.DWORD),
            ("bV5Endpoints", ctypes.c_byte * 36),
            ("bV5GammaRed", wintypes.DWORD),
            ("bV5GammaGreen", wintypes.DWORD),
            ("bV5GammaBlue", wintypes.DWORD),
            ("bV5Intent", wintypes.DWORD),
            ("bV5ProfileData", wintypes.DWORD),
            ("bV5ProfileSize", wintypes.DWORD),
            ("bV5Reserved", wintypes.DWORD),
        ]

    # ── IMessageFilter WinForms: pengganti window-subclassing ctypes ─────────
    class _ThumbBarMessageFilter(IMessageFilter):
        """Pengganti window-subclassing manual (`SetWindowLongPtrW` +
        `CallWindowProcW`) buat nangkep WM_COMMAND (klik tombol thumbbar) &
        pesan `TaskbarButtonCreated`.

        Dipasang lewat `Application.AddMessageFilter()` — mekanisme RESMI
        WinForms buat "numpang intip" tiap pesan Win32 yang lewat message
        loop-nya sendiri, PERSIS di titik sebelum WinForms/EdgeWebView2
        memprosesnya. Ini kenapa tombolnya kemarin gak berfungsi: subclass
        HWND pakai ctypes (`SetWindowLongPtrW`) manggil balik window proc
        lama lewat `CallWindowProcW`, tapi WinForms host (EdgeWebView2)
        gak selalu pakai window-proc klasik itu buat rute WM_COMMAND-nya —
        `IMessageFilter` justru dipasang di level message loop WinForms
        sendiri, jadi pasti kelewat sebelum di-dispatch ke handler manapun.

        `PreFilterMessage` WAJIB SELALU return `(False, m)` — `False` artinya
        "jangan ditelan, terusin proses normal" (kita cuma numpang baca, gak
        pernah nyekek pesan buat jendela lain ataupun input WebView2), dan
        `m` WAJIB ikut dikembalikan karena parameter aslinya `ref Message m`
        — pythonnet nuntut tuple (retval, ref_param_baru) buat method
        dengan ref/out parameter, gak bisa cuma return bool polos.
        """

        __namespace__ = "MacanTaskbarThumbBar"  # bantu pythonnet generate
                                                  # tipe turunan interface
                                                  # .NET dengan bener

        def __init__(self, on_message):
            super().__init__()
            self._on_message = on_message

        def PreFilterMessage(self, m):
            # PENTING: signature asli .NET-nya `bool PreFilterMessage(ref
            # Message m)` — parameter `m` itu REF. Pythonnet WAJIB return
            # tuple (return_value, nilai_ref_param_baru) buat method yang
            # punya ref/out parameter, BUKAN cuma nilai balik polos. Return
            # `False` doang (tanpa tuple) bikin crash
            # `System.ArgumentException: object is not a tuple` di
            # `PythonDerivedType.MarshalByRefsBack` — ini kenapa tombol
            # sempat muncul tapi klik gak ada reaksi (proses message filter
            # crash tiap kali kepanggil).
            try:
                self._on_message(
                    m.HWnd.ToInt64(), m.Msg, m.WParam.ToInt64(), m.LParam.ToInt64()
                )
            except Exception as e:
                print(f"[TaskbarThumbBar] Error di message filter: {e}")
            # (False, m) -> jangan ditelan, dan `m` dikembalikan apa adanya
            # (gak kita ubah) buat memenuhi kontrak ref parameter.
            return False, m

    # ── Helper: index vtable interface COM lewat ctypes murni ────────────────
    def _vtbl_method(interface_ptr, index, restype, *argtypes):
        vptr = ctypes.cast(interface_ptr, ctypes.POINTER(ctypes.c_void_p)).contents.value
        if not vptr:
            raise OSError("Vtable pointer COM null — interface tidak valid")
        vtable = ctypes.cast(vptr, ctypes.POINTER(ctypes.c_void_p * 21)).contents
        func_ptr = vtable[index]
        if not func_ptr:
            raise OSError(f"Vtable slot #{index} null — offset vtable salah")
        func_type = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
        return func_type(func_ptr)

    IDX_RELEASE = 2
    IDX_HRINIT = 3
    IDX_THUMBBAR_ADD = 15
    IDX_THUMBBAR_UPDATE = 16

    # ── Gambar ikon 24x24 langsung jadi buffer piksel BGRA premultiplied ─────
    # (BGRA byte-order per piksel supaya cocok sama bV5*Mask di BITMAPV5HEADER
    # di bawah — tanpa anti-aliasing, cukup buat ikon kecil di thumbbar).
    def _blank_canvas(size):
        return bytearray(size * size * 4)  # semua transparan (0,0,0,0)

    def _put_px(buf, size, x, y, bgr):
        if 0 <= x < size and 0 <= y < size:
            i = (y * size + x) * 4
            buf[i + 0] = bgr[2]  # B
            buf[i + 1] = bgr[1]  # G
            buf[i + 2] = bgr[0]  # R
            buf[i + 3] = 255     # A

    def _fill_rect(buf, size, x0, y0, x1, y1, rgb):
        for y in range(max(0, y0), min(size, y1)):
            for x in range(max(0, x0), min(size, x1)):
                _put_px(buf, size, x, y, rgb)

    def _fill_triangle(buf, size, p0, p1, p2, rgb):
        xs = [p0[0], p1[0], p2[0]]
        ys = [p0[1], p1[1], p2[1]]
        x0, x1 = max(0, min(xs)), min(size, max(xs) + 1)
        y0, y1 = max(0, min(ys)), min(size, max(ys) + 1)

        def sign(a, b, c):
            return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])

        for y in range(y0, y1):
            for x in range(x0, x1):
                pt = (x + 0.5, y + 0.5)
                d1 = sign(pt, p0, p1)
                d2 = sign(pt, p1, p2)
                d3 = sign(pt, p2, p0)
                has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
                has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
                if not (has_neg and has_pos):
                    _put_px(buf, size, x, y, rgb)

    def _draw_icon_rgba(kind, size=24, rgb=(255, 255, 255)):
        """kind: 'prev' | 'play' | 'pause' | 'next'. Return bytearray BGRA
        top-down, panjang size*size*4."""
        buf = _blank_canvas(size)
        m = size // 6  # margin

        if kind == "play":
            _fill_triangle(buf, size, (m + 1, m), (m + 1, size - m), (size - m, size // 2), rgb)
        elif kind == "pause":
            bar_w = max(2, size // 6)
            gap = max(2, size // 8)
            cx = size // 2
            _fill_rect(buf, size, cx - gap - bar_w, m, cx - gap, size - m, rgb)
            _fill_rect(buf, size, cx + gap, m, cx + gap + bar_w, size - m, rgb)
        elif kind == "next":
            half = size // 2
            _fill_triangle(buf, size, (m, m), (m, size - m), (half, size // 2), rgb)
            _fill_triangle(buf, size, (half, m), (half, size - m), (size - m - 2, size // 2), rgb)
            _fill_rect(buf, size, size - m - 2, m, size - m + 1, size - m, rgb)
        elif kind == "prev":
            half = size // 2
            _fill_triangle(buf, size, (size - m, m), (size - m, size - m), (half, size // 2), rgb)
            _fill_triangle(buf, size, (half, m), (half, size - m), (m + 2, size // 2), rgb)
            _fill_rect(buf, size, m - 1, m, m + 2, size - m, rgb)

        return bytes(buf)

    def _rgba_bgra_to_hicon(bgra_bytes: bytes, size: int):
        """Convert buffer BGRA top-down (dari _draw_icon_rgba) -> Win32 HICON
        32-bit alpha lewat GDI DIB section. Analog sama _qimage_to_hicon di
        versi Qt, tapi sumbernya raw bytes, bukan QImage."""
        w = h = size
        bmi = BITMAPV5HEADER()
        ctypes.memset(ctypes.byref(bmi), 0, ctypes.sizeof(bmi))
        bmi.bV5Size = ctypes.sizeof(BITMAPV5HEADER)
        bmi.bV5Width = w
        bmi.bV5Height = -h  # top-down DIB
        bmi.bV5Planes = 1
        bmi.bV5BitCount = 32
        bmi.bV5Compression = 3  # BI_BITFIELDS
        bmi.bV5RedMask = 0x00FF0000
        bmi.bV5GreenMask = 0x0000FF00
        bmi.bV5BlueMask = 0x000000FF
        bmi.bV5AlphaMask = 0xFF000000

        hdc = user32.GetDC(None)
        ppv_bits = ctypes.c_void_p()
        hbm_color = gdi32.CreateDIBSection(
            hdc, ctypes.byref(bmi), 0, ctypes.byref(ppv_bits), None, 0
        )
        user32.ReleaseDC(None, hdc)
        if not hbm_color or not ppv_bits.value:
            return None

        ctypes.memmove(ppv_bits, bgra_bytes, w * h * 4)

        hbm_mask = gdi32.CreateBitmap(w, h, 1, 1, None)

        icon_info = ICONINFO()
        icon_info.fIcon = True
        icon_info.xHotspot = 0
        icon_info.yHotspot = 0
        icon_info.hbmMask = hbm_mask
        icon_info.hbmColor = hbm_color

        hicon = user32.CreateIconIndirect(ctypes.byref(icon_info))

        gdi32.DeleteObject(hbm_color)
        gdi32.DeleteObject(hbm_mask)

        return hicon if hicon else None

    def _find_hwnd_by_title(title, retries=15, delay=0.2):
        for _ in range(retries):
            hwnd = user32.FindWindowW(None, title)
            if hwnd:
                return hwnd
            time.sleep(delay)
        return 0

    class TaskbarThumbBar:
        """
        Tombol Previous / Play-Pause / Next di preview thumbnail taskbar
        Windows — versi toolkit-agnostic (dipakai lewat HWND langsung, bukan
        lewat widget Qt).

        Semua method publik AMAN dipanggil tanpa try/except di kode
        pemanggil; kalau ada apapun yang gagal (COM, window subclassing,
        dst), fitur ini fail-safe mati sendiri.
        """

        def __init__(self, window=None, window_title=None, icon_size=24, icon_rgb=(255, 255, 255)):
            """
            window        : objek `webview.Window` (opsional) — dipakai buat
                            coba ambil HWND lewat `window.native.Handle`.
            window_title  : judul jendela (fallback pencarian HWND lewat
                            FindWindowW kalau `window.native` gak tersedia).
                            Wajib diisi kalau `window` gak diisi.
            """
            self.previous_requested = _Signal()
            self.play_pause_requested = _Signal()
            self.next_requested = _Signal()

            self._window = window
            self._window_title = window_title
            self._icon_size = icon_size
            self._icon_rgb = icon_rgb

            self._enabled = True
            self._hwnd = 0
            self._taskbar_list = None
            self._buttons_added = False
            self._is_playing = False
            self._icons = {}
            self._wm_taskbar_created = 0
            self._com_initialized = False
            self._message_filter = None  # simpan referensi biar gak di-GC
            self._click_in_flight = False  # guard: cegah evaluate_js overlap

        # ── Public API ────────────────────────────────────────────────────
        def init_buttons(self):
            """Panggil setelah window pywebview benar-benar tampil (event
            `window.events.shown`), supaya HWND sudah pasti valid."""
            if not self._enabled:
                return
            try:
                self._hwnd = self._resolve_hwnd()
                if not self._hwnd:
                    print("[TaskbarThumbBar] HWND tidak ditemukan, fitur dimatikan.")
                    self._enabled = False
                    return

                self._init_com()

                self._icons["prev"] = _rgba_bgra_to_hicon(
                    _draw_icon_rgba("prev", self._icon_size, self._icon_rgb), self._icon_size)
                self._icons["play"] = _rgba_bgra_to_hicon(
                    _draw_icon_rgba("play", self._icon_size, self._icon_rgb), self._icon_size)
                self._icons["pause"] = _rgba_bgra_to_hicon(
                    _draw_icon_rgba("pause", self._icon_size, self._icon_rgb), self._icon_size)
                self._icons["next"] = _rgba_bgra_to_hicon(
                    _draw_icon_rgba("next", self._icon_size, self._icon_rgb), self._icon_size)

                self._wm_taskbar_created = user32.RegisterWindowMessageW("TaskbarButtonCreated")

                # Pasang message filter di try/except TERPISAH dari proses
                # add-buttons di bawah: kalau IMessageFilter/pythonnet gagal
                # dipasang (mis. beda AppDomain/runtime sama pywebview, atau
                # Application belum siap), tombol tetap harus muncul di
                # taskbar — cuma klik-nya yang gak ke-detect, BUKAN seluruh
                # fitur mati total kayak kemarin.
                try:
                    self._install_message_filter()
                except Exception as e:
                    print(f"[TaskbarThumbBar] Gagal pasang message filter, "
                          f"klik tombol mungkin gak ke-detect: {e}")
                    self._message_filter = None

                self._create_taskbar_list()
                self._add_buttons()
            except Exception as e:
                print(f"[TaskbarThumbBar] Gagal init tombol taskbar, fitur dimatikan: {e}")
                self._enabled = False
                self._release_taskbar_list()

        def set_playing(self, is_playing: bool):
            if not self._enabled or not self._buttons_added:
                self._is_playing = is_playing
                return
            if self._is_playing == is_playing:
                return
            self._is_playing = is_playing
            try:
                self._update_buttons()
            except Exception as e:
                print(f"[TaskbarThumbBar] Gagal update tombol play/pause: {e}")
                self._enabled = False

        def set_enabled_buttons(self, has_prev: bool = True, has_next: bool = True):
            if not self._enabled or not self._buttons_added:
                return
            try:
                self._update_buttons(prev_enabled=has_prev, next_enabled=has_next)
            except Exception as e:
                print(f"[TaskbarThumbBar] Gagal update enable/disable tombol: {e}")
                self._enabled = False

        def shutdown(self):
            if not IS_WINDOWS:
                return
            try:
                self._restore_message_filter()
            except Exception:
                pass
            try:
                self._release_taskbar_list()
            except Exception:
                pass
            try:
                if self._com_initialized:
                    ole32.CoUninitialize()
                    self._com_initialized = False
            except Exception:
                pass

        # ── Internal: HWND & COM ─────────────────────────────────────────
        def _resolve_hwnd(self):
            # 1) Coba lewat objek webview.Window (backend WinForms/EdgeWebView2)
            if self._window is not None:
                try:
                    handle = self._window.native.Handle  # System.IntPtr (pythonnet)
                    hwnd = int(handle.ToInt64())
                    if hwnd:
                        return hwnd
                except Exception:
                    pass
            # 2) Fallback: cari HWND berdasarkan judul jendela
            title = self._window_title
            if not title and self._window is not None:
                title = getattr(self._window, "title", None)
            if title:
                return _find_hwnd_by_title(title)
            return 0

        def _init_com(self):
            hr = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            # S_OK / S_FALSE = berhasil (S_FALSE = sudah ter-inisialisasi
            # sebelumnya di thread ini, itu NORMAL karena WinForms sudah
            # nge-init COM duluan). RPC_E_CHANGED_MODE = beda apartment model
            # — non-fatal juga, ITaskbarList3 biasanya tetap jalan.
            self._com_initialized = hr in (S_OK, S_FALSE)

        # ── Internal: ITaskbarList3 ───────────────────────────────────────
        def _create_taskbar_list(self):
            self._release_taskbar_list()
            ppv = ctypes.c_void_p()
            hr = ole32.CoCreateInstance(
                ctypes.byref(CLSID_TaskbarList),
                None,
                CLSCTX_INPROC_SERVER,
                ctypes.byref(IID_ITaskbarList3),
                ctypes.byref(ppv),
            )
            if hr != S_OK or not ppv.value:
                self._taskbar_list = None
                return
            self._taskbar_list = ppv.value
            hrinit = _vtbl_method(self._taskbar_list, IDX_HRINIT, ctypes.c_long)
            hrinit(self._taskbar_list)

        def _release_taskbar_list(self):
            if self._taskbar_list:
                release = _vtbl_method(self._taskbar_list, IDX_RELEASE, ctypes.c_ulong)
                release(self._taskbar_list)
                self._taskbar_list = None
            self._buttons_added = False

        def _make_buttons_array(self, prev_enabled=True, next_enabled=True):
            buttons = (THUMBBUTTON * 3)()
            specs = [
                (BTN_ID_PREV, self._icons.get("prev"), "Previous", prev_enabled),
                (
                    BTN_ID_PLAYPAUSE,
                    self._icons.get("pause") if self._is_playing else self._icons.get("play"),
                    "Pause" if self._is_playing else "Play",
                    True,
                ),
                (BTN_ID_NEXT, self._icons.get("next"), "Next", next_enabled),
            ]
            for i, (btn_id, hicon, tip, enabled) in enumerate(specs):
                b = buttons[i]
                b.dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS
                b.iId = btn_id
                b.iBitmap = 0
                b.hIcon = hicon if hicon else 0
                b.szTip = tip
                b.dwFlags = THBF_ENABLED if enabled else THBF_DISABLED
            return buttons

        def _add_buttons(self):
            if not self._taskbar_list or not self._hwnd:
                return
            buttons = self._make_buttons_array()
            add_fn = _vtbl_method(
                self._taskbar_list, IDX_THUMBBAR_ADD, ctypes.c_long,
                wintypes.HWND, wintypes.UINT, ctypes.POINTER(THUMBBUTTON),
            )
            hr = add_fn(self._taskbar_list, self._hwnd, 3, buttons)
            self._buttons_added = (hr == S_OK)

        def _update_buttons(self, prev_enabled=True, next_enabled=True):
            if not self._taskbar_list or not self._buttons_added or not self._hwnd:
                return
            buttons = self._make_buttons_array(prev_enabled, next_enabled)
            update_fn = _vtbl_method(
                self._taskbar_list, IDX_THUMBBAR_UPDATE, ctypes.c_long,
                wintypes.HWND, wintypes.UINT, ctypes.POINTER(THUMBBUTTON),
            )
            update_fn(self._taskbar_list, self._hwnd, 3, buttons)

        def _reinit_after_explorer_restart(self):
            if not self._enabled:
                return
            try:
                self._create_taskbar_list()
                self._add_buttons()
            except Exception as e:
                print(f"[TaskbarThumbBar] Gagal re-init setelah explorer restart: {e}")
                self._enabled = False

        # ── Internal: IMessageFilter WinForms (pengganti QAbstractNativeEventFilter) ──
        def _defer(self, fn):
            # Dipakai KHUSUS buat re-init taskbar-list setelah Explorer
            # restart (TaskbarButtonCreated) — bukan buat klik tombol lagi
            # (lihat `_dispatch_button_click` di bawah buat itu). Re-init di
            # sini manggil ulang `CoCreateInstance`/`ITaskbarList3`, dan COM
            # object STA itu WAJIB dipakai dari thread yang sama tempat dia
            # dibikin — jadi di sini justru BENAR pakai `BeginInvoke` biar
            # tetap di UI/STA thread. Ini gak masalah karena path ini gak
            # pernah manggil `evaluate_js` (beda kasus dari klik tombol).
            native = getattr(self._window, "native", None) if self._window is not None else None
            if native is not None:
                try:
                    native.BeginInvoke(MethodInvoker(fn))
                    return
                except Exception as e:
                    print(f"[TaskbarThumbBar] Gagal defer callback lewat BeginInvoke: {e}")
            print("[TaskbarThumbBar] BeginInvoke tidak tersedia, re-init taskbar dilewati.")

        def _dispatch_button_click(self, btn_id):
            # AKAR MASALAH HANG (kenapa SEMUA tombol selalu nge-hang, bukan
            # cuma kadang-kadang): handler klik ujungnya manggil
            # `window.evaluate_js(...)` (lewat signal emit di main.py).
            # `evaluate_js` versi pywebview backend edgechromium itu
            # BLOCKING — dia manggil `CoreWebView2.ExecuteScriptAsync(...)`
            # (async, langsung return) terus NUNGGU (`semaphore.acquire()`
            # atau sejenisnya) sampai completion callback-nya kepanggil.
            # Completion callback itu COM continuation yang cuma bisa
            # dikirim balik lewat message-loop UI thread yang SAMA dengan
            # yang bikin `CoreWebView2`.
            #
            # Sebelumnya klik tombol di-dispatch lewat `BeginInvoke` —
            # yaitu balik lagi ke UI thread itu sendiri. Begitu `evaluate_js`
            # mulai nunggu di UI thread itu, dia nge-block thread yang justru
            # dibutuhkan buat ngirim completion callback yang mau dia tunggu
            # — UI thread nunggu dirinya sendiri, deadlock permanen. Ini
            # kenapa hang-nya konsisten 100% di tombol MANAPUN, bukan soal
            # ID atau soal SMTC.
            #
            # FIX: jalanin handler klik (yang ujungnya manggil evaluate_js)
            # di THREAD PYTHON BIASA, bukan balik ke UI thread. WebView2/
            # CoreWebView2 sebagai COM object otomatis marshaling panggilan
            # lintas-thread ke STA thread aslinya di level .NET/COM — jadi
            # tetap aman dipanggil dari thread lain, dan yang penting UI
            # thread tetap BEBAS mompa message loop-nya sendiri buat
            # ngirim completion callback yang evaluate_js tunggu.
            if self._click_in_flight:
                print("[TaskbarThumbBar] Klik diabaikan, callback sebelumnya masih diproses.")
                return

            # Set flag SEBELUM thread baru di-start (bukan di dalam thread
            # itu sendiri), biar klik ganda yang masuk sebelum thread
            # sempat jalan tetap ke-block dengan benar.
            self._click_in_flight = True

            def _run():
                # Exception apapun (termasuk dari evaluate_js/signal emit)
                # SELALU ketangkep di sini dan TIDAK PERNAH bocor jadi
                # unhandled exception di thread manapun (baik thread
                # background ini maupun UI thread WinForms).
                try:
                    self._handle_button_click(btn_id)
                except Exception as e:
                    print(f"[TaskbarThumbBar] Error di callback klik (ketangkep): {e}")
                finally:
                    self._click_in_flight = False

            try:
                threading.Thread(target=_run, daemon=True, name="TaskbarThumbBarClick").start()
            except Exception as e:
                print(f"[TaskbarThumbBar] Gagal start thread callback klik: {e}")
                self._click_in_flight = False

        def _install_message_filter(self):
            def _on_message(hwnd, msg, wparam, lparam):
                # Filter dari Application.AddMessageFilter() sifatnya GLOBAL
                # (kepanggil buat semua pesan di seluruh app, bukan cuma
                # jendela kita), jadi saring dulu berdasarkan HWND target.
                if hwnd != self._hwnd:
                    return
                if self._wm_taskbar_created and msg == self._wm_taskbar_created:
                    self._defer(self._reinit_after_explorer_restart)
                elif msg == WM_COMMAND:
                    high_word = (wparam >> 16) & 0xFFFF
                    low_word = wparam & 0xFFFF
                    if high_word == THBN_CLICKED:
                        self._dispatch_button_click(low_word)

            def _do_install():
                filt = _ThumbBarMessageFilter(_on_message)
                Application.AddMessageFilter(filt)
                self._message_filter = filt  # simpan SETELAH AddMessageFilter sukses

            # PENTING: Application.AddMessageFilter() itu thread-affine — filter
            # cuma nyantol ke message-loop di THREAD yang manggil method ini.
            # Kalau init_buttons() (dipanggil dari `window.events.shown`) ternyata
            # gak dieksekusi persis di thread UI WinForms asli (bisa aja beda,
            # tergantung gimana pywebview nge-dispatch event-nya), filter gak akan
            # PERNAH kepanggil — dan ini TIDAK nge-throw error apapun, cuma diem.
            # Makanya kita paksa lewat native.Invoke() biar pasti eksekusi di
            # thread yang sama dengan message loop Form aslinya.
            native = getattr(self._window, "native", None) if self._window is not None else None
            if native is not None and getattr(native, "InvokeRequired", False):
                native.Invoke(MethodInvoker(_do_install))
            else:
                _do_install()

        def _restore_message_filter(self):
            if self._message_filter is not None:
                try:
                    native = getattr(self._window, "native", None) if self._window is not None else None
                    if native is not None and getattr(native, "InvokeRequired", False):
                        native.Invoke(MethodInvoker(
                            lambda: Application.RemoveMessageFilter(self._message_filter)))
                    else:
                        Application.RemoveMessageFilter(self._message_filter)
                except Exception:
                    pass
                self._message_filter = None

        def _handle_button_click(self, btn_id):
            if btn_id == BTN_ID_PREV:
                self.previous_requested.emit()
            elif btn_id == BTN_ID_PLAYPAUSE:
                self.play_pause_requested.emit()
            elif btn_id == BTN_ID_NEXT:
                self.next_requested.emit()

else:
    # ── No-op fallback: non-Windows, atau TASKBAR_THUMBBAR_ENABLED = False ──
    class TaskbarThumbBar:  # noqa: F811
        def __init__(self, window=None, window_title=None, icon_size=24, icon_rgb=(255, 255, 255)):
            self.previous_requested = _Signal()
            self.play_pause_requested = _Signal()
            self.next_requested = _Signal()

        def init_buttons(self):
            pass

        def set_playing(self, is_playing: bool):
            pass

        def set_enabled_buttons(self, has_prev: bool = True, has_next: bool = True):
            pass

        def shutdown(self):
            pass
