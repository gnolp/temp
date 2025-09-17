const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { spawn, fork } = require("child_process");
const mysql = require('mysql2/promise');
const ffmpegPath = require("ffmpeg-static");

let serverProcess = null;

const pool = mysql.createPool({
  host: "localhost",
  user: "root",           // <- chỉnh theo môi trường
  password: "123456",      // <- chỉnh theo môi trường
  database: "db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

pool.getConnection()
  .then((conn) => {
    console.log("✅ MySQL connected");
    conn.release();
  })
  .catch((err) => {
    console.error("❌ MySQL connection error:", err);
  });
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadFile("index.html");
}

// function setModel(model1,){}

function startServer() {
  const serverPath = path.join(__dirname, "server.js");
  serverProcess = fork(serverPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"]  // thêm ipc + stdout/stderr
  });
  serverProcess.on("message", (msg) => {
    if (msg.type === 'periodic-vehicle-stats') {
      console.log(`📊 [MAIN] Received stats from ${msg.camId}:`);
      console.log(`   🎥 Total vehicles: ${msg.summary.totalVehicles}`);
      console.log(`   📈 By type:`, msg.summary.byType);
      console.log(`   🕒 Timestamp: ${new Date(msg.timestamp).toLocaleTimeString()}`);
      console.log(`   📊 System: ${msg.systemInfo.frameCount} frames, ${msg.systemInfo.trackedVehicles} tracked`);
    }
    else {
      console.log("From server:", msg);
    }
  });

  serverProcess.on("exit", (code) => {
    console.log(`Server process exited with code ${code}`);
  });
}
async function loadCamerasFromDB() {
  return [
    { id: "cam1", url: path.join(__dirname, "sample.mp4") },
    { id: "cam2", url: "rtsp://192.168.1.100/stream" }
  ];
}
app.whenReady().then(async () => {
  const cameras = await loadCamerasFromDB();

  startServer(); // chạy server song song
  serverProcess.send({ type: "init", cameras });
  serverProcess.stdout.on("data", (d) => console.log("[SERVER]", d.toString()));
  serverProcess.stderr.on("data", (d) => console.error("[SERVER-ERR]", d.toString()));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  ipcMain.on("update-model", (_, { camId, models }) => {
    console.log("update model:", camId, ": ", models);
    console.log("update model:", camId, ": ", models);
    serverProcess.send({ type: "update-model", camId, models });
  });
  ipcMain.handle("get-firstFrame", async (_event, { camId, url }) => {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        "-i", url,        
        "-frames:v", "1",
        "-f", "image2pipe",
        "-vcodec", "mjpeg", 
        "pipe:1"       
      ]);

      let chunks = [];

      ffmpeg.stdout.on("data", (chunk) => {
        chunks.push(chunk);
      });

      ffmpeg.stderr.on("data", (data) => {
        // console.log("ffmpeg:", data.toString());
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          const buffer = Buffer.concat(chunks);
          const base64 = `data:image/jpeg;base64,${buffer.toString("base64")}`;
          resolve({ camId, frame: base64 });
        } else {
          reject(new Error("ffmpeg exited with code " + code));
        }
      });

      ffmpeg.on("error", (err) => {
        reject(err);
      });
    });
  });
  // FE nhận kiểu:
// async function previewCamera() {
//   const camId = "cam1";
//   const url = document.getElementById("inputUrl").value;

