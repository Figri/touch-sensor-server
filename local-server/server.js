/*
 * 触摸玩偶 API 服务器 — 部署在阿里云轻量服务器
 *
 * 部署方式（SSH 到服务器后执行）：
 *   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
 *   sudo apt-get install -y nodejs
 *   sudo npm install -g pm2
 *   git clone https://github.com/Figri/touch-sensor-server.git /opt/touch-doll
 *   cd /opt/touch-doll/local-server
 *   pm2 start server.js --name touch-doll
 *   pm2 save
 *   pm2 startup
 *
 * 防火墙：在阿里云控制台开放 3000 端口（TCP）
 */

const http = require('http');
const os = require('os');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DEVICE_API_KEY || 'touch-demo-key-2026';

// 内存存储最新数据
let latestData = null;
let lastReceivedAt = null;
const ONLINE_THRESHOLD_MS = 30 * 1000;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-device-key');
}

function validateBody(body) {
  if (!body || typeof body !== 'object') return '请求体必须是 JSON 对象';
  const { deviceId, sensor1, sensor2, touch1, touch2 } = body;
  if (typeof deviceId !== 'string' || deviceId.trim() === '') return 'deviceId 必须是非空字符串';
  if (typeof sensor1 !== 'number' || !Number.isFinite(sensor1) || sensor1 < 0 || sensor1 > 4095) return 'sensor1 必须是 0~4095 的数字';
  if (typeof sensor2 !== 'number' || !Number.isFinite(sensor2) || sensor2 < 0 || sensor2 > 4095) return 'sensor2 必须是 0~4095 的数字';
  if (typeof touch1 !== 'boolean') return 'touch1 必须是布尔值';
  if (typeof touch2 !== 'boolean') return 'touch2 必须是布尔值';
  return null;
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 密钥验证
  const apiKey = req.headers['x-device-key'];
  if (!apiKey || apiKey !== API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }

  // GET /api/touch
  if (req.method === 'GET' && req.url === '/api/touch') {
    res.setHeader('Cache-Control', 'no-store');
    if (!latestData) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, online: false, data: null }));
      return;
    }
    const receivedAt = new Date(latestData.receivedAt).getTime();
    const now = Date.now();
    const online = !isNaN(receivedAt) && (now - receivedAt) <= ONLINE_THRESHOLD_MS;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, online, data: latestData }));
    return;
  }

  // POST /api/touch
  if (req.method === 'POST' && req.url === '/api/touch') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败' }));
        return;
      }

      const error = validateBody(parsed);
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error }));
        return;
      }

      latestData = {
        deviceId: parsed.deviceId,
        sensor1: parsed.sensor1,
        sensor2: parsed.sensor2,
        touch1: parsed.touch1,
        touch2: parsed.touch2,
        receivedAt: new Date().toISOString(),
      };
      lastReceivedAt = Date.now();

      const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      console.log(`[${t}] 收到数据: device=${parsed.deviceId} s1=${parsed.sensor1} s2=${parsed.sensor2} t1=${parsed.touch1} t2=${parsed.touch2}`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, message: '数据已接收', data: latestData }));
    });
    return;
  }

  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), lastData: latestData }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  触摸玩偶 API 服务器');
  console.log('========================================');
  console.log(`监听端口: ${PORT}`);
  console.log(`API 密钥: ${API_KEY}`);
  console.log(`\nESP32 地址: http://<本机公网IP>:${PORT}/api/touch`);
  console.log(`健康检查: http://<本机公网IP>:${PORT}/health\n`);
});
