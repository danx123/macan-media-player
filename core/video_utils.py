# core/video_utils.py
import cv2
import base64
import os

class VideoThumbnailer:
    @staticmethod
    def get_thumbnail_at_time(video_path, time_seconds, height=80):
        """
        Mengambil frame video pada detik tertentu dan mengembalikannya sebagai base64.
        """
        if not os.path.exists(video_path):
            return None

        try:
            # Buka video capture
            cap = cv2.VideoCapture(video_path)
            
            # Pindah ke millisecond yang diminta
            cap.set(cv2.CAP_PROP_POS_MSEC, time_seconds * 1000)
            
            success, frame = cap.read()
            cap.release()

            if not success:
                return None

            # Hitung rasio aspek untuk resize
            h, w, _ = frame.shape
            scale = height / h
            new_w = int(w * scale)
            
            # Resize frame agar ringan dikirim ke frontend
            resized_frame = cv2.resize(frame, (new_w, height), interpolation=cv2.INTER_AREA)
            
            # Encode ke JPEG
            _, buffer = cv2.imencode('.jpg', resized_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            
            # Encode ke Base64 string
            jpg_as_text = base64.b64encode(buffer).decode('utf-8')
            return f"data:image/jpeg;base64,{jpg_as_text}"
            
        except Exception as e:
            print(f"[VideoUtils] Error: {e}")
            return None
