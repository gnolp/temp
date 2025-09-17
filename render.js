// ----------- TEST IPC FUNCTIONS -----------
async function testAllIPC() {
  const resultDiv = document.createElement('div');
  resultDiv.style.background = '#eef';
  resultDiv.style.padding = '10px';
  resultDiv.style.marginTop = '20px';
  resultDiv.innerHTML = '<b>Kết quả test IPC:</b><br>';
  document.body.appendChild(resultDiv);

  // Helper to show result
  function showResult(name, res) {
    resultDiv.innerHTML += `<b>${name}:</b> <pre>${JSON.stringify(res, null, 2)}</pre>`;
  }

  try {
    // Test getCameraList
    if (window.electronAPI.getCameraList) {
      const camList = await window.electronAPI.getCameraList();
      showResult('getCameraList', camList);
    } else {
      showResult('getCameraList', 'Không có hàm getCameraList');
    }

    // Test add-new-camera
    if (window.electronAPI.addNewCamera) {
      const addCam = await window.electronAPI.addNewCamera({ name: 'TestCam', city: 'HN', status: 1 });
      showResult('addNewCamera', addCam);
    } else {
      showResult('addNewCamera', 'Không có hàm addNewCamera');
    }

    // Test getLatestDetections
    if (window.electronAPI.getLatestDetections) {
      const detections = await window.electronAPI.getLatestDetections({ cameraId: 'cam1', limit: 3 });
      showResult('getLatestDetections', detections);
    } else {
      showResult('getLatestDetections', 'Không có hàm getLatestDetections');
    }

    // Test violation-add
    if (window.electronAPI.violationAdd) {
      const violation = await window.electronAPI.violationAdd({ camera_id: 1, message: 'Test violation' });
      showResult('violationAdd', violation);
    } else {
      showResult('violationAdd', 'Không có hàm violationAdd');
    }

    // Test line-upsert
    if (window.electronAPI.lineUpsert) {
      const lineUpsert = await window.electronAPI.lineUpsert({ camera_id: 1, name: 'TestLine', pointLtX: 10, pointLtY: 20, pointRbX: 30, pointRbY: 40 });
      showResult('lineUpsert', lineUpsert);
    } else {
      showResult('lineUpsert', 'Không có hàm lineUpsert');
    }

    // Test line-list
    if (window.electronAPI.lineList) {
      const lineList = await window.electronAPI.lineList(1);
      showResult('lineList', lineList);
    } else {
      showResult('lineList', 'Không có hàm lineList');
    }

    // Test getTrafficHistory
    if (window.electronAPI.getTrafficHistory) {
      const trafficHistory = await window.electronAPI.getTrafficHistory(1, '24h');
      showResult('getTrafficHistory', trafficHistory);
    } else {
      showResult('getTrafficHistory', 'Không có hàm getTrafficHistory');
    }
  } catch (err) {
    resultDiv.innerHTML += `<b>Lỗi test IPC:</b> <pre>${err.message}</pre>`;
  }
}

// Gọi test khi load trang
window.addEventListener('DOMContentLoaded', testAllIPC);
let ws = null;

function connect(cameraId) {
  if (ws) ws.close();

  ws = new WebSocket(`ws://localhost:8080/?camera=${cameraId}`);

  ws.onopen = () => console.log(`Connected to ${cameraId}`);
  ws.onclose = () => console.log(`Disconnected from ${cameraId}`);

  ws.onmessage = function (event) {
    try {
      const data = JSON.parse(event.data);

      const img = document.getElementById('video-frame');
      img.src = 'data:image/jpeg;base64,' + data.frame;

      const metaDiv = document.getElementById('meta');
      const metaText = data.metadata && Object.keys(data.metadata).length
        ? `Frame ID: ${data.id}<br>Metadata: ${JSON.stringify(data.metadata)}`
        : `Frame ID: ${data.id}<br>No metadata`;
      metaDiv.innerHTML = metaText;
    } catch (err) {
      console.error('❌ Error parsing message:', err);
    }
  };
}

// Initial connection
const cameraSelect = document.getElementById('camera-select');
connect(cameraSelect.value);


cameraSelect.addEventListener('change', () => {
  const selectedCamera = cameraSelect.value;
  connect(selectedCamera);
});

// IPC: Lấy dữ liệu DB mới nhất
const fetchBtn = document.getElementById('fetch-db');
const dbResult = document.getElementById('db-result');
fetchBtn.addEventListener('click', async () => {
  dbResult.textContent = 'Đang lấy dữ liệu...';
  try {
    // Gọi IPC lấy dữ liệu DB mới nhất cho camera 'cam1', lấy 5 bản ghi
    const res = await window.electronAPI.getLatestDetections({ cameraId: 'cam1', limit: 5 });
    if (res.success) {
      dbResult.textContent = JSON.stringify(res.data, null, 2);
    } else {
      dbResult.textContent = 'Lỗi: ' + (res.message || 'Không lấy được dữ liệu');
    }
  } catch (err) {
    dbResult.textContent = 'Lỗi: ' + err.message;
  }
});