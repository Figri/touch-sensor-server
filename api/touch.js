// 内存变量：保存最近一次传感器数据
// 注意：Vercel Serverless 是无状态的，实例冷启动后内存会重置，
// 这里仅作为最简实现满足需求；如需持久化可接 Vercel KV / Upstash Redis。
let latestData = {
  sensor1: 0,
  sensor2: 0,
  timestamp: null,
};

export default function handler(req, res) {
  // === CORS：允许 ESP32 及任意客户端跨域访问 ===
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 处理预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // === POST /api/touch：接收 ESP32 上传的 JSON 数据 ===
  if (req.method === 'POST') {
    const { sensor1, sensor2 } = req.body || {};

    // 参数校验
    if (sensor1 === undefined || sensor2 === undefined) {
      return res.status(400).json({
        ok: false,
        error: '请求体缺少 sensor1 或 sensor2 字段',
      });
    }

    // 保存最近一次数据
    latestData = {
      sensor1: Number(sensor1),
      sensor2: Number(sensor2),
      timestamp: new Date().toISOString(),
    };

    return res.status(200).json({
      ok: true,
      message: '数据已接收',
      data: latestData,
    });
  }

  // === GET /api/touch：返回当前保存的数据 ===
  if (req.method === 'GET') {
    return res.status(200).json(latestData);
  }

  // 其他方法不允许
  return res.status(405).json({
    ok: false,
    error: '不支持的请求方法，仅允许 GET / POST',
  });
}
