function countVehiclesInLine(detections, list_line) {
    // Khởi tạo object để lưu số lượng xe cho mỗi line
    const lineCount = {};

    // Khởi tạo count = 0 cho tất cả các line
    list_line.forEach(line => {
        lineCount[line.id] = 0;
    });

    // Duyệt qua các kết quả detection từ tất cả model
    Object.keys(detections.results).forEach(modelName => {
        const modelDetections = detections.results[modelName];

        // Duyệt qua từng detection
        modelDetections.forEach(detection => {
            const vehicleBox = detection.xyxy; // [x1, y1, x2, y2]
            const vehicleCenter = {
                x: (vehicleBox[0] + vehicleBox[2]) / 2,
                y: (vehicleBox[1] + vehicleBox[3]) / 2
            };

            // Kiểm tra xe có nằm trong line nào không
            list_line.forEach(line => {
                if (isPointInLine(vehicleCenter, line)) {
                    lineCount[line.id]++;
                }
            });
        });
    });

    return {
        timestamp: detections.timestamp,
        frameNumber: detections.frameNumber,
        camId: detections.camId,
        lineCounts: lineCount,
        totalVehicles: Object.values(lineCount).reduce((sum, count) => sum + count, 0)
    };
}

// Hàm hỗ trợ kiểm tra điểm có nằm trong vùng line không
function isPointInLine(point, line) {
    // Giả sử line có dạng: { id, points: [{x, y}, {x, y}, ...], width }
    // hoặc { id, x1, y1, x2, y2, width } cho line thẳng

    if (line.points && line.points.length >= 2) {
        // Line được định nghĩa bằng nhiều điểm (polygon hoặc polyline)
        return isPointInPolygon(point, line.points, line.width || 20);
    } else if (line.x1 !== undefined && line.y1 !== undefined &&
        line.x2 !== undefined && line.y2 !== undefined) {
        // Line được định nghĩa bằng 2 điểm
        return isPointNearLine(point,
            { x: line.x1, y: line.y1 },
            { x: line.x2, y: line.y2 },
            line.width || 20
        );
    }

    return false;
}

// Hàm kiểm tra điểm có gần đường thẳng không
function isPointNearLine(point, lineStart, lineEnd, threshold) {
    const A = point.x - lineStart.x;
    const B = point.y - lineStart.y;
    const C = lineEnd.x - lineStart.x;
    const D = lineEnd.y - lineStart.y;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;

    if (lenSq === 0) return false; // Line có độ dài = 0

    const param = dot / lenSq;

    let xx, yy;
    if (param < 0) {
        xx = lineStart.x;
        yy = lineStart.y;
    } else if (param > 1) {
        xx = lineEnd.x;
        yy = lineEnd.y;
    } else {
        xx = lineStart.x + param * C;
        yy = lineStart.y + param * D;
    }

    const dx = point.x - xx;
    const dy = point.y - yy;
    const distance = Math.sqrt(dx * dx + dy * dy);

    return distance <= threshold;
}

// Hàm kiểm tra điểm có trong polygon không (cho trường hợp line phức tạp)
function isPointInPolygon(point, polygon, threshold = 20) {
    // Tạo vùng buffer xung quanh polygon với độ rộng threshold
    // Đây là implementation đơn giản, có thể cần cải tiến tùy theo yêu cầu

    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        if (((polygon[i].y > point.y) !== (polygon[j].y > point.y)) &&
            (point.x < (polygon[j].x - polygon[i].x) * (point.y - polygon[i].y) / (polygon[j].y - polygon[i].y) + polygon[i].x)) {
            inside = !inside;
        }
    }

    // Nếu không nằm trong polygon, kiểm tra khoảng cách đến các cạnh
    if (!inside) {
        for (let i = 0; i < polygon.length; i++) {
            const j = (i + 1) % polygon.length;
            if (isPointNearLine(point, polygon[i], polygon[j], threshold)) {
                return true;
            }
        }
    }

    return inside;
}

