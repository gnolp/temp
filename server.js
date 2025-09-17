const WebSocket = require("ws");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { VehicleTracker } = require("./Count_vehicle_in_line.js");

const wss = new WebSocket.Server({ port: 8080 });
const videoFile = path.join(__dirname, "sample.mp4"); //mock data
const videoFile1 = path.join(__dirname, "traffic_video.avi");
// Config
const BUFFER_SIZE = 100;        // độ trễ buffer
const DETECTION_INTERVAL = 5;   // cứ 5 frame gửi 1 frame cho AI

// State
const frameBuffer = {};
const frameCounters = {};
const isBufferReady = {};
const sendIntervals = {};
const cameraConnections = {};
const vehicleCountStats = {}; // Lưu trữ thống kê đếm xe
const trackers = {};
const statsIntervals = {}; // Lưu trữ interval ID cho từng camera
const SAVE_INTERVAL = 30000; // 30 giây

// Camera list
const cameras = {
  cam1: videoFile,
  cam2: videoFile1
};
const cameraLines = {
  cam2: [
    {
      id: 'line1',
      x1: 150, y1: 540,    // Line ngang ở giữa
      x2: 650, y2: 540,
      width: 30,
      color: '#00FF00',   // Xanh lá
      name: 'Line 1'
    },
  ]
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
            // console.log(`✅ Gán AI result vào frame ${frameNumber} (${camId})`, frameObj.aiResults);

            // Xử lý tracking nếu có line
            if (trackers[camId] && cameraLines[camId]) {
              const detectionData = {
                camId: camId,
                timestamp: frameObj.timestamp,
                frameNumber: frameObj.frameNumber,
                results: results || {}
              };

              const previousLineCounts = JSON.parse(JSON.stringify(trackers[camId].getLineCounts()));
              const trackingResult = trackers[camId].trackVehicles(detectionData, cameraLines[camId]);
              const newLineCounts = trackingResult.lineCounts;

              // Debug: So sánh line counts trước và sau + cập nhật stats
              Object.keys(newLineCounts).forEach(lineId => {
                const oldCount = previousLineCounts[lineId] || 0;
                const newCount = newLineCounts[lineId] || 0;
                if (newCount > oldCount) {
                  console.log(`🚗 [${camId}] VEHICLE COUNTED! Line ${lineId}: ${oldCount} → ${newCount} (+${newCount - oldCount}) | Frame: ${frameNumber}`);
                  console.log(`   📊 Total tracked vehicles: ${trackingResult.totalTrackedVehicles}`);
                  console.log(`   🎯 Active detections in this frame: ${trackingResult.trackedVehicles.length}`);

                  // Tìm xe nào vừa qua line để cập nhật stats
                  if (trackingResult.newLineCrossings) {
                    trackingResult.newLineCrossings.forEach(crossing => {
                      if (crossing.lineId === lineId) {
                        updateVehicleCount(camId, lineId, crossing.vehicleClass);
                      }
                    });
                  }
                }
              });

              frameObj.aiResults.tracking = trackingResult;
              trackers[camId].saveTrackingData(trackingResult);
            }
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
    console.log("[Server] = update model:", msg.camId, ": ", msg.models)
    aiWorker.stdin.write(JSON.stringify(msg) + "\n");
  }
});

// WebSocket
wss.on("connection", (ws, req) => {
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

  startCameraStatsInterval(camId); // Tự động khởi tạo interval khi thêm camera

  startStream(camId, url);
}
function removeCamera(camId) {
  if (!cameras[camId]) return;
  delete cameras[camId];
  clearInterval(sendIntervals[camId]);
  console.log(`🗑️ Camera ${camId} removed`);
}

function initializeCameraStats(camId) {
  if (!vehicleCountStats[camId]) {
    vehicleCountStats[camId] = {
      camera_id: camId,
      line: []
    };

    // Khởi tạo cho từng line của camera
    if (cameraLines[camId]) {
      cameraLines[camId].forEach(line => {
        vehicleCountStats[camId].line.push({
          line_id: line.id,
          object: {}
        });
      });
    }
  }
}

function updateVehicleCount(camId, lineId, vehicleClass) {
  // Đảm bảo camera stats đã được khởi tạo
  initializeCameraStats(camId);

  // Tìm line trong stats
  let lineStats = vehicleCountStats[camId].line.find(l => l.line_id === lineId);

  if (!lineStats) {
    // Nếu chưa có line này, tạo mới
    lineStats = {
      line_id: lineId,
      object: {}
    };
    vehicleCountStats[camId].line.push(lineStats);
  }

  // Cập nhật count cho vehicle class
  if (!lineStats.object[vehicleClass]) {
    lineStats.object[vehicleClass] = 0;
  }
  lineStats.object[vehicleClass]++;

  console.log(`📊 [STATS UPDATE] ${camId} - Line ${lineId}: ${vehicleClass} count = ${lineStats.object[vehicleClass]}`);

  // Broadcast update đến tất cả clients
  const updateMessage = JSON.stringify({
    type: "vehicle-stats-update",
    camId: camId,
    lineId: lineId,
    vehicleClass: vehicleClass,
    newCount: lineStats.object[vehicleClass],
    fullStats: vehicleCountStats[camId]
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(updateMessage);
    }
  });
}

