const { app, BrowserWindow } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let serverProcess = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "renderer.js"),
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile("index.html");
}

function startServer() {
  serverProcess = spawn("node", ["server.js"], {
    cwd: __dirname,
    shell: true,
    stdio: "inherit" // hiện log server trong terminal
  });

  serverProcess.on("exit", (code) => {
    console.log(`Server process exited with code ${code}`);
  });
}

app.whenReady().then(() => {
  startServer(); // chạy server song song
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
