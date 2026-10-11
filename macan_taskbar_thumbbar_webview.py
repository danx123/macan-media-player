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

THUMBNAIL SINKRON (BARU — diadaptasi dari `macan_taskbar_thumbbar.py` versi Qt)
--------------------------------------------------------------------------
Keluhan sebelumnya: preview thumbnail taskbar GAK SINKRON saat di-hover /
setelah klik Prev/Next. Penyebabnya: DWM cuma nampilin snapshot window
(WebView2 dirender lewat DirectComposition, jadi snapshot-nya gampang basi /
hitam, apalagi pas window minimize) — thumbnail gak tahu lagu sudah ganti.

Solusi sama kayak versi Qt: artwork + judul + artis digambar SENDIRI
(Iconic Thumbnail + Iconic Live Preview via DWM) dan DWM disuruh ambil ulang
(`DwmInvalidateIconicBitmaps`) tiap kali info lagu berubah.

Beda teknis dari versi Qt (karena gak ada Qt di process ini):
  - Render pakai `System.Drawing` (GDI+) lewat pythonnet, bukan QPainter.
    Kalau System.Drawing gagal ke-load, fitur thumbnail custom mati sendiri
    dan tombol Prev/Play/Next tetap jalan.
  - `IMessageFilter` WinForms CUMA lihat pesan yang di-POST ke message queue,
    sedangkan pesan DWM (WM_DWMSENDICONICTHUMBNAIL / ..LIVEPREVIEWBITMAP) dan
    WM_SIZE itu SENT -> gak pernah lewat filter. Makanya buat pesan-pesan itu
    dipasang `SetWindowSubclass` (comctl32, cara subclass yang resmi & ngerantai
    bener lewat DefSubclassProc) dari UI thread. Klik tombol thumbbar TETAP
    lewat IMessageFilter seperti sebelumnya (gak diutak-atik).
  - Kalau pesan DWM ternyata gak pernah nyampe (subclass gagal), modul ini
    fallback ke mode PUSH: bitmap langsung didorong ke DWM tiap info lagu
    berubah.

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

    # [BARU] tiap kali lagu / artwork berubah (WAJIB dipanggil dari JS lewat
    # js_api, mis. di dalam fungsi yang dipanggil nextTrack()/prevTrack()/
    # auto-next). artwork boleh: bytes, data-URI base64, path file, URL http(s),
    # atau None:
    tb.update_track(title, artist, artwork)
    tb.set_accent("#0d6efd")       # opsional, ikut tema/aura

    # opsional (kalau mau, buat jaga-jaga): sinkron state minimize dari event
    # pywebview kalau subclass DWM gak aktif:
    #   window.events.minimized += lambda: tb.notify_minimized(True)
    #   window.events.restored  += lambda: tb.notify_minimized(False)

    # saat app mau ditutup:
    tb.shutdown()