//   try {
//     const result = await window.api.getFirstFrame(camId, url);
//     document.getElementById("preview").src = result.frame; // result.frame là base64
//   } catch (err) {
//     console.error("Không lấy được frame:", err);
//   }
// }



  
  ipcMain.handle("add-camera", async (_, cam) => {
    try {
      // code sql ở đây được
      serverProcess.send({ type: "add-camera", cam });
      serverProcess.on("message", (msg) => {
        if (msg.type === "first-frame") {
          // Emit về FE (renderer)
          mainWindow.webContents.send("first-frame", msg.data);
        }
      });
      return { status: "ok", cam };
    } catch (err) {
      return { status: "error", message: err.message };
    }
  });
  // Xử lý remove-camera bằng handler
  ipcMain.handle("remove-camera", async (_, camId) => {
    try {
      // code sql ở đây được
      serverProcess.send({ type: "remove-camera", camId });
      return { status: "ok", camId };
    } catch (err) {
      return { status: "error", message: err.message };
    }
  });


  // -----------------------------
  // Helpers
  // -----------------------------
  async function checkCameraExist(id) {
    const [rows] = await pool.execute("SELECT 1 FROM camera WHERE id = ? AND is_active = 1", [id]);
    return rows.length > 0;
  }

  // Whitelist cột cho updateCamera để tránh SQL injection qua tên cột
  const CAMERA_UPDATABLE_FIELDS = new Set([
    "code_camera", "name", "location", "city", "district", "intersection",
    "video_url", "status", "is_active", "line_count"
  ]);

  function buildUpdateSQL(table, dataObj, whereClause, whereParams) {
    const keys = Object.keys(dataObj).filter((k) => CAMERA_UPDATABLE_FIELDS.has(k));
    if (keys.length === 0) return { sql: null, params: [] };
    const setExpr = keys.map((k) => `\`${k}\` = ?`).join(", ");
    const params = keys.map((k) => dataObj[k]).concat(whereParams);
    const sql = `UPDATE \`${table}\` SET ${setExpr} ${whereClause}`;
    return { sql, params };
  }

  // Lưu ảnh base64 ra file
  function saveBase64Image(base64String, dir, prefix = "img") {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const filePath = path.join(dir, `${prefix}-${ts}.png`);
    const b64 = base64String.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(b64, "base64");
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  // -----------------------------
  // DB Logic funcs (callable từ IPC handlers)
  // -----------------------------
  async function addUser({ name, email }) {
    const [res] = await pool.execute(
      "INSERT INTO users (name, email) VALUES (?, ?)",
      [name, email]
    );
    return res.insertId;
  }

  async function addCamera(cameraData) {
    const ts = Date.now();
    const cityPrefix = (cameraData.city || "XX").toUpperCase().substring(0, 2);
    const code = `CAM-${cityPrefix}${String(ts).slice(-4)}`;

    const sql = `
    INSERT INTO camera
      (code_camera, name, location, city, district, intersection, video_url, status, is_active, line_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `;
    const params = [
      code,
      cameraData.name || "Unnamed",
      cameraData.location || null,
      cameraData.city || null,
      cameraData.district || null,
      cameraData.intersection || null,
      cameraData.videoUrl || null,
      cameraData.status ?? 1,
      cameraData.line_count ?? 0,
    ];
    const [res] = await pool.execute(sql, params);
    return { id: res.insertId, code_camera: code };
  }

  async function listCameras() {
    const [rows] = await pool.execute(
      "SELECT * FROM camera WHERE is_active = 1 ORDER BY id DESC"
    );
    return rows;
  }

  async function softDeleteCamera(cameraId) {
    await pool.execute("UPDATE camera SET is_active = 0 WHERE id = ?", [cameraId]);
  }

  async function updateCameraInfo(cameraId, updateData = {}) {
    if (!(await checkCameraExist(cameraId))) {
      return { updated: false, reason: "not_found" };
    }
    const { sql, params } = buildUpdateSQL("camera", updateData, "WHERE id = ?", [cameraId]);
    if (!sql) return { updated: false, reason: "nothing_to_update" };
    await pool.execute(sql, params);
    return { updated: true };
  }

  async function upsertLine(payload) {
    const { id, camera_id, name, pointLtX, pointLtY, pointRbX, pointRbY } = payload;
    if (!camera_id) throw new Error("camera_id required");
    if (!(await checkCameraExist(camera_id))) throw new Error("camera not found");

    if (id) {
      const sql = `UPDATE tbLine SET name=?, pointLtX=?, pointLtY=?, pointRbX=?, pointRbY=? WHERE id=? AND camera_id=?`;
      await pool.execute(sql, [name, pointLtX, pointLtY, pointRbX, pointRbY, id, camera_id]);
      return id;
    } else {
      const sql = `INSERT INTO tbLine (camera_id, name, pointLtX, pointLtY, pointRbX, pointRbY) VALUES (?,?,?,?,?,?)`;
      const [res] = await pool.execute(sql, [camera_id, name, pointLtX, pointLtY, pointRbX, pointRbY]);
      await pool.execute(`UPDATE camera SET line_count = line_count + 1 WHERE id = ?`, [camera_id]);
      return res.insertId;
    }
  }

  async function listLines(cameraId) {
    const [rows] = await pool.execute(
      `SELECT * FROM tbLine WHERE camera_id = ? ORDER BY id`,
      [cameraId]
    );
    return rows;
  }

  async function historyBulkInsert(list) {
    if (!Array.isArray(list) || list.length === 0) return 0;

    const sql = `INSERT INTO tbHistory (line_id, ts, car, truck, motorcycle, bus, bicycle, other)
            VALUES (?, COALESCE(?, UTC_TIMESTAMP()), ?, ?, ?, ?, ?, ?)`;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const item of list) {
        const params = [
          item.line_id,
          item.ts || null,
          item.car ?? 0,
          item.truck ?? 0,
          item.motorcycle ?? 0,
          item.bus ?? 0,
          item.bicycle ?? 0,
          item.other ?? 0,
        ];
        await conn.execute(sql, params);
      }
      await conn.commit();
      return list.length;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async function saveDetection({ timestamp, object_count, object_classes, confidences, frame_shape, frame_path }) {
    const sql = `INSERT INTO detections (timestamp, object_count, object_classes, confidences, frame_shape, frame_path) VALUES (?, ?, ?, ?, ?, ?)`;
    const params = [
      timestamp,
      object_count,
      JSON.stringify(object_classes),
      JSON.stringify(confidences),
      frame_shape,
      frame_path,
    ];
    const [result] = await pool.execute(sql, params);
    return result.insertId;
  }

  async function getLatestDetections(limit = 10) {
    const [rows] = await pool.query(`SELECT * FROM detections ORDER BY id DESC LIMIT ?`, [Number(limit)]);
    return rows;
  }

  // -----------------------------
  // Traffic history query (compat: object or positional), UTC-consistent
  // -----------------------------
  ipcMain.handle("getTrafficHistory", async (event, arg1, arg2) => {
    try {
      // Hỗ trợ cả hai cách gọi:
      // - Mới (khuyến nghị): invoke("getTrafficHistory", { cameraId, timeRange })
      // - Cũ (legacy):       invoke("getTrafficHistory", cameraId, timeRange)
      let cameraId, timeRange = "24h";

      if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1)) {
        cameraId = arg1.cameraId;
        timeRange = arg1.timeRange ?? arg2 ?? "24h";
      } else {
        cameraId = arg1;
        timeRange = arg2 ?? "24h";
      }

      cameraId = Number(cameraId);
      if (!cameraId || Number.isNaN(cameraId)) throw new Error("cameraId required");

      if (!(await checkCameraExist(cameraId))) {
        return { success: false, message: "camera not found or inactive" };
      }

      // Parse timeRange -> hours
      let hours;
      if (typeof timeRange === "number") {
        hours = timeRange;
      } else {
        const norm = String(timeRange).toLowerCase().trim();
        if (norm === "1h") hours = 1;
        else if (norm === "24h") hours = 24;
        else if (norm === "7d") hours = 24 * 7;
        else if (norm === "30d") hours = 24 * 30;
        else {
          const m = norm.match(/^(\d+)\s*(h|d)$/);
          if (m) {
            const v = Number(m[1]);
            hours = m[2] === "d" ? v * 24 : v;
          } else {
            hours = 24;
          }
        }
      }
      hours = Math.max(1, Math.min(Number(hours) || 24, 24 * 90)); // tối đa 90 ngày

      const sql = `
      SELECT
        l.id AS line_id,
        l.name AS line_name,
        h.ts AS timestamp,
        h.car, h.truck, h.motorcycle, h.bus, h.bicycle, h.other
      FROM tbLine l
      JOIN tbHistory h ON h.line_id = l.id
      WHERE l.camera_id = ? AND h.ts >= UTC_TIMESTAMP() - INTERVAL ? HOUR
      ORDER BY h.ts DESC, l.id ASC
    `;
      const [rows] = await pool.execute(sql, [cameraId, hours]);

      // Gom nhóm theo timestamp (ISO) và tính totals
      const byTs = new Map();
      for (const r of rows) {
        const tsISO = new Date(r.timestamp).toISOString();
        if (!byTs.has(tsISO)) {
          byTs.set(tsISO, {
            timestamp: r.timestamp,
            lines: [],
            totals: { car: 0, truck: 0, motorcycle: 0, bus: 0, bicycle: 0, other: 0 },
          });
        }
        const item = {
          line_id: r.line_id,
          line_name: r.line_name,
          car: r.car || 0,
          truck: r.truck || 0,
          motorcycle: r.motorcycle || 0,
          bus: r.bus || 0,
          bicycle: r.bicycle || 0,
          other: r.other || 0,
        };
        const bucket = byTs.get(tsISO);
        bucket.lines.push(item);
        bucket.totals.car += item.car;
        bucket.totals.truck += item.truck;
        bucket.totals.motorcycle += item.motorcycle;
        bucket.totals.bus += item.bus;
        bucket.totals.bicycle += item.bicycle;
        bucket.totals.other += item.other;
      }

      const histories = Array.from(byTs.entries())
        .map(([tsISO, h]) => ({
          timestamp_iso: tsISO,
          timestamp: h.timestamp,
          lines: h.lines,
          total_vehicle:
            h.totals.car + h.totals.truck + h.totals.motorcycle + h.totals.bus + h.totals.bicycle + h.totals.other,
          totals_by_type: h.totals,
        }))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return { success: true, hours, histories };
    } catch (error) {
      console.error("getTrafficHistory error:", error);
      return { success: false, message: String(error.message || error) };
    }
  });

  // -----------------------------
  // Aggregation (in-memory) + flush timer
  // -----------------------------
  const aggMap = new Map(); // cameraId -> Map(lineId -> counts)

  function addCount(cameraId, lineId, vehType, inc = 1) {
    if (!aggMap.has(cameraId)) aggMap.set(cameraId, new Map());
    const lineMap = aggMap.get(cameraId);
    if (!lineMap.has(lineId)) {
      lineMap.set(lineId, { car: 0, truck: 0, motorcycle: 0, bus: 0, bicycle: 0, other: 0 });
    }
    const rec = lineMap.get(lineId);
    rec[vehType] = (rec[vehType] || 0) + inc;
  }

  const FLUSH_MINUTES = 5;
  setInterval(async () => {
    try {
      const nowList = [];
      for (const [/*cameraId*/, lineMap] of aggMap.entries()) {
        for (const [lineId, counts] of lineMap.entries()) {
          nowList.push({ line_id: lineId, ...counts });
        }
      }
      // reset buckets
      aggMap.clear();

      if (nowList.length) {
        await pool.execute("SET time_zone = '+00:00'");
        await historyBulkInsert(nowList);
        console.log(`✅ Flushed ${nowList.length} agg records`);
      }
    } catch (e) {
      console.error("Periodic flush failed:", e);
    }
  }, FLUSH_MINUTES * 60 * 1000);

  // -----------------------------
  // AI worker process (optional)
  // -----------------------------
  let aiProc = null;
  ipcMain.handle("select-model", async (event, { model, type = "default" } = {}) => {
    try {
      if (aiProc && !aiProc.killed) {
        aiProc.kill();
        aiProc = null;
      }
      aiProc = spawn(process.platform === "win32" ? "python" : "python3", [
        path.join(__dirname, "AI-Worker-python.py"),
        "--model", model,
        "--type", type,
      ], { stdio: "inherit" });

      return { success: true, message: `Model ${model} selected` };
    } catch (error) {
      console.error("select-model error:", error);
      return { success: false, message: String(error.message || error) };
    }
  });

  // -----------------------------
  // IPC Handlers
  // -----------------------------
  ipcMain.handle("user-add", async (event, payload) => {
    try {
      const id = await addUser(payload);
      return { success: true, id };
    } catch (error) {
      console.error("user-add error:", error);
      return { success: false, message: String(error.message || error) };
    }
  });

  // Camera CRUD
  ipcMain.handle("add-new-camera", async (event, cameraData) => {
    try {
      const { id, code_camera } = await addCamera(cameraData);
      return { success: true, id, code_camera };
    } catch (error) {
      console.error("add-new-camera error:", error);
      return { success: false, message: String(error.message || error) };
    }
  });

  ipcMain.handle("getCameraList", async () => {
    try {
      const data = await listCameras();
      return { success: true, data };
    } catch (error) {
      console.error("getCameraList error:", error);
      return { success: false, message: "Cannot fetch cameras" };
    }
  });

  ipcMain.handle("deleteCamera", async (event, cameraId) => {
    try {
      await softDeleteCamera(cameraId);
      return { success: true, message: `deleted camera with id: ${cameraId}` };
    } catch (error) {
      console.error("deleteCamera error:", error);
      return { success: false, message: "delete fail" };
    }
  });

  ipcMain.handle("updateCamera", async (event, cameraId, updateData = {}) => {
    try {
      const res = await updateCameraInfo(cameraId, updateData);
      if (!res.updated) {
        if (res.reason === "not_found") {
          return { success: false, message: "camera is not exist" };
        }
        if (res.reason === "nothing_to_update") {
          return { success: true, message: "nothing to update" };
        }
      }
      return { success: true, message: "update successful!" };
    } catch (error) {
      console.error("updateCamera error:", error);
      return { success: false, message: "had some error, please try again!" };
    }
  });

  // Lines
  ipcMain.handle("line-upsert", async (event, payload) => {
    try {
      const id = await upsertLine(payload);
      return { success: true, id };
    } catch (error) {
      console.error("line-upsert error:", error);
      return { success: false, message: String(error.message || error) };
    }
  });

  ipcMain.handle("line-list", async (event, cameraId) => {
    try {
      const data = await listLines(cameraId);
      return { success: true, data };
    } catch (error) {
      console.error("line-list error:", error);
      return { success: false, message: String(error.message || error) };
    }
  });

  // History bulk insert
  ipcMain.handle("history-bulk-insert", async (event, payload) => {
    try {
      const list = payload?.list || [];
      const inserted = await historyBulkInsert(list);
      return { success: true, inserted };
    } catch (error) {
      console.error("history-bulk-insert error:", error);
      return { success: false, message: String(error.message || error) };
    }
  });

  // Detections
  ipcMain.handle("save-detection", async (event, detectionData) => {
    try {
      const insertId = await saveDetection(detectionData);
      return { success: true, insertId };
    } catch (err) {
      console.error("save-detection error:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("get-latest-detections", async (event, { cameraId, limit = 10 } = {}) => {
    try {
      // Nếu muốn lấy từ Redis, mở comment và thiết kế key phù hợp
      // const key = `detections:${cameraId || 'all'}`;
      // const items = await redis.lrange(key, -limit, -1);
      // const detections = items.map((item) => { try { return JSON.parse(item); } catch { return item; } });
      // return { success: true, data: detections };

      const rows = await getLatestDetections(limit);
      return { success: true, data: rows };
    } catch (err) {
      console.error("get-latest-detections error:", err);
      return { success: false, message: String(err.message || err), data: [] };
    }
  });

  // Aggregation add
  ipcMain.handle("agg-add", async (event, { camera_id, line_id, vehicle_type, inc = 1 }) => {
    addCount(camera_id, line_id, vehicle_type, inc);
    return { success: true };
  });

  // Violations — dùng bảng 'violation_overview' với cột 'image_path'
  ipcMain.handle("violation-add", async (event, payload) => {
    // payload: { camera_id, message, frame_base64 }
    try {
      const { camera_id, message, frame_base64 } = payload || {};
      if (!camera_id) throw new Error("camera_id required");

      const imgPath = frame_base64
        ? saveBase64Image(frame_base64, path.join(__dirname, "data", "violations"), "violation")
        : null;

      // Đổi tên bảng/cột cho đúng schema của anh:
      // Table: violation_overview (camera_id, message, image_path, time)
      const sql = `INSERT INTO violation_overview (camera_id, message, image_path, time)
        VALUES (?, ?, ?, UTC_TIMESTAMP())`;
      await pool.execute(sql, [camera_id, message || null, imgPath]);

      return { success: true, image_path: imgPath };
    } catch (error) {
      console.error("violation-add error:", error);
      return { success: false, message: String(error.message || error) };
    }
  });

  // Liên thông từ model-violation-detected -> violation-add
  ipcMain.handle("model-violation-detected", async (event, payload) => {
    return await ipcMain.invoke("violation-add", payload);
  });
});

app.on("window-all-closed", () => {
  if (serverProcess) {
    serverProcess.kill(); // tắt server khi đóng app
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

