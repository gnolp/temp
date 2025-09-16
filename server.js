const WebSocket = require("ws");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const wss = new WebSocket.Server({ port: 8080 });
const videoFile = path.join(__dirname, "sample.mp4"); //mock data
const videoFile1 = path.join(__dirname, "sample2.mp4");
// Config
const BUFFER_SIZE = 100;        // độ trễ buffer
const DETECTION_INTERVAL = 5;   // cứ 5 frame gửi 1 frame cho AI

// State
const frameBuffer = {};
const frameCounters = {};
const isBufferReady = {};
const sendIntervals = {};
const cameraConnections = {};
// Camera list
const cameras = {
  cam1: videoFile,
  cam2: videoFile1
};

// AI worker
const aiWorker = spawn("python", ["ai_worker_yolo.py"]);
aiWorker.on("error", (err) => console.error("AI Worker error:", err));
aiWorker.on("exit", (code) => console.log(`AI Worker exited with code ${code}`));



aiWorker.stdout.on("data", (data) => {
  const lines = data.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const result = JSON.parse(line);

      switch (result.type) {
        case "update-model":
          console.log(`✅ Model updated for ${result.camId}:`, result.models);
          break;

        case "detect": {
          const { camId, frameNumber, results } = result;
          const frameObj = frameBuffer[camId]?.find(f => f.frameNumber === frameNumber);
          if (frameObj) {
            frameObj.aiResults = results ?? {}; // luôn gán {} nếu null
            console.log(`✅ Gán AI result vào frame ${frameNumber} (${camId})`, frameObj.aiResults);
          }
          break;
        }

        case "error":
          console.error("❌ Python error:", result.error);
          break;

        default:
          console.log("ℹ️ Unknown message:", result);
      }
    } catch (e) {
      console.error("❌ Parse error:", e.message, "Raw:", line);
    }
  }
});


aiWorker.stderr.on("data", (data) => {
  console.error("AI Worker error:", data.toString());
});
process.on("message", (msg) => {
  if (msg.type === "init") {
    msg.cameras.forEach(cam => addCamera(cam.id, cam.url));
  }
  if (msg.type === "add-camera") {
    addCamera(msg.cam.id, msg.cam.url);
  }
  if (msg.type === "remove-camera") {
    removeCamera(msg.camId);
  }
  if (msg.type === "update-model") {
    console.log("[Server] = update model:",msg.camId,": ", msg.models)
    aiWorker.stdin.write(JSON.stringify(msg) + "\n");
  }
});

// WebSocket
wss.on("connection", (ws,req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const camId = url.searchParams.get("camId");

  if (!cameras[camId]) {
    ws.close();
    return;
  }

  cameraConnections[camId].add(ws);
  console.log(`✅ Client connected to ${camId}`);
  console.log("🔌 Client connected");
  ws.on("close", () => console.log("❌ Client disconnected"));
});
function addCamera(camId, url) {
  if (cameras[camId]) return;
  cameras[camId] = url;
  startStream(camId, url);
}
function removeCamera(camId) {
  if (!cameras[camId]) return;
  delete cameras[camId];
  clearInterval(sendIntervals[camId]);
  console.log(`🗑️ Camera ${camId} removed`);
}

// Bắt đầu stream
function startStream(camId, videoSource) {
  if (!fs.existsSync(videoSource)) {
    console.error(`❌ ${camId}: File not found: ${videoSource}`);
    return;
  }

  frameBuffer[camId] = [];
  frameCounters[camId] = 0;
  isBufferReady[camId] = false;

  const args = [
    "-loglevel", "error",
    "-re",              // realtime
    '-stream_loop','-1',
    "-i", videoSource,
    "-an",
    "-vf", "fps=10",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-"
  ];

  const ffmpeg = spawn(ffmpegPath, args);
  console.log(`Starting ffmpeg for ${camId}`);

  ffmpeg.stdout.on("data", (frame) => {
    frameCounters[camId]++;
    const frameObj = {
      frameNumber: frameCounters[camId],
      timestamp: Date.now(),
      camId,
      frameData: frame,
      aiResults: null
    };

    frameBuffer[camId].push(frameObj);

    // giới hạn buffer không quá lớn
    if (frameBuffer[camId].length > BUFFER_SIZE * 2) {
      frameBuffer[camId].shift();
    }

    // gửi đi detect mỗi DETECTION_INTERVAL frame
    if (frameCounters[camId] % DETECTION_INTERVAL === 0) {
      aiWorker.stdin.write(JSON.stringify({
        type: "detect",
        camId,
        frame: frame.toString("base64"),
        timestamp: frameObj.timestamp,
        frameNumber: frameObj.frameNumber
      }) + "\n");
    }

    // khi đủ 100 frame thì bắt đầu gửi ra FE
    if (!isBufferReady[camId] && frameBuffer[camId].length >= BUFFER_SIZE) {
      isBufferReady[camId] = true;
      console.log(`🚀 ${camId}: Buffer ready, bắt đầu gửi ra FE`);
      startSendingToFrontend(camId);
    }
  });

  ffmpeg.stderr.on("data", (d) => {
    const msg = d.toString();
    if (!msg.includes("frame=")) {
      console.log(`📝 ffmpeg[${camId}]:`, msg);
    }
    else if (msg.includes("error") || msg.includes("not found")) {
      process.send?.({ type: "camera-error", camId: cam.id, message: msg });
    }
  });

  ffmpeg.on("close", (c) => {
    console.log(`🔚 ffmpeg closed (${camId}) with code ${c}`);
  });
}

// Gửi frame ra FE
function startSendingToFrontend(camId) {
  sendIntervals[camId] = setInterval(() => {
    if (frameBuffer[camId].length > BUFFER_SIZE) {
      const frameObj = frameBuffer[camId].shift();

      // gửi metadata JSON trước
      const meta = {
        type: "frame",
        camId: frameObj.camId,
        frameNumber: frameObj.frameNumber,
        timestamp: frameObj.timestamp,
        aiResults: frameObj.aiResults
      };

      cameraConnections[camId].forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(meta));
          ws.send(frameObj.frameData); // gửi binary
        }
      });
    }
  }, 100); // 10 fps
}
// ws/localhost:8080
// Start all cameras
Object.entries(cameras).forEach(([camId, src]) => startStream(camId, src));
Object.keys(cameras).forEach(camId => {
  frameBuffer[camId] = [];
  cameraConnections[camId] = new Set();
});




console.log("✅ Server running on ws://localhost:8080");
