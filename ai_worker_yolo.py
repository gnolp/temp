import sys, json, base64
import cv2
import numpy as np
from ultralytics import YOLO

# Load nhiều model YOLO
models = {
    "yolo_person": YOLO("yolov8n.pt"),
    "yolo_custom": YOLO("checkpoint_last.pt")
}
camera_models = {}
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
        model_list = camera_models.get(cam_id, [])
        results_all = {}
        #for model_name, model in models.items(): mock model, sau test sẽ để model_list
        for model_name in model_list:   
            if model_name not in models:
                continue
            model = models[model_name]
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
            # print(results_all)
        return {
            "type": "detect", 
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
            msg = json.loads(line)
            if msg["type"] == "update-model":
                camera_models[msg["camId"]] = msg["models"]
                print(
                    json.dumps({
                        "type": "update-model",
                        "camId": msg["camId"],
                        "models": msg["models"]
                    }),
                    flush=True
                )
            elif msg["type"] == "detect":
                result = process_frame(msg)
                if result:
                    # # result["type"] = "detect"
                    # out = json.dumps(result)
                    # sys.stderr.write(f"[PYTHON-DEBUG] {out}\n")
                    # print(out, flush=True)
                    print(json.dumps(result), flush=True)
                
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)

read_stdin()