function getVehicleCountStats(camId = null) {
  if (camId) {
    return vehicleCountStats[camId] || null;
  }
  return vehicleCountStats;
}

function resetVehicleCountStats(camId = null) {
  if (camId) {
    if (vehicleCountStats[camId]) {
      vehicleCountStats[camId].line.forEach(line => {
        line.object = {};
      });
    }
  } else {
    Object.keys(vehicleCountStats).forEach(camId => {
      vehicleCountStats[camId].line.forEach(line => {
        line.object = {};
      });
    });
  }
  console.log(`🔄 [STATS RESET] ${camId ? camId : 'All cameras'} stats reset`);
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
    '-stream_loop', '-1',
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

    // khởi tạo tracker nếu chưa có
    if (!trackers[camId]) {
      trackers[camId] = new VehicleTracker(camId);

      initializeCameraStats(camId); // Khởi tạo stats khi tạo tracker
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
Object.entries(cameras).forEach(([camId, src]) => {
  startStream(camId, src)
  startCameraStatsInterval(camId); // Tự động khởi tạo interval khi thêm camera
});
Object.keys(cameras).forEach(camId => {
  frameBuffer[camId] = [];
  cameraConnections[camId] = new Set();
});


// In thống kê định kỳ (mỗi 30 giây) sau có thể thêm sql chỗ này để thêm vào db
// Function để tính tổng thống kê theo camera
function getCameraStatistics(camId) {
  const stats = vehicleCountStats[camId];
  if (!stats || stats.line.length === 0) {
    return { totalVehicles: 0, byType: {} };
  }

  const totalByType = {};
  let totalVehicles = 0;

  stats.line.forEach(line => {
    Object.keys(line.object).forEach(vehicleType => {
      const count = line.object[vehicleType];
      totalByType[vehicleType] = (totalByType[vehicleType] || 0) + count;
      totalVehicles += count;
    });
  });

  return { totalVehicles, byType: totalByType };
}

// Function để khởi tạo interval riêng cho từng camera
function startCameraStatsInterval(camId, intervalTime = SAVE_INTERVAL, autoClear = true) {
  // Dừng interval cũ nếu có
  if (statsIntervals[camId]) {
    clearInterval(statsIntervals[camId]);
  }

  statsIntervals[camId] = setInterval(() => {
    // console.log(`\n📊 ===== CAMERA ${camId.toUpperCase()} STATISTICS =====`);

    // // Thống kê tổng quan cho camera này
    const cameraStats = getCameraStatistics(camId);
    const stats = vehicleCountStats[camId];
    // console.log(`🎯 CAMERA ${camId} SUMMARY:`);
    // console.log(`🎥 Total: ${cameraStats.totalVehicles} vehicles`);

    // if (Object.keys(cameraStats.byType).length > 0) {
    //   Object.keys(cameraStats.byType).forEach(vehicleType => {
    //     console.log(`   └─ ${vehicleType}: ${cameraStats.byType[vehicleType]}`);
    //   });
    // } else {
    //   console.log("   └─ No vehicles counted yet");
    // }

    // // Chi tiết theo line
    // console.log(`\n📏 DETAILED BY LINES:`);

    // if (!stats || stats.line.length === 0) {
    //   console.log("   No data yet");
    // } else {
    //   stats.line.forEach(line => {
    //     console.log(`   📏 Line ${line.line_id}:`);
    //     if (Object.keys(line.object).length === 0) {
    //       console.log("     No vehicles counted");
    //     } else {
    //       Object.keys(line.object).forEach(vehicleType => {
    //         console.log(`     ${vehicleType}: ${line.object[vehicleType]}`);
    //       });
    //     }
    //   });
    // }

    // 🚀 GỬI DỮ LIỆU QUA MAIN.JS
    if (process.send) {
      process.send({
        type: "periodic-vehicle-stats",
        camId: camId,
        timestamp: Date.now(),
        interval: intervalTime,
        summary: {
          totalVehicles: cameraStats.totalVehicles,
          byType: cameraStats.byType
        },
        details: {
          lines: stats ? stats.line.map(line => ({
            lineId: line.line_id,
            vehicles: { ...line.object }
          })) : []
        },
        systemInfo: {
          frameCount: frameCounters[camId] || 0,
          trackedVehicles: trackers[camId]?.trackedVehicles?.size || 0,
          autoClear: autoClear
        }
      });
    }

    // Auto clear dữ liệu sau khi in (nếu được bật)
    if (autoClear) {
      resetVehicleCountStats(camId);
      console.log(`🧹 Auto-cleared stats for camera ${camId}`);
    }

    console.log(`========= END CAMERA ${camId.toUpperCase()} =========\n`);
  }, intervalTime);

  console.log(`✅ Started stats interval for camera ${camId} (every ${intervalTime / 1000}s, auto-clear: ${autoClear})`);
}

// Function để dừng interval của 1 camera
function stopCameraStatsInterval(camId) {
  if (statsIntervals[camId]) {
    clearInterval(statsIntervals[camId]);
    delete statsIntervals[camId];
    console.log(`❌ Stopped stats interval for camera ${camId}`);
  }
}

// ===== CÁC CÁCH SỬ DỤNG INTERVAL RIÊNG CHO TỪNG CAMERA =====

// 1. Tự động: Khi add camera, interval sẽ tự động được tạo (mặc định 30s, auto-clear: true)

// 2. Thủ công với thời gian khác (auto-clear mặc định = true):
// startCameraStatsInterval('cam1', 10000);  // 10 giây cho cam1, tự động clear
// startCameraStatsInterval('cam2', 60000);  // 60 giây cho cam2, tự động clear

// 3. Tắt auto-clear (giữ lại dữ liệu tích lũy):
// startCameraStatsInterval('cam1', 30000, false);  // 30 giây, không clear

// 4. Bật auto-clear (reset mỗi lần in):
// startCameraStatsInterval('cam1', 30000, true);   // 30 giây, có clear

// 5. Dừng interval của 1 camera:
// stopCameraStatsInterval('cam1');

// 6. Khởi tạo lại với cấu hình mới:
// startCameraStatsInterval('cam1', 5000, true);    // 5 giây, auto-clear
// startCameraStatsInterval('cam1', 15000, false);  // 15 giây, không clear

// ===== LỢI ÍCH CỦA AUTO-CLEAR =====
// ✅ Thống kê theo chu kỳ: Mỗi lần in = 1 khoảng thời gian riêng biệt
// ✅ Tránh tích lũy: Không bị chồng chất số liệu cũ  
// ✅ Tiết kiệm bộ nhớ: Không lưu trữ quá nhiều dữ liệu
// ✅ Dễ phân tích: Xem được xu hướng theo từng khoảng thời gian

// ===== INTERVAL TỔNG CHO TẤT CẢ CAMERA (nếu muốn) =====
// Uncomment dòng dưới nếu muốn có thêm 1 interval tổng cho tất cả camera
/*
setInterval(() => {
  console.log("\n📊 ===== ALL CAMERAS STATISTICS =====");
  
  // Thống kê tổng quan theo camera
  console.log("🎯 ALL CAMERAS SUMMARY:");
  Object.keys(vehicleCountStats).forEach(camId => {
    const cameraStats = getCameraStatistics(camId);
    console.log(`🎥 Camera ${camId}: Total ${cameraStats.totalVehicles} vehicles`);
    
    if (Object.keys(cameraStats.byType).length > 0) {
      Object.keys(cameraStats.byType).forEach(vehicleType => {
        console.log(`   └─ ${vehicleType}: ${cameraStats.byType[vehicleType]}`);
      });
    } else {
      console.log("   └─ No vehicles counted yet");
    }
  });
  console.log("=======================================\n");
}, SAVE_INTERVAL * 2);  // 60 giây cho tổng
*/

console.log("✅ Server running on ws://localhost:8080");

// Auto-set model cho tất cả camera khi khởi động
setTimeout(() => {
  console.log("🤖 Auto-setting models for cameras...");

  // Set model cho cam1
  aiWorker.stdin.write(JSON.stringify({
    type: "update-model",
    camId: "cam1",
    models: ["yolo_person"]
  }) + "\n");

  // Set model cho cam2
  aiWorker.stdin.write(JSON.stringify({
    type: "update-model",
    camId: "cam2",
    models: ["yolo_person", "yolo_custom"]
  }) + "\n");

}, 2000); // Đợi 2 giây để AI worker khởi động xong