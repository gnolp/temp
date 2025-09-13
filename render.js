const container = document.getElementById("container");

// Lưu camera canvas & context
const cameras = {};

// Debug info
let frameCount = 0;
let lastFrameTime = Date.now();

// Tạo UI cho 1 camera
function createCameraUI(camId) {
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

// Vẽ bounding boxes
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

// Kết nối WebSocket
function connectWebSocket() {
  const ws = new WebSocket("ws://localhost:8080");
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("✅ Connected to WebSocket server");
    frameCount = 0;
    lastFrameTime = Date.now();
  };

  ws.onmessage = (event) => {
    // Nếu là JSON
    if (typeof event.data === "string") {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "frame") {
          const { camId, aiResults, frameNumber } = data;

          if (!cameras[camId]) createCameraUI(camId);

          frameCount++;
          const now = Date.now();
          if (now - lastFrameTime > 1000) {
            console.log(`📹 FPS: ${frameCount} (${camId})`);
            frameCount = 0;
            lastFrameTime = now;
          }

          cameras[camId].detections = [];
          if (aiResults && typeof aiResults === "object") {
            Object.keys(aiResults).forEach(modelName => {
              if (Array.isArray(aiResults[modelName])) {
                cameras[camId].detections.push(...aiResults[modelName]);
              }
            });
          }
          cameras[camId].latestMeta = data;
        }
      } catch (e) {
        console.error("❌ JSON parse error:", e, event.data);
      }
    } 
    // Nếu là binary JPEG
    else if (event.data instanceof ArrayBuffer) {
      const blob = new Blob([event.data], { type: "image/jpeg" });
      const url = URL.createObjectURL(blob);

      // Gắn ảnh vào đối tượng camera
      Object.values(cameras).forEach(cam => {
        cam.img.onload = () => {
          drawDetections(cam.latestMeta?.camId || "unknown");
          URL.revokeObjectURL(url);
        };
        cam.img.src = url;
      });
    }
  };

  ws.onerror = (err) => console.error("❌ WS error:", err);
  ws.onclose = () => {
    console.log("🔌 Disconnected. Reconnect in 3s...");
    setTimeout(connectWebSocket, 3000);
  };

  return ws;
}

connectWebSocket();
