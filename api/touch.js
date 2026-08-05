import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const REDIS_KEY = 'touch:latest';
const ONLINE_THRESHOLD_MS = 30 * 1000; // 30 秒未上报视为离线

// 密钥验证
function checkAuth(req, res) {
  const apiKey = req.headers['x-device-key'];
  const expectedKey = process.env.DEVICE_API_KEY;

  if (!expectedKey) {
    res.status(500).json({ ok: false, error: 'Server misconfigured: DEVICE_API_KEY not set' });
    return false;
  }

  if (!apiKey || apiKey !== expectedKey) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }

  return true;
}

// 设置 CORS 头（供未来网页客户端读取，ESP32 不受浏览器跨域限制）
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-device-key');
}

// 校验 POST 请求体
function validateBody(body) {
  if (!body || typeof body !== 'object') return '请求体必须是 JSON 对象';

  const { deviceId, sensor1, sensor2, touch1, touch2 } = body;

  if (typeof deviceId !== 'string' || deviceId.trim() === '') {
    return 'deviceId 必须是非空字符串';
  }

  if (typeof sensor1 !== 'number' || !Number.isFinite(sensor1) || sensor1 < 0 || sensor1 > 4095) {
    return 'sensor1 必须是 0 到 4095 之间的有限数字';
  }

  if (typeof sensor2 !== 'number' || !Number.isFinite(sensor2) || sensor2 < 0 || sensor2 > 4095) {
    return 'sensor2 必须是 0 到 4095 之间的有限数字';
  }

  if (typeof touch1 !== 'boolean') {
    return 'touch1 必须是布尔值';
  }

  if (typeof touch2 !== 'boolean') {
    return 'touch2 必须是布尔值';
  }

  return null;
}

export default async function handler(req, res) {
  setCors(res);

  // 预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 密钥验证（GET 和 POST 都需要）
  if (!checkAuth(req, res)) return;

  // === POST /api/touch：接收 ESP32 上传的传感器数据 ===
  if (req.method === 'POST') {
    const body = req.body || {};
    const error = validateBody(body);

    if (error) {
      return res.status(400).json({ ok: false, error });
    }

    const data = {
      deviceId: body.deviceId,
      sensor1: body.sensor1,
      sensor2: body.sensor2,
      touch1: body.touch1,
      touch2: body.touch2,
      receivedAt: new Date().toISOString(),
    };

    try {
      await redis.set(REDIS_KEY, data);
    } catch (err) {
      console.error('Redis write error:', err);
      return res.status(500).json({ ok: false, error: '写入存储失败' });
    }

    return res.status(200).json({
      ok: true,
      message: '数据已接收',
      data,
    });
  }

  // === GET /api/touch：返回最新传感器数据 ===
  if (req.method === 'GET') {
    // 禁止缓存压力数据
    res.setHeader('Cache-Control', 'no-store');

    let data;
    try {
      data = await redis.get(REDIS_KEY);
    } catch (err) {
      console.error('Redis read error:', err);
      return res.status(500).json({ ok: false, error: '读取存储失败' });
    }

    if (!data) {
      return res.status(200).json({
        ok: true,
        online: false,
        data: null,
      });
    }

    // 根据 receivedAt 判断是否在线
    const receivedAt = new Date(data.receivedAt).getTime();
    const now = Date.now();
    const online = !isNaN(receivedAt) && (now - receivedAt) <= ONLINE_THRESHOLD_MS;

    return res.status(200).json({
      ok: true,
      online,
      data,
    });
  }

  return res.status(405).json({ ok: false, error: '不支持的请求方法' });
}