Non-Windows -> otomatis no-op (aman dipanggil tanpa try/except di caller).
"""

import sys
import os
import re
import time
import base64
import threading

IS_WINDOWS = sys.platform == "win32"

# Guard darurat: kalau window-subclassing ternyata bikin masalah di build
# tertentu, cukup ubah ini jadi False — seluruh fitur taskbar thumbbar mati
# bersih tanpa perlu ubah kode integrasi di main.py.
TASKBAR_THUMBBAR_ENABLED = True

# Thumbnail CUSTOM (iconic thumbnail DWM): artwork + judul + artis digambar
# sendiri supaya preview taskbar sinkron sama lagu yang lagi diputar, bukan
# snapshot WebView2 yang suka basi. Kalau bermasalah, matikan di sini — tombol
# Prev/Play/Next tetap jalan normal.
THUMBNAIL_CUSTOM_ENABLED = True

# False (default): thumbnail custom dipakai saat window di-minimize (sama
# persis kayak versi Qt). True: dipakai TERUS, termasuk saat window tampil
# normal — pilih ini kalau live thumbnail WebView2 saat hover masih kelihatan
# basi/hitam. Efek samping: Alt+Tab / Aero Peek juga nampilin kartu custom.
THUMBNAIL_ALWAYS_CUSTOM = False

# True -> print log DWM (request thumbnail, invalidate, HRESULT) buat debug.
THUMBNAIL_DEBUG = False


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

    # System.Drawing (GDI+) buat render kartu thumbnail. Sudah ke-load oleh
    # pywebview winforms backend, tapi tetap dibungkus try/except: kalau gagal,
    # cuma thumbnail custom yang mati, tombol thumbbar gak ikut kena.
    try:
        clr.AddReference("System.Drawing")
        from System import Convert
        from System.IO import MemoryStream
        from System.Drawing import (
            Bitmap, Graphics, Color, Rectangle, RectangleF, PointF, Font,
            FontStyle, GraphicsUnit, SolidBrush, StringFormat, StringAlignment,
            StringTrimming, StringFormatFlags, Image,
        )
        from System.Drawing.Drawing2D import (
            LinearGradientBrush, GraphicsPath, SmoothingMode,
            InterpolationMode, PixelOffsetMode,
        )
        from System.Drawing.Imaging import PixelFormat, ImageLockMode
        from System.Drawing.Text import TextRenderingHint
        _DRAWING_OK = True
    except Exception as _draw_err:
        _DRAWING_OK = False
        print(f"[TaskbarThumbBar] System.Drawing gagal dimuat, thumbnail custom "
              f"dimatikan: {_draw_err}")

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

    # ── DWM iconic thumbnail (thumbnail saat window minimize / preview custom) ──
    WM_SIZE = 0x0005
    WM_NCDESTROY = 0x0082
    SIZE_MINIMIZED = 1
    WM_DWMSENDICONICTHUMBNAIL = 0x0323
    WM_DWMSENDICONICLIVEPREVIEWBITMAP = 0x0326
    DWMWA_FORCE_ICONIC_REPRESENTATION = 7
    DWMWA_HAS_ICONIC_BITMAP = 10
    _SUBCLASS_ID = 0x4D4143  # "MAC"
    _WATCHED_MSGS = frozenset((
        WM_SIZE, WM_NCDESTROY,
        WM_DWMSENDICONICTHUMBNAIL, WM_DWMSENDICONICLIVEPREVIEWBITMAP,
    ))
    # Callback ctypes yang sudah dipasang sebagai subclass TIDAK BOLEH di-GC
    # selama window hidup (crash kalau Windows manggil pointer yang sudah
    # bebas) — makanya disimpan di list modul-level, gak pernah dikosongkan.
    _KEEPALIVE = []

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

    # ── API Win32 bertipe (WinDLL PRIVAT, bukan ctypes.windll) ──────────────
    # Instance privat biar argtypes/restype yang di-set di sini gak nabrak
    # modul lain di proses yang sama (pola yang sama kayak versi Qt). Tanpa
    # argtypes, HWND/HBITMAP 64-bit bisa kepotong jadi c_int.
    _u32 = ctypes.WinDLL("user32", use_last_error=True)
    _g32 = ctypes.WinDLL("gdi32", use_last_error=True)
    dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
    comctl32 = ctypes.WinDLL("comctl32", use_last_error=True)

    _u32.GetDC.argtypes = [wintypes.HWND]
    _u32.GetDC.restype = wintypes.HDC
    _u32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    _u32.ReleaseDC.restype = ctypes.c_int
    _u32.CreateIconIndirect.argtypes = [ctypes.POINTER(ICONINFO)]
    _u32.CreateIconIndirect.restype = wintypes.HICON
    _u32.DestroyIcon.argtypes = [wintypes.HICON]
    _u32.DestroyIcon.restype = wintypes.BOOL
    _u32.IsIconic.argtypes = [wintypes.HWND]
    _u32.IsIconic.restype = wintypes.BOOL
    _u32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    _u32.GetClientRect.restype = wintypes.BOOL

    _g32.CreateDIBSection.argtypes = [
        wintypes.HDC, ctypes.c_void_p, wintypes.UINT,
        ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD,
    ]
    _g32.CreateDIBSection.restype = wintypes.HBITMAP
    _g32.CreateBitmap.argtypes = [
        ctypes.c_int, ctypes.c_int, wintypes.UINT, wintypes.UINT, ctypes.c_void_p,
    ]
    _g32.CreateBitmap.restype = wintypes.HBITMAP
    _g32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    _g32.DeleteObject.restype = wintypes.BOOL

    dwmapi.DwmSetWindowAttribute.argtypes = [
        wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
    ]
    dwmapi.DwmSetWindowAttribute.restype = ctypes.c_long
    dwmapi.DwmSetIconicThumbnail.argtypes = [
        wintypes.HWND, wintypes.HBITMAP, wintypes.DWORD,
    ]
    dwmapi.DwmSetIconicThumbnail.restype = ctypes.c_long
    dwmapi.DwmSetIconicLivePreviewBitmap.argtypes = [
        wintypes.HWND, wintypes.HBITMAP, ctypes.POINTER(wintypes.POINT), wintypes.DWORD,
    ]
    dwmapi.DwmSetIconicLivePreviewBitmap.restype = ctypes.c_long
    dwmapi.DwmInvalidateIconicBitmaps.argtypes = [wintypes.HWND]
    dwmapi.DwmInvalidateIconicBitmaps.restype = ctypes.c_long

    # Subclass resmi comctl32 (SetWindowSubclass) — beda dari SetWindowLongPtrW
    # yang dulu gak reliable: callback-nya dirantai lewat DefSubclassProc dan
    # WAJIB dipasang/dilepas dari thread yang bikin window (UI thread).
    _SUBCLASSPROC = ctypes.WINFUNCTYPE(
        ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM,
        wintypes.LPARAM, ctypes.c_size_t, ctypes.c_size_t,
    )
    comctl32.SetWindowSubclass.argtypes = [
        wintypes.HWND, _SUBCLASSPROC, ctypes.c_size_t, ctypes.c_size_t,
    ]
    comctl32.SetWindowSubclass.restype = wintypes.BOOL
    comctl32.RemoveWindowSubclass.argtypes = [
        wintypes.HWND, _SUBCLASSPROC, ctypes.c_size_t,
    ]
    comctl32.RemoveWindowSubclass.restype = wintypes.BOOL
    comctl32.DefSubclassProc.argtypes = [
        wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
    ]
    comctl32.DefSubclassProc.restype = ctypes.c_ssize_t

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

    def _bgra_to_hbitmap(bgra_bytes, w, h):
        """Buffer BGRA premultiplied top-down -> HBITMAP 32-bit ARGB (DIB
        section). Caller WAJIB gdi32.DeleteObject() hasilnya. Analog
        `_qimage_to_hbitmap` di versi Qt."""
        if w <= 0 or h <= 0 or len(bgra_bytes) < w * h * 4:
            return None
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

        hdc = _u32.GetDC(None)
        ppv_bits = ctypes.c_void_p()
        hbm = _g32.CreateDIBSection(
            hdc, ctypes.byref(bmi), 0, ctypes.byref(ppv_bits), None, 0
        )
        _u32.ReleaseDC(None, hdc)
        if not hbm or not ppv_bits.value:
            return None
        ctypes.memmove(ppv_bits.value, bgra_bytes, w * h * 4)
        return hbm

    def _rgba_bgra_to_hicon(bgra_bytes: bytes, size: int):
        """Convert buffer BGRA top-down (dari _draw_icon_rgba) -> Win32 HICON
        32-bit alpha lewat GDI DIB section. Analog sama _qimage_to_hicon di
        versi Qt, tapi sumbernya raw bytes, bukan QImage."""
        hbm_color = _bgra_to_hbitmap(bgra_bytes, size, size)
        if not hbm_color:
            return None
        hbm_mask = _g32.CreateBitmap(size, size, 1, 1, None)

        icon_info = ICONINFO()
        icon_info.fIcon = True
        icon_info.xHotspot = 0
        icon_info.yHotspot = 0
        icon_info.hbmMask = hbm_mask
        icon_info.hbmColor = hbm_color

        hicon = _u32.CreateIconIndirect(ctypes.byref(icon_info))

        _g32.DeleteObject(hbm_color)
        if hbm_mask:
            _g32.DeleteObject(hbm_mask)

        return hicon if hicon else None

    def _find_hwnd_by_title(title, retries=15, delay=0.2):
        for _ in range(retries):
            hwnd = user32.FindWindowW(None, title)
            if hwnd:
                return hwnd
            time.sleep(delay)
        return 0

    def _dbg(msg):
        if THUMBNAIL_DEBUG:
            print(f"[TaskbarThumbBar][dbg] {msg}")

    def _parse_color(value, default=(13, 110, 253)):
        """'#RRGGBB' / '#RGB' / '#RRGGBBAA' / 'rgb(r,g,b)' / (r,g,b) -> (r,g,b)."""
        try:
            if value is None:
                return default
            if isinstance(value, (tuple, list)) and len(value) >= 3:
                return tuple(max(0, min(255, int(v))) for v in value[:3])
            s = str(value).strip().lower()
            if s.startswith("#"):
                s = s[1:]
                if len(s) == 3:
                    s = "".join(c * 2 for c in s)
                if len(s) in (6, 8):
                    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
            elif s.startswith("rgb"):
                nums = re.findall(r"[\d.]+", s)[:3]
                if len(nums) == 3:
                    return tuple(max(0, min(255, int(float(n)))) for n in nums)
        except Exception:
            pass
        return default

    def _resolve_artwork_source(artwork):
        """artwork -> ("bytes", data) | ("url", str) | None.
        Terima: bytes/bytearray, data-URI, path file / file:// URI, URL http(s)."""
        if artwork is None:
            return None
        try:
            if isinstance(artwork, (bytes, bytearray, memoryview)):
                b = bytes(artwork)
                return ("bytes", b) if b else None
            if isinstance(artwork, str):
                s = artwork.strip()
                if not s:
                    return None
                if s.startswith("data:"):
                    head, _, payload = s.partition(",")
                    if ";base64" in head.lower():
                        payload = payload.strip()
                        payload += "=" * (-len(payload) % 4)
                        return ("bytes", base64.b64decode(payload))
                    from urllib.parse import unquote_to_bytes
                    return ("bytes", unquote_to_bytes(payload))
                if s.lower().startswith(("http://", "https://")):
                    return ("url", s)
                path = s
                if s.lower().startswith("file:"):
                    from urllib.parse import urlparse
                    from urllib.request import url2pathname
                    path = url2pathname(urlparse(s).path)
                if os.path.isfile(path):
                    with open(path, "rb") as f:
                        return ("bytes", f.read())
        except Exception as e:
            print(f"[TaskbarThumbBar] Gagal baca artwork: {e}")
        return None

    def _bytes_to_art_bitmap(data, max_side):
        """Bytes gambar -> System.Drawing.Bitmap (32bppPArgb, di-downscale ke
        max_side) atau None. Dipakai buat nyimpen cover tanpa nyimpen file
        3000x3000 apa adanya. Stream sumber dilepas SEBELUM return (GDI+
        butuh stream hidup selama Image-nya hidup, makanya di-copy ke Bitmap
        baru)."""
        if not _DRAWING_OK or not data:
            return None
        ms = None
        src = None
        try:
            ms = MemoryStream(Convert.FromBase64String(base64.b64encode(data).decode("ascii")))
            src = Image.FromStream(ms)
            sw, sh = int(src.Width), int(src.Height)
            if sw <= 0 or sh <= 0:
                return None
            scale = min(1.0, float(max_side) / max(sw, sh))
            nw, nh = max(1, int(sw * scale)), max(1, int(sh * scale))
            dst = Bitmap(nw, nh, PixelFormat.Format32bppPArgb)
            g = Graphics.FromImage(dst)
            try:
                g.InterpolationMode = InterpolationMode.HighQualityBicubic
                g.PixelOffsetMode = PixelOffsetMode.HighQuality
                g.DrawImage(src, Rectangle(0, 0, nw, nh))
            finally:
                g.Dispose()
            return dst
        except Exception as e:
            print(f"[TaskbarThumbBar] Gagal decode artwork: {e}")
            return None
        finally:
            try:
                if src is not None:
                    src.Dispose()
                if ms is not None:
                    ms.Dispose()
            except Exception:
                pass

    def _round_rect_path(x, y, w, h, r):
        p = GraphicsPath()
        r = max(0.5, min(float(r), w / 2.0, h / 2.0))
        d = r * 2.0
        x, y, w, h = float(x), float(y), float(w), float(h)
        p.AddArc(x, y, d, d, 180.0, 90.0)
        p.AddArc(x + w - d, y, d, d, 270.0, 90.0)
        p.AddArc(x + w - d, y + h - d, d, d, 0.0, 90.0)
        p.AddArc(x, y + h - d, d, d, 90.0, 90.0)
        p.CloseFigure()
        return p

    class TaskbarThumbBar:
        """
        Tombol Previous / Play-Pause / Next di preview thumbnail taskbar
        Windows — versi toolkit-agnostic (dipakai lewat HWND langsung, bukan
        lewat widget Qt).

        Semua method publik AMAN dipanggil tanpa try/except di kode
        pemanggil; kalau ada apapun yang gagal (COM, window subclassing,
        dst), fitur ini fail-safe mati sendiri.
        """

        # Batas sisi artwork yang disimpan di memori (cukup buat thumbnail
        # & peek; menghindari nyimpen cover 3000x3000 apa adanya).
        _ART_CACHE_MAX = 512
        # Jeda koalesensi invalidate (detik): embedded art + online art /
        # prev-next beruntun cukup memicu 1x refresh.
        _INVALIDATE_DELAY = 0.06

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
            self._prev_enabled = True
            self._next_enabled = True

            # State thumbnail custom
            self._title = ""
            self._artist = ""
            self._art_bmp = None            # System.Drawing.Bitmap (sudah di-downscale) / None
            self._art_key = None            # kunci artwork terakhir (skip decode ulang)
            self._art_token = 0             # naik tiap update_track (buang fetch URL basi)
            self._accent = (13, 110, 253)
            self._state_ver = 0             # naik tiap state visual berubah (kunci cache frame)
            self._frame_cache = {}          # kind -> (ver, w, h, bgra_bytes)
            self._render_lock = threading.RLock()
            self._timer_lock = threading.Lock()
            self._invalidate_timer = None
            self._iconic_ready = False      # DWMWA_HAS_ICONIC_BITMAP sudah aktif
            self._forced_iconic = False
            self._dwm_msg_seen = False      # pernah nerima pesan DWM? (subclass hidup)
            self._push_fail_streak = 0
            self._last_max = None           # (w, h) maksimum thumbnail dari DWM
            self._last_client = None        # ukuran client terakhir saat gak minimize
            self._subclass_cb = None
            self._closing = False

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
                return

            # Thumbnail custom dipisah try/except-nya: kalau ini gagal, tombol
            # thumbbar di atas tetap harus jalan.
            try:
                self._enable_iconic_thumbnail()
            except Exception as e:
                print(f"[TaskbarThumbBar] Gagal aktifkan custom thumbnail: {e}")
                self._iconic_ready = False

        def update_track(self, title: str = "", artist: str = "", artwork=None):
            """[BARU] Beritahu thumbbar bahwa lagu/artwork berubah. Panggil dari
            JS (lewat js_api) tiap lagu ganti — termasuk auto-next dan hasil
            klik Prev/Next dari tombol thumbbar — serta saat artwork online
            ketemu. artwork: bytes | data-URI | path file | URL http(s) | None.
            Aman dipanggil dari thread manapun & sebelum window tampil."""
            new_bmp = None
            key = None
            keep_art = False
            fetch_url = None
            if self._enabled and _DRAWING_OK and artwork is not None:
                src = _resolve_artwork_source(artwork)
                if src is not None:
                    kind, val = src
                    key = ("b", len(val), hash(val)) if kind == "bytes" else ("u", val)
                    if key == self._art_key and self._art_bmp is not None:
                        keep_art = True   # cover sama (album sama) -> skip decode
                    elif kind == "bytes":
                        new_bmp = _bytes_to_art_bitmap(val, self._ART_CACHE_MAX)
                        if new_bmp is None:
                            key = None
                    else:
                        fetch_url = val
            with self._render_lock:
                self._title = title or ""
                self._artist = artist or ""
                if not keep_art:
                    self._swap_art_locked(new_bmp, key)
                self._state_ver += 1
                self._art_token += 1
                token = self._art_token
            _dbg(f"update_track: {artist} - {title} | art={'ya' if (keep_art or new_bmp is not None) else ('url' if fetch_url else 'tidak')}")
            if fetch_url:
                self._fetch_art_async(fetch_url, token)
            self.refresh_thumbnail()

        def set_accent(self, color):
            """[BARU] Warna aksen (tema / Dynamic Aura) buat latar & teks artis."""
            rgb = _parse_color(color)
            with self._render_lock:
                if rgb == self._accent:
                    return
                self._accent = rgb
                self._state_ver += 1
            self.refresh_thumbnail()

        def refresh_thumbnail(self, delay=None):
            """[BARU] Minta DWM ambil ulang thumbnail/peek (dikoalesensi: panggilan
            beruntun dalam `delay` detik cuma memicu 1x refresh)."""
            if self._closing or not self._enabled or not self._iconic_ready:
                return
            d = self._INVALIDATE_DELAY if delay is None else float(delay)
            with self._timer_lock:
                if self._invalidate_timer is not None:
                    self._invalidate_timer.cancel()
                t = threading.Timer(d, self._do_invalidate)
                t.daemon = True
                self._invalidate_timer = t
                t.start()

        def notify_minimized(self, minimized: bool):
            """[BARU] Opsional: kasih tahu manual kalau window minimize/restore
            (mis. dari `window.events.minimized/restored` pywebview) — cadangan
            kalau subclass WM_SIZE gak aktif."""
            try:
                self._on_window_size_changed(bool(minimized))
            except Exception as e:
                print(f"[TaskbarThumbBar] notify_minimized gagal: {e}")

        def set_playing(self, is_playing: bool):
            if not self._enabled or not self._buttons_added:
                self._is_playing = is_playing
                return
            if self._is_playing == is_playing:
                return
            self._is_playing = is_playing
            # Dipanggil dari thread js_api -> update COM ITaskbarList3 harus
            # balik ke UI/STA thread tempat object-nya dibikin.
            self._ui_async(self._safe_update_buttons)

        def set_enabled_buttons(self, has_prev: bool = True, has_next: bool = True):
            if not self._enabled or not self._buttons_added:
                return
            self._prev_enabled = bool(has_prev)
            self._next_enabled = bool(has_next)
            self._ui_async(self._safe_update_buttons)

        def shutdown(self):
            if not IS_WINDOWS:
                return
            self._closing = True
            self._iconic_ready = False
            try:
                with self._timer_lock:
                    if self._invalidate_timer is not None:
                        self._invalidate_timer.cancel()
                        self._invalidate_timer = None
            except Exception:
                pass
            try:
                self._remove_subclass()
            except Exception:
                pass
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
            # Bebaskan HICON tombol & bitmap artwork
            try:
                for hicon in self._icons.values():
                    if hicon:
                        _u32.DestroyIcon(hicon)
                self._icons.clear()
            except Exception:
                pass
            try:
                with self._render_lock:
                    self._swap_art_locked(None, None)
                    self._frame_cache.clear()
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

        def _make_buttons_array(self, prev_enabled=None, next_enabled=None):
            # None -> pakai state terakhir (sebelumnya set_playing() ikut
            # ngereset prev/next jadi enabled lagi).
            if prev_enabled is None:
                prev_enabled = self._prev_enabled
            if next_enabled is None:
                next_enabled = self._next_enabled
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

        def _update_buttons(self, prev_enabled=None, next_enabled=None):
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
                return
            try:
                if self._iconic_ready:
                    self._set_iconic_attribute()
            except Exception as e:
                print(f"[TaskbarThumbBar] Gagal re-aktifkan custom thumbnail: {e}")

        # ── Internal: helper thread UI ────────────────────────────────────
        def _native(self):
            return getattr(self._window, "native", None) if self._window is not None else None

        def _ui_async(self, fn):
            """Jalankan fn di UI thread tanpa nunggu (BeginInvoke). Aman buat
            COM ITaskbarList3 karena object-nya STA & dibikin di UI thread.
            JANGAN dipakai buat apapun yang manggil evaluate_js."""
            native = self._native()
            if native is not None:
                try:
                    if getattr(native, "InvokeRequired", False):
                        native.BeginInvoke(MethodInvoker(fn))
                        return
                except Exception as e:
                    print(f"[TaskbarThumbBar] BeginInvoke gagal, jalan langsung: {e}")
            fn()

        def _run_on_ui_sync(self, fn):
            """Jalankan fn di UI thread dan TUNGGU selesai (Invoke); exception
            dari fn diteruskan ke pemanggil."""
            native = self._native()
            if native is not None and getattr(native, "InvokeRequired", False):
                err = []

                def _w():
                    try:
                        fn()
                    except Exception as e:
                        err.append(e)

                native.Invoke(MethodInvoker(_w))
                if err:
                    raise err[0]
            else:
                fn()

        def _safe_update_buttons(self):
            try:
                self._update_buttons()
            except Exception as e:
                print(f"[TaskbarThumbBar] Gagal update tombol: {e}")

        # ── Internal: custom iconic thumbnail ─────────────────────────────
        def _enable_iconic_thumbnail(self):
            if not (THUMBNAIL_CUSTOM_ENABLED and _DRAWING_OK):
                return
            self._set_iconic_attribute()
            if not self._iconic_ready:
                return
            try:
                self._install_subclass()
            except Exception as e:
                # Gak fatal: tanpa subclass modul ini fallback ke mode PUSH
                # (bitmap didorong ke DWM tiap lagu berubah).
                print(f"[TaskbarThumbBar] Gagal pasang subclass DWM, fallback ke mode push: {e}")

        def _set_iconic_attribute(self):
            """Aktifkan DWMWA_HAS_ICONIC_BITMAP: saat minimize DWM minta bitmap
            ke kita; saat window tampil normal, live thumbnail biasa tetap
            dipakai (kecuali THUMBNAIL_ALWAYS_CUSTOM)."""
            hwnd = self._hwnd
            if not hwnd:
                return
            val = ctypes.c_int(1)
            hr = dwmapi.DwmSetWindowAttribute(
                hwnd, DWMWA_HAS_ICONIC_BITMAP, ctypes.byref(val), ctypes.sizeof(val))
            self._iconic_ready = (hr == S_OK)
            _dbg(f"iconic enable: hwnd={hwnd} hr=0x{hr & 0xFFFFFFFF:08X} ready={self._iconic_ready}")
            if self._iconic_ready:
                self._sync_iconic_state()
                # Segera sinkronkan dgn lagu yang sudah ter-set sebelum window tampil
                self.refresh_thumbnail(delay=0.05)

        def _install_subclass(self):
            if self._subclass_cb is not None:
                return
            hwnd = self._hwnd
            owner = self
            holder = [None]

            def _proc(h, msg, wparam, lparam, uid, ref):
                # Jalur panas: dipanggil buat SETIAP pesan window -> cek paling
                # murah dulu, sisanya langsung diteruskan.
                if msg in _WATCHED_MSGS:
                    try:
                        if msg == WM_NCDESTROY:
                            comctl32.RemoveWindowSubclass(h, holder[0], _SUBCLASS_ID)
                        elif not owner._closing:
                            r = owner._on_subclass_message(h, msg, wparam, lparam)
                            if r is not None:
                                return r
                    except Exception as e:
                        print(f"[TaskbarThumbBar] Error di subclass proc: {e}")
                return comctl32.DefSubclassProc(h, msg, wparam, lparam)

            cb = _SUBCLASSPROC(_proc)
            holder[0] = cb

            def _do():
                if not comctl32.SetWindowSubclass(hwnd, cb, _SUBCLASS_ID, 0):
                    raise OSError("SetWindowSubclass gagal")

            # Wajib dari thread pembuat window (UI thread).
            self._run_on_ui_sync(_do)
            self._subclass_cb = cb
            _KEEPALIVE.append(cb)
            _dbg(f"subclass DWM terpasang di hwnd={hwnd}")

        def _remove_subclass(self):
            cb = self._subclass_cb
            if cb is None:
                return
            hwnd = self._hwnd

            def _do():
                try:
                    comctl32.RemoveWindowSubclass(hwnd, cb, _SUBCLASS_ID)
                except Exception:
                    pass

            # Async: aman dari deadlock saat shutdown. `cb` tetap di _KEEPALIVE
            # (gak pernah di-GC), dan flag _closing bikin proc cuma pass-through.
            self._ui_async(_do)

        def _on_subclass_message(self, hwnd, msg, wparam, lparam):
            """Dipanggil dari subclass proc (UI thread). Return None = terusin
            ke DefSubclassProc; return angka = pesan sudah ditangani."""
            if hwnd != self._hwnd:
                return None
            if msg == WM_SIZE:
                minimized = (wparam == SIZE_MINIMIZED)
                if not minimized:
                    lp = lparam & 0xFFFFFFFF
                    cw, ch = lp & 0xFFFF, (lp >> 16) & 0xFFFF
                    if cw > 0 and ch > 0:
                        self._last_client = (cw, ch)
                self._on_window_size_changed(minimized)
                return None
            if msg == WM_DWMSENDICONICTHUMBNAIL:
                # lParam: HIWORD = max width, LOWORD = max height
                lp = lparam & 0xFFFFFFFF
                self._on_iconic_thumbnail_requested((lp >> 16) & 0xFFFF, lp & 0xFFFF)
                return 0
            if msg == WM_DWMSENDICONICLIVEPREVIEWBITMAP:
                self._on_iconic_preview_requested()
                return 0
            return None

        def _sync_iconic_state(self):
            """Samakan flag force-iconic dgn kondisi window sekarang (jaga-jaga
            kalau WM_SIZE gak pernah nyampe)."""
            try:
                self._on_window_size_changed(bool(_u32.IsIconic(self._hwnd)))
            except Exception:
                pass

        def _on_window_size_changed(self, minimized: bool):
            """Saat minimize, paksa DWM pakai representasi iconic (bitmap dari
            kita); saat restore, kembalikan ke live thumbnail biasa (kecuali
            THUMBNAIL_ALWAYS_CUSTOM)."""
            if not (self._enabled and self._iconic_ready):
                return
            want = True if THUMBNAIL_ALWAYS_CUSTOM else bool(minimized)
            if want == self._forced_iconic:
                return
            self._forced_iconic = want
            hwnd = self._hwnd
            val = ctypes.c_int(1 if want else 0)
            hr = dwmapi.DwmSetWindowAttribute(
                hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION,
                ctypes.byref(val), ctypes.sizeof(val))
            _dbg(f"force-iconic={want} (minimized={minimized}) hr=0x{hr & 0xFFFFFFFF:08X}")
            if want:
                dwmapi.DwmInvalidateIconicBitmaps(hwnd)

        def _do_invalidate(self):
            """Jalan di thread Timer (hasil koalesensi refresh_thumbnail)."""
            if self._closing or not (self._enabled and self._iconic_ready):
                return
            try:
                hwnd = self._hwnd
                self._sync_iconic_state()
                hr = dwmapi.DwmInvalidateIconicBitmaps(hwnd)
                _dbg(f"invalidate hr=0x{hr & 0xFFFFFFFF:08X} msg_seen={self._dwm_msg_seen}")
                if not self._dwm_msg_seen:
                    # Belum pernah ada pesan DWM yang nyampe -> kemungkinan
                    # subclass gak aktif. Dorong bitmap langsung ke DWM.
                    self._push_bitmaps()
            except Exception as e:
                print(f"[TaskbarThumbBar] Gagal invalidate thumbnail: {e}")

        def _push_bitmaps(self):
            """Mode PUSH (fallback): kirim thumbnail + peek ke DWM tanpa nunggu
            diminta. Ukuran maksimum thumbnail belum diketahui -> coba dari
            besar ke kecil sampai DWM nerima."""
            if self._push_fail_streak >= 3:
                return
            boxes = [self._last_max] if self._last_max else [
                (480, 480), (360, 360), (300, 300), (240, 240), (200, 200), (160, 160)]
            ok = False
            for mw, mh in boxes:
                hr = self._set_iconic_thumbnail(mw, mh)
                _dbg(f"push thumbnail box={mw}x{mh} hr=0x{hr & 0xFFFFFFFF:08X}")
                if hr == S_OK:
                    ok = True
                    break
            hr2 = self._set_iconic_preview()
            _dbg(f"push preview hr=0x{hr2 & 0xFFFFFFFF:08X}")
            self._push_fail_streak = 0 if ok else self._push_fail_streak + 1

        def _on_iconic_thumbnail_requested(self, max_w: int, max_h: int):
            """DWM minta bitmap thumbnail (hover taskbar)."""
            self._dwm_msg_seen = True
            _dbg(f"DWM minta thumbnail {max_w}x{max_h} | {self._artist} - {self._title}")
            if max_w <= 0 or max_h <= 0:
                return
            self._last_max = (max_w, max_h)
            hr = self._set_iconic_thumbnail(max_w, max_h)
            _dbg(f"set thumbnail hr=0x{hr & 0xFFFFFFFF:08X}")

        def _on_iconic_preview_requested(self):
            """DWM minta bitmap peek (hover thumbnail -> preview besar)."""
            self._dwm_msg_seen = True
            hr = self._set_iconic_preview()
            _dbg(f"set preview hr=0x{hr & 0xFFFFFFFF:08X}")

        def _set_iconic_thumbnail(self, max_w, max_h):
            ww, wh = self._window_size()
            scale = min(max_w / ww, max_h / wh)
            w, h = max(1, int(ww * scale)), max(1, int(wh * scale))
            data = self._get_frame("thumb", w, h)
            if not data:
                return -1
            hbm = _bgra_to_hbitmap(data, w, h)
            if not hbm:
                return -1
            try:
                return dwmapi.DwmSetIconicThumbnail(self._hwnd, hbm, 0)
            finally:
                _g32.DeleteObject(hbm)  # DWM sudah menyalin bitmap-nya

        def _set_iconic_preview(self):
            ww, wh = self._window_size()
            data = self._get_frame("peek", ww, wh)
            if not data:
                return -1
            hbm = _bgra_to_hbitmap(data, ww, wh)
            if not hbm:
                return -1
            try:
                return dwmapi.DwmSetIconicLivePreviewBitmap(self._hwnd, hbm, None, 0)
            finally:
                _g32.DeleteObject(hbm)

        def _window_size(self):
            """Ukuran client window. Saat minimize GetClientRect = 0, jadi
            pakai ukuran terakhir yang tercatat waktu window masih normal."""
            hwnd = self._hwnd
            try:
                if hwnd and not _u32.IsIconic(hwnd):
                    rc = wintypes.RECT()
                    if _u32.GetClientRect(hwnd, ctypes.byref(rc)):
                        w, h = rc.right - rc.left, rc.bottom - rc.top
                        if w > 0 and h > 0:
                            self._last_client = (w, h)
                            return w, h
            except Exception:
                pass
            if self._last_client:
                return self._last_client
            try:
                w, h = int(self._window.width), int(self._window.height)
                if w > 0 and h > 0:
                    return w, h
            except Exception:
                pass
            return 480, 360

        # ── Internal: state artwork ───────────────────────────────────────
        def _swap_art_locked(self, bmp, key):
            """Ganti bitmap artwork (WAJIB dipanggil dgn _render_lock dipegang)."""
            old = self._art_bmp
            self._art_bmp = bmp
            self._art_key = key
            if old is not None and old is not bmp:
                try:
                    old.Dispose()
                except Exception:
                    pass

        def _fetch_art_async(self, url, token):
            """Ambil cover dari URL di thread terpisah (gak ngeblok js_api)."""
            def _run():
                try:
                    import urllib.request
                    req = urllib.request.Request(
                        url, headers={"User-Agent": "MacanMediaPlayer/1.0"})
                    with urllib.request.urlopen(req, timeout=6) as r:
                        data = r.read(8 * 1024 * 1024)
                    bmp = _bytes_to_art_bitmap(data, self._ART_CACHE_MAX)
                except Exception as e:
                    print(f"[TaskbarThumbBar] Gagal fetch artwork URL: {e}")
                    return
                if bmp is None:
                    return
                with self._render_lock:
                    if token != self._art_token or self._closing:
                        try:
                            bmp.Dispose()
                        except Exception:
                            pass
                        return  # lagu sudah ganti lagi, cover ini basi
                    self._swap_art_locked(bmp, ("u", url))
                    self._state_ver += 1
                self.refresh_thumbnail()

            try:
                threading.Thread(target=_run, daemon=True, name="TaskbarThumbBarArt").start()
            except Exception as e:
                print(f"[TaskbarThumbBar] Gagal start thread fetch artwork: {e}")

        # ── Internal: render kartu thumbnail (System.Drawing) ─────────────
        def _get_frame(self, kind, w, h):
            """Frame BGRA premultiplied (di-cache per ukuran & versi state, jadi
            hover berulang gak render ulang)."""
            with self._render_lock:
                c = self._frame_cache.get(kind)
                if c and c[0] == self._state_ver and c[1] == w and c[2] == h:
                    return c[3]
                try:
                    data = self._render_frame(w, h)
                except Exception as e:
                    print(f"[TaskbarThumbBar] Gagal render thumbnail: {e}")
                    return None
                if data:
                    self._frame_cache[kind] = (self._state_ver, w, h, data)
                return data

        def _render_frame(self, w, h):
            """Gambar kartu: latar gradasi aksen, artwork rounded, judul & artis.
            Layout disamakan dgn `_render_frame` versi Qt. Return bytes BGRA
            premultiplied top-down (w*h*4)."""
            if not _DRAWING_OK or w <= 0 or h <= 0:
                return None
            bmp = Bitmap(w, h, PixelFormat.Format32bppPArgb)
            g = Graphics.FromImage(bmp)
            disposables = []
            try:
                g.SmoothingMode = SmoothingMode.AntiAlias
                g.InterpolationMode = InterpolationMode.HighQualityBicubic
                g.PixelOffsetMode = PixelOffsetMode.HighQuality
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit
                g.Clear(Color.Transparent)

                # -- Latar: gelap bernuansa aksen --
                ar, ag, ab = self._accent
                t = 0.30
                top = Color.FromArgb(255, int(18 * (1 - t) + ar * t),
                                     int(18 * (1 - t) + ag * t),
                                     int(18 * (1 - t) + ab * t))
                grad = LinearGradientBrush(
                    PointF(0.0, 0.0), PointF(0.0, float(h)), top,
                    Color.FromArgb(255, 10, 10, 10))
                disposables.append(grad)
                radius = min(w, h) * 0.05
                bg = _round_rect_path(0, 0, w, h, radius)
                disposables.append(bg)
                g.FillPath(grad, bg)

                # -- Artwork (persegi, rounded, center-crop) --
                pad = h * 0.07
                side = max(1.0, min(w - 2 * pad, h * 0.60))
                ax = (w - side) / 2.0
                ay = pad
                art_path = _round_rect_path(ax, ay, side, side, side * 0.06)
                disposables.append(art_path)

                art = self._art_bmp
                if art is not None:
                    aw, ah = float(art.Width), float(art.Height)
                    if aw >= ah:   # center-crop (KeepAspectRatioByExpanding)
                        sw_, sh_ = ah, ah
                        sx_, sy_ = (aw - ah) / 2.0, 0.0
                    else:
                        sw_, sh_ = aw, aw
                        sx_, sy_ = 0.0, (ah - aw) / 2.0
                    g.SetClip(art_path)
                    g.DrawImage(art, RectangleF(float(ax), float(ay), float(side), float(side)),
                                RectangleF(sx_, sy_, sw_, sh_), GraphicsUnit.Pixel)
                    g.ResetClip()
                else:
                    ph = SolidBrush(Color.FromArgb(22, 255, 255, 255))
                    disposables.append(ph)
                    g.FillPath(ph, art_path)
                    f = Font("Segoe UI", float(max(10, int(side * 0.4))),
                             FontStyle.Regular, GraphicsUnit.Pixel)
                    disposables.append(f)
                    sf = StringFormat()
                    disposables.append(sf)
                    sf.Alignment = StringAlignment.Center
                    sf.LineAlignment = StringAlignment.Center
                    nb = SolidBrush(Color.FromArgb(90, 255, 255, 255))
                    disposables.append(nb)
                    g.DrawString("\u266A", f, nb,
                                 RectangleF(float(ax), float(ay), float(side), float(side)), sf)

                # -- Teks: judul & artis, di-elide (trimming ellipsis) --
                text_w = max(1.0, w - 2 * pad)
                ty = ay + side + h * 0.04

                fmt = StringFormat()
                disposables.append(fmt)
                fmt.Alignment = StringAlignment.Center
                fmt.LineAlignment = StringAlignment.Center
                fmt.Trimming = StringTrimming.EllipsisCharacter
                fmt.FormatFlags = StringFormatFlags.NoWrap

                title_font = Font("Segoe UI", float(max(8, int(h * 0.075))),
                                  FontStyle.Bold, GraphicsUnit.Pixel)
                disposables.append(title_font)
                white = SolidBrush(Color.FromArgb(255, 255, 255, 255))
                disposables.append(white)
                title_h = float(title_font.Height)
                g.DrawString(self._title or "Macan Media Player", title_font, white,
                             RectangleF(float(pad), float(ty), float(text_w), title_h), fmt)

                if self._artist:
                    artist_font = Font("Segoe UI", float(max(7, int(h * 0.055))),
                                       FontStyle.Regular, GraphicsUnit.Pixel)
                    disposables.append(artist_font)
                    lr, lg, lb = ar, ag, ab
                    if (0.299 * lr + 0.587 * lg + 0.114 * lb) / 255.0 < 0.55:
                        lr, lg, lb = min(255, int(lr * 1.5)), min(255, int(lg * 1.5)), min(255, int(lb * 1.5))
                    ab_ = SolidBrush(Color.FromArgb(255, lr, lg, lb))
                    disposables.append(ab_)
                    artist_h = float(artist_font.Height)
                    g.DrawString(self._artist, artist_font, ab_,
                                 RectangleF(float(pad), float(ty + title_h), float(text_w), artist_h), fmt)
            finally:
                try:
                    g.Dispose()
                except Exception:
                    pass
                for d in disposables:
                    try:
                        d.Dispose()
                    except Exception:
                        pass

            # Salin pixel dari Bitmap GDI+ ke bytes Python
            try:
                bd = bmp.LockBits(Rectangle(0, 0, w, h), ImageLockMode.ReadOnly,
                                  PixelFormat.Format32bppPArgb)
                try:
                    stride = int(bd.Stride)
                    ptr = int(bd.Scan0.ToInt64())
                    row = w * 4
                    if stride == row:
                        return ctypes.string_at(ptr, row * h)
                    return b"".join(ctypes.string_at(ptr + y * stride, row) for y in range(h))
                finally:
                    bmp.UnlockBits(bd)
            finally:
                bmp.Dispose()

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
                self.refresh_thumbnail(delay=0.35)
            elif btn_id == BTN_ID_PLAYPAUSE:
                self.play_pause_requested.emit()
            elif btn_id == BTN_ID_NEXT:
                self.next_requested.emit()
                self.refresh_thumbnail(delay=0.35)

else:
    # ── No-op fallback: non-Windows, atau TASKBAR_THUMBBAR_ENABLED = False ──
    class TaskbarThumbBar:  # noqa: F811
        def __init__(self, window=None, window_title=None, icon_size=24, icon_rgb=(255, 255, 255)):
            self.previous_requested = _Signal()
            self.play_pause_requested = _Signal()
            self.next_requested = _Signal()

        def init_buttons(self):
            pass

        def update_track(self, title: str = "", artist: str = "", artwork=None):
            pass

        def set_accent(self, color):
            pass

        def refresh_thumbnail(self, delay=None):
            pass

        def notify_minimized(self, minimized: bool):
            pass

        def set_playing(self, is_playing: bool):
            pass

        def set_enabled_buttons(self, has_prev: bool = True, has_next: bool = True):
            pass

        def shutdown(self):
            pass
