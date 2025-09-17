const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { spawn, fork } = require("child_process");

let serverProcess = null;

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
      console.log(`📊 [MAIN] Received stats from ${data.camId}:`);
      console.log(`   🎥 Total vehicles: ${data.summary.totalVehicles}`);
      console.log(`   📈 By type:`, data.summary.byType);
      console.log(`   🕒 Timestamp: ${new Date(data.timestamp).toLocaleTimeString()}`);
      console.log(`   📊 System: ${data.systemInfo.frameCount} frames, ${data.systemInfo.trackedVehicles} tracked`);
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
    serverProcess.send({ type: "update-model", camId, models });
  });
  ipcMain.handle("add-camera", async (_, cam) => {
    try {
      // code sql ở đây được
      serverProcess.send({ type: "add-camera", cam });
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

});

app.on("window-all-closed", () => {
  if (serverProcess) {
    serverProcess.kill(); // tắt server khi đóng app
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
