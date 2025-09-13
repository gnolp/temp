import sys, json, base64
import cv2
import numpy as np
from ultralytics import YOLO

# Load nhiều model YOLO
models = {
    "yolo_person": YOLO("yolov8n.pt"),
    "yolo_custom": YOLO("checkpoint_last.pt")
}

def process_frame(data):
    """Xử lý một frame và trả về kết quả detection"""
    try:
        cam_id = data["camId"]
        frame_b64 = data["frame"]
        timestamp = data.get("timestamp", 0)
        frame_number = data.get("frameNumber", 0)
        
        frame = base64.b64decode(frame_b64)
        arr = np.frombuffer(frame, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)

        if img is None:
            return None

        results_all = {}
        for model_name, model in models.items():
            results = model.predict(img, imgsz=640, verbose=False)
            detections = []
            for r in results:
                for box in r.boxes:
                    detections.append({
                        "cls": model.names[int(box.cls)],
                        "conf": float(box.conf),
                        "xyxy": box.xyxy[0].tolist()
                    })
            results_all[model_name] = detections

        return {
            "camId": cam_id,
            "timestamp": timestamp,
            "frameNumber": frame_number,
            "results": results_all
        }
    except Exception as e:
        return {"error": str(e), "camId": data.get("camId", "unknown"), "frameNumber": data.get("frameNumber", 0)}

def read_stdin():
    """Đọc và xử lý frame từ stdin"""
    for line in sys.stdin:
        try:
            data = json.loads(line)
            result = process_frame(data)
            
            if result:
                print(json.dumps(result), flush=True)
                
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)

read_stdin()
