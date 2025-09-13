const WebSocket = require("ws");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const wss = new WebSocket.Server({ port: 8080 });
const videoFile = path.join(__dirname, "sample.mp4");

// Config
const BUFFER_SIZE = 100;        // độ trễ buffer
const DETECTION_INTERVAL = 5;   // cứ 5 frame gửi 1 frame cho AI

// State
const frameBuffer = {};
const frameCounters = {};
const isBufferReady = {};
const sendIntervals = {};

// Camera list
const cameras = {
  cam1: videoFile
};

// AI worker
const aiWorker = spawn("python", ["ai_worker_yolo.py"]);
aiWorker.on("error", (err) => console.error("❌ AI Worker error:", err));
aiWorker.on("exit", (code) => console.log(`🤖 AI Worker exited with code ${code}`));

aiWorker.stdout.on("data", (data) => {
  try {
    const result = JSON.parse(data.toString());
    const { camId, frameNumber, results } = result;

    // tìm frame trong buffer và gán kết quả
    const frameObj = frameBuffer[camId]?.find(f => f.frameNumber === frameNumber);
    if (frameObj) {
      frameObj.aiResults = results;
      // console.log(`✅ Gán AI result vào frame ${frameNumber} (${camId})`);
    }
  } catch (e) {
    console.error("❌ Parse error:", e.message);
  }
});

aiWorker.stderr.on("data", (data) => {
  console.error("AI Worker error:", data.toString());
});

// WebSocket
wss.on("connection", (ws) => {
  console.log("🔌 Client connected");
  ws.on("close", () => console.log("❌ Client disconnected"));
});

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
  console.log(`🎬 Starting ffmpeg for ${camId}`);

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

      wss.clients.forEach((c) => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify(meta));
          c.send(frameObj.frameData); // gửi frame binary
        }
      });
    }
  }, 100); // 10 fps
}

// Start all cameras
Object.entries(cameras).forEach(([camId, src]) => startStream(camId, src));

console.log("✅ Server running on ws://localhost:8080");
