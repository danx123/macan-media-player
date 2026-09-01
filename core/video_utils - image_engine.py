# core/video_utils.py
import base64
import os

import image_engine


class VideoThumbnailer:
    @staticmethod
    def get_thumbnail_at_time(video_path, time_seconds, height=80):
        """
        Mengambil frame video pada detik tertentu dan mengembalikannya sebagai base64.
        """
        if not os.path.exists(video_path):
            return None

        try:
            # Buka video capture (image_engine.VideoCapture == cv2.VideoCapture)
            cap = image_engine.VideoCapture(video_path)

            # Pindah ke millisecond yang diminta
            cap.set(image_engine.CAP_PROP_POS_MSEC, time_seconds * 1000)

            success, frame = cap.read()
            cap.release()

            if not success or frame is None:
                return None

            # Dimensi langsung dari getter Mat — TIDAK convert ke numpy dulu
            h, w = frame.rows, frame.cols
            scale = height / h
            new_w = max(1, int(w * scale))

            # Resize frame agar ringan dikirim ke frontend
            resized_frame = image_engine.resize(
                frame, (new_w, height), interpolation=image_engine.INTER_AREA
            )

            # Encode langsung ke JPEG bytes (native, tanpa numpy/PIL).
            # Frame masih BGR — JANGAN cvt_color ke RGB, imencode expect BGR
            # sama kayak cv2.imencode.
            ok, buf = image_engine.imencode(
                '.jpg', resized_frame, [image_engine.IMWRITE_JPEG_QUALITY, 70]
            )
            if not ok:
                return None

            jpg_as_text = base64.b64encode(buf).decode('utf-8')
            return f"data:image/jpeg;base64,{jpg_as_text}"

        except Exception as e:
            print(f"[VideoUtils] Error: {e}")
            return None