// Class Vehicle Tracker để theo dõi xe trong khoảng thời gian
class VehicleTracker {
    constructor() {
        this.trackedVehicles = new Map(); // Map để lưu thông tin xe đã track
        this.nextVehicleId = 1;
        this.timeWindow = 30 * 1000; // 30 giây (ms)
        this.countData = new Map(); // Lưu dữ liệu đếm theo thời gian
        this.trackingHistory = []; // Lưu lịch sử tracking
    }

    // Tính toán IoU (Intersection over Union) giữa 2 bounding box
    calculateIoU(box1, box2) {
        const [x1_1, y1_1, x2_1, y2_1] = box1;
        const [x1_2, y1_2, x2_2, y2_2] = box2;

        // Tính diện tích giao nhau
        const xA = Math.max(x1_1, x1_2);
        const yA = Math.max(y1_1, y1_2);
        const xB = Math.min(x2_1, x2_2);
        const yB = Math.min(y2_1, y2_2);

        const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);

        // Tính diện tích từng box
        const boxAArea = (x2_1 - x1_1) * (y2_1 - y1_1);
        const boxBArea = (x2_2 - x1_2) * (y2_2 - y1_2);

        // Tính IoU
        const iou = interArea / (boxAArea + boxBArea - interArea);
        return iou;
    }

    // Tính khoảng cách Euclidean giữa 2 center point
    calculateDistance(center1, center2) {
        const dx = center1.x - center2.x;
        const dy = center1.y - center2.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // Tracking xe với thuật toán đơn giản dựa trên IoU và khoảng cách
    trackVehicles(detections, list_line) {
        const currentTime = Date.now();
        const frameVehicles = [];

        // Xử lý detection từ tất cả model
        Object.keys(detections.results).forEach(modelName => {
            const modelDetections = detections.results[modelName];

            modelDetections.forEach(detection => {
                const vehicleBox = detection.xyxy;
                const vehicleCenter = {
                    x: (vehicleBox[0] + vehicleBox[2]) / 2,
                    y: (vehicleBox[1] + vehicleBox[3]) / 2
                };

                // Tìm xe matching với xe đã track trước đó
                let matchedVehicleId = null;
                let bestScore = 0;
                const maxDistance = 100; // pixel
                const minIoU = 0.3;

                for (const [vehicleId, trackedVehicle] of this.trackedVehicles) {
                    if (currentTime - trackedVehicle.lastSeen > 5000) continue; // Skip nếu quá cũ (5s)

                    const distance = this.calculateDistance(vehicleCenter, trackedVehicle.lastCenter);
                    const iou = this.calculateIoU(vehicleBox, trackedVehicle.lastBox);

                    // Scoring function: kết hợp IoU và khoảng cách
                    const score = iou * 0.7 + (1 - distance / maxDistance) * 0.3;

                    if (distance < maxDistance && iou > minIoU && score > bestScore) {
                        bestScore = score;
                        matchedVehicleId = vehicleId;
                    }
                }

                if (matchedVehicleId) {
                    // Update xe đã có
                    const trackedVehicle = this.trackedVehicles.get(matchedVehicleId);
                    trackedVehicle.lastSeen = currentTime;
                    trackedVehicle.lastCenter = vehicleCenter;
                    trackedVehicle.lastBox = vehicleBox;
                    trackedVehicle.confidence = detection.conf;
                    trackedVehicle.frameCount++;

                    frameVehicles.push({
                        id: matchedVehicleId,
                        center: vehicleCenter,
                        box: vehicleBox,
                        cls: detection.cls,
                        conf: detection.conf,
                        color: detection.color
                    });
                } else {
                    // Tạo xe mới
                    const newVehicleId = this.nextVehicleId++;

                    // console.log(`🚙 [DEBUG] NEW VEHICLE DETECTED #${newVehicleId} (${detection.cls})`);
                    // console.log(`   📍 Position: (${Math.round(vehicleCenter.x)}, ${Math.round(vehicleCenter.y)})`);
                    // console.log(`   🔢 Confidence: ${(detection.conf * 100).toFixed(1)}%`);

                    this.trackedVehicles.set(newVehicleId, {
                        id: newVehicleId,
                        firstSeen: currentTime,
                        lastSeen: currentTime,
                        lastCenter: vehicleCenter,
                        lastBox: vehicleBox,
                        cls: detection.cls,
                        confidence: detection.conf,
                        frameCount: 1,
                        lineHistory: [] // Lưu lịch sử xe đi qua line nào
                    });

                    frameVehicles.push({
                        id: newVehicleId,
                        center: vehicleCenter,
                        box: vehicleBox,
                        cls: detection.cls,
                        conf: detection.conf,
                        color: detection.color
                    });
                }
            });
        });

        // Dọn dẹp xe cũ (không xuất hiện trong 10 giây)
        const vehiclesToRemove = [];
        for (const [vehicleId, trackedVehicle] of this.trackedVehicles) {
            if (currentTime - trackedVehicle.lastSeen > 10000) {
                vehiclesToRemove.push(vehicleId);
            }
        }

        // Xóa xe đã biến mất (và reset lịch sử đếm của chúng)
        vehiclesToRemove.forEach(vehicleId => {
            const vehicle = this.trackedVehicles.get(vehicleId);
            // console.log(`👋 [DEBUG] Vehicle #${vehicleId} (${vehicle.cls}) DISAPPEARED`);
            // console.log(`   📊 Total lines crossed: ${vehicle.lineHistory.length}`);
            // console.log(`   ⏱️ Tracking duration: ${((currentTime - vehicle.firstSeen) / 1000).toFixed(1)}s`);
            this.trackedVehicles.delete(vehicleId);
        });

        // Đếm xe trong từng line với tracking
        const countingResult = this.countVehiclesInLineWithTracking(frameVehicles, list_line, currentTime);

        return {
            timestamp: detections.timestamp,
            frameNumber: detections.frameNumber,
            camId: detections.camId,
            trackedVehicles: frameVehicles,
            lineCounts: countingResult.lineCounts,
            newLineCrossings: countingResult.newLineCrossings,
            totalTrackedVehicles: this.trackedVehicles.size
        };
    }

    // Đếm xe trong line với tracking (mỗi xe chỉ đếm 1 lần cho mỗi line)
    countVehiclesInLineWithTracking(frameVehicles, list_line, currentTime) {
        const lineCounts = {};
        const newLineCrossings = []; // Mảng để lưu thông tin xe vừa qua line

        // Khởi tạo count cho tất cả line
        list_line.forEach(line => {
            lineCounts[line.id] = 0;
        });

        frameVehicles.forEach(vehicle => {
            const trackedVehicle = this.trackedVehicles.get(vehicle.id);

            list_line.forEach(line => {
                if (isPointInLine(vehicle.center, line)) {
                    // Kiểm tra xem xe này đã được đếm trong line này chưa (1 lần duy nhất)
                    const alreadyCounted = trackedVehicle.lineHistory.some(entry =>
                        entry.lineId === line.id
                    );

                    if (!alreadyCounted) {
                        lineCounts[line.id]++;

                        // Debug log chi tiết khi có xe được đếm
                        // console.log(`🎯 [DEBUG] Vehicle #${vehicle.id} (${vehicle.cls}) crossed line ${line.id}`);
                        // console.log(`   📍 Position: (${Math.round(vehicle.center.x)}, ${Math.round(vehicle.center.y)})`);
                        // console.log(`   🔢 Confidence: ${(vehicle.conf * 100).toFixed(1)}%`);
                        // console.log(`   ⏰ Timestamp: ${new Date(currentTime).toLocaleTimeString()}`);

                        // Lưu thông tin xe vừa qua line để cập nhật stats
                        newLineCrossings.push({
                            vehicleId: vehicle.id,
                            vehicleClass: vehicle.cls,
                            lineId: line.id,
                            timestamp: currentTime,
                            position: vehicle.center
                        });

                        // Lưu lại lịch sử - chỉ lưu 1 lần cho mỗi line
                        trackedVehicle.lineHistory.push({
                            lineId: line.id,
                            timestamp: currentTime,
                            counted: true // Đánh dấu đã đếm
                        });
                    }
                }
            });

            // Không cần dọn dẹp lịch sử nữa vì muốn giữ lại suốt đời xe
        });

        return { lineCounts, newLineCrossings };
    }    // Lấy thống kê trong khoảng thời gian
    getStatistics(timeRange = 60000) { // 1 phút
        const currentTime = Date.now();
        const validHistory = this.trackingHistory.filter(
            entry => (currentTime - entry.timestamp) < timeRange
        );

        const stats = {
            timeRange: timeRange,
            totalFrames: validHistory.length,
            averageVehicles: 0,
            maxVehicles: 0,
            lineStatistics: {}
        };

        if (validHistory.length > 0) {
            const totalVehicles = validHistory.reduce((sum, entry) =>
                sum + entry.totalTrackedVehicles, 0
            );
            stats.averageVehicles = totalVehicles / validHistory.length;
            stats.maxVehicles = Math.max(...validHistory.map(entry =>
                entry.totalTrackedVehicles
            ));

            // Thống kê theo line
            validHistory.forEach(entry => {
                Object.keys(entry.lineCounts).forEach(lineId => {
                    if (!stats.lineStatistics[lineId]) {
                        stats.lineStatistics[lineId] = {
                            total: 0,
                            average: 0,
                            max: 0,
                            frames: 0
                        };
                    }
                    stats.lineStatistics[lineId].total += entry.lineCounts[lineId];
                    stats.lineStatistics[lineId].max = Math.max(
                        stats.lineStatistics[lineId].max,
                        entry.lineCounts[lineId]
                    );
                    stats.lineStatistics[lineId].frames++;
                });
            });

            // Tính average cho từng line
            Object.keys(stats.lineStatistics).forEach(lineId => {
                const lineStat = stats.lineStatistics[lineId];
                lineStat.average = lineStat.total / lineStat.frames;
            });
        }

        return stats;
    }

    // Lưu dữ liệu tracking vào history
    saveTrackingData(trackingResult) {
        this.trackingHistory.push({
            ...trackingResult,
            timestamp: Date.now()
        });

        // Giữ lại chỉ 1 giờ dữ liệu
        const oneHour = 60 * 60 * 1000;
        const cutoffTime = Date.now() - oneHour;
        this.trackingHistory = this.trackingHistory.filter(
            entry => entry.timestamp > cutoffTime
        );
    }

    // Lấy line counts hiện tại (dùng cho debug)
    getLineCounts() {
        const lineCounts = {};
        // Lấy từ history gần nhất
        if (this.trackingHistory.length > 0) {
            const latestHistory = this.trackingHistory[this.trackingHistory.length - 1];
            return latestHistory.lineCounts || {};
        }
        return {};
    }

    // Reset tracker
    reset() {
        this.trackedVehicles.clear();
        this.nextVehicleId = 1;
        this.trackingHistory = [];
    }
}

// Function để format dữ liệu cho database
function formatDataForDatabase(trackingResult, statistics, camId) {
    return {
        cam_id: camId,
        timestamp: new Date(trackingResult.timestamp),
        frame_number: trackingResult.frameNumber,
        line_counts: trackingResult.lineCounts,
        total_vehicles: trackingResult.totalTrackedVehicles,
        statistics: statistics,
        raw_data: {
            tracked_vehicles: trackingResult.trackedVehicles.map(v => ({
                id: v.id,
                class: v.cls,
                confidence: v.conf,
                position: v.center
            }))
        }
    };
}

// Export functions và class
module.exports = {
    countVehiclesInLine,
    VehicleTracker,
    formatDataForDatabase,
    isPointInLine,
    isPointNearLine,
    isPointInPolygon
};