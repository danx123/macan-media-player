# core/video_utils.py
import base64
import os
from io import BytesIO

from PIL import Image

import media_engine


class VideoThumbnailer:
    @staticmethod
    def get_thumbnail_at_time(video_path, time_seconds, height=80):
        """
        Mengambil frame video pada detik tertentu dan mengembalikannya sebagai base64.

        Decode & seek sekarang dilakukan oleh `media_engine` (Rust + FFmpeg via
        VideoDecoder.seek_frame), bukan cv2 lagi -- resize & JPEG encode tetap
        di sisi Python pakai Pillow. Array yang dibalikin seek_frame() sudah
        dalam format RGB24 (H, W, 3), jadi tidak perlu konversi BGR->RGB
        seperti waktu masih pakai cv2.
        """
        if not os.path.exists(video_path):
            return None

        try:
            # Bikin decoder baru tiap panggilan (sama seperti cv2.VideoCapture
            # sebelumnya yang dibuka & di-release tiap kali) -- VideoDecoder
            # gak bisa di-share antar thread (pyclass unsendable), jadi aman
            # buat dipanggil dari background thread pool tanpa lock tambahan
            # selama tiap panggilan bikin instance sendiri.
            decoder = media_engine.VideoDecoder(video_path)
            frame_rgb = decoder.seek_frame(float(time_seconds))

            img = Image.fromarray(frame_rgb, mode="RGB")

            # Hitung rasio aspek untuk resize (samain perilaku lama: tinggi
            # dipatok ke `height`, lebar menyesuaikan)
            w, h = img.size
            if h != height and h > 0:
                scale = height / h
                new_w = max(1, int(w * scale))
                img = img.resize((new_w, height), Image.Resampling.LANCZOS)

            # Encode ke JPEG lewat Pillow (gantiin cv2.imencode)
            buffer = BytesIO()
            img.save(buffer, format="JPEG", quality=70)

            # Encode ke Base64 string
            jpg_as_text = base64.b64encode(buffer.getvalue()).decode("utf-8")
            return f"data:image/jpeg;base64,{jpg_as_text}"

        except Exception as e:
            print(f"[VideoUtils] Error: {e}")
            return None
