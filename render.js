const container = document.getElementById("container");

// Lưu camera canvas & context
const cameras = {};

// Nút test update model
document.getElementById("btnSetModel").addEventListener("click", () => {
  const camId = "cam1";
  const models = ["yolo_person"];
  window.api.updateModel(camId, models);
});

// Debug info
let frameCount = 0;
let lastFrameTime = Date.now();

// ===========================
// Tạo UI cho 1 camera
// ===========================
function createCameraUI(camId) {
  if (cameras[camId]) return; // tránh tạo 2 lần

  console.log(`🎥 Creating UI for camera: ${camId}`);

  const div = document.createElement("div");
  div.className = "camera";
  div.id = `cam-${camId}`;

  const label = document.createElement("div");
  label.className = "label";
  label.innerText = camId;

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  canvas.id = `canvas-${camId}`;

  div.appendChild(canvas);
  div.appendChild(label);
  container.appendChild(div);

  cameras[camId] = {
    canvas,
    ctx: canvas.getContext("2d"),
    detections: [],
    latestMeta: null,
    img: new Image()
  };

  console.log(`✅ Camera UI created for ${camId}`);
}

// ===========================
// Vẽ bounding boxes
// ===========================
function drawDetections(camId) {
  const cam = cameras[camId];
  if (!cam) return;

  const ctx = cam.ctx;
  ctx.clearRect(0, 0, cam.canvas.width, cam.canvas.height);

  // Vẽ frame lên canvas
  ctx.drawImage(cam.img, 0, 0, cam.canvas.width, cam.canvas.height);

  // Vẽ AI detections
  cam.detections.forEach(det => {
    const [x1, y1, x2, y2] = det.xyxy;
    ctx.strokeStyle = "lime";
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x1, y1 - 20, 120, 20);

    ctx.fillStyle = "yellow";
    ctx.font = "14px Arial";
    ctx.fillText(`${det.cls} ${(det.conf * 100).toFixed(1)}%`, x1 + 2, y1 - 5);
  });
}

// ===========================
// Kết nối WS riêng cho từng camera
// ===========================
function connectCameraWS(camId) {
  if (!cameras[camId]) createCameraUI(camId);

  const cam = cameras[camId];
  const ws = new WebSocket(`ws://localhost:8080?camId=${camId}`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log(`✅ Connected to camera WS: ${camId}`);
    frameCount = 0;
    lastFrameTime = Date.now();
  };

  ws.onmessage = (event) => {
    // Nếu JSON metadata (AI result)
    if (typeof event.data === "string") {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "frame") {
          console.log(data);
          // Cập nhật detections
          cam.detections = [];
          if (data.aiResults && typeof data.aiResults === "object") {
            Object.keys(data.aiResults).forEach(modelName => {
              if (Array.isArray(data.aiResults[modelName])) {
                cam.detections.push(...data.aiResults[modelName]);
              }
            });
          }
          cam.latestMeta = data;

          // Debug FPS
          frameCount++;
          const now = Date.now();
          if (now - lastFrameTime > 1000) {
            console.log(`📹 FPS: ${frameCount} (${camId})`);
            frameCount = 0;
            lastFrameTime = now;
          }
        }
      } catch (e) {
        console.error("❌ JSON parse error:", e, event.data);
      }
    }
    // Nếu binary JPEG
    else if (event.data instanceof ArrayBuffer) {
      const blob = new Blob([event.data], { type: "image/jpeg" });
      const url = URL.createObjectURL(blob);

      cam.img.onload = () => {
        drawDetections(camId);
        URL.revokeObjectURL(url);
      };
      cam.img.src = url;
    }
  };

  ws.onerror = (err) => console.error(`❌ WS error (${camId}):`, err);
  ws.onclose = () => {
    console.log(`🔌 Camera WS disconnected (${camId}). Reconnect in 3s...`);
    setTimeout(() => connectCameraWS(camId), 3000);
  };
}

// ===========================
// Kết nối tất cả camera
// ===========================
function startAllCameraWS(cameraList) {
  Object.keys(cameraList).forEach(camId => connectCameraWS(camId));
}

// ===========================
// Biết trước danh sách camera
// ===========================
const cameraList = { cam1: true, cam2: true };
startAllCameraWS(cameraList);
