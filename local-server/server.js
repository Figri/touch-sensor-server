/*
 * 触摸玩偶 API 服务器 V2 — 阿里云轻量服务器
 *
 * 功能：
 *   POST /api/touch          — ESP32 上报数据（需密钥）
 *   GET  /api/touch          — 获取最新实时数据（需密钥）
 *   GET  /api/touch-history  — 触摸事件历史（公开）
 *   GET  /api/touch-latest   — 最近一次触摸汇总（公开）
 *   GET  /viewer             — 前端查看页面（公开）
 *   GET  /health             — 健康检查（公开）
 *
 * 触摸事件追踪逻辑：
 *   - 当 touch1/touch2 从 false→true 时，开始记录一次触摸
 *   - 追踪该次触摸的最大力度值
 *   - 当 touch1/touch2 从 true→false 时，触摸结束，计算持续时间
 *   - 只存有触摸的事件，不存 idle 心跳
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { handleMcpRequest } = require('./mcp-handler');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DEVICE_API_KEY || 'touch-demo-key-2026';

// 数据文件放在用户主目录下，避免 /opt 权限问题
const DATA_DIR = path.join(os.homedir(), 'touch-doll-data');
const DATA_FILE = path.join(DATA_DIR, 'touch-history.json');
const MAX_HISTORY = 500;

// 确保数据目录存在
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error('[存储] 创建数据目录失败:', e.message);
}

// ============ 触摸事件追踪 ============
const touchState = {
  // 传感器1的触摸追踪
  s1: { touching: false, startTime: 0, maxForce: 0 },
  // 传感器2的触摸追踪
  s2: { touching: false, startTime: 0, maxForce: 0 },
};

// 历史记录（内存 + 文件持久化）
let history = [];
let latestTouchSummary = null;

// 加载历史数据
try {
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  history = JSON.parse(raw);
  if (!Array.isArray(history)) history = [];
} catch (e) {
  history = [];
}

function saveHistory() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(history.slice(-MAX_HISTORY)), 'utf-8');
  } catch (e) {
    console.error('[存储] 保存失败:', e.message);
  }
}

function getForceDescription(value) {
  if (value <= 300) return '轻轻碰';
  if (value <= 1000) return '摸摸';
  if (value <= 2500) return '用力按';
  if (value <= 3500) return '抱紧';
  return '狠狠抱紧';
}

function getSensorLabel(sensor) {
  return sensor === 's1' ? '脸' : '大大灵';
}

// 处理触摸状态变化
function processTouch(parsed, receivedAt) {
  const now = Date.now();
  const ts = new Date(receivedAt);

  // === 传感器1 ===
  if (parsed.touch1 && !touchState.s1.touching) {
    // 开始触摸
    touchState.s1.touching = true;
    touchState.s1.startTime = now;
    touchState.s1.maxForce = parsed.sensor1;
    console.log(`[触摸开始] 脸 s1=${parsed.sensor1} 服务器时间=${ts.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`);
  } else if (parsed.touch1 && touchState.s1.touching) {
    // 持续触摸，更新最大力度
    if (parsed.sensor1 > touchState.s1.maxForce) {
      touchState.s1.maxForce = parsed.sensor1;
    }
  } else if (!parsed.touch1 && touchState.s1.touching) {
    // 触摸结束
    const duration = (now - touchState.s1.startTime) / 1000;
    const event = {
      time: ts.toISOString(),
      device: parsed.deviceId,
      sensor: 's1',
      sensorLabel: '脸',
      maxForce: touchState.s1.maxForce,
      duration: Math.round(duration * 10) / 10,
      description: getForceDescription(touchState.s1.maxForce),
    };
    history.push(event);
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    saveHistory();

    latestTouchSummary = {
      lastTouch: event.time,
      sensor: event.sensor,
      sensorLabel: event.sensorLabel,
      maxForce: event.maxForce,
      forcePercent: Math.round((event.maxForce / 4095) * 100),
      duration: event.duration,
      description: event.description,
    };

    console.log(`[触摸结束] 脸 力度=${event.maxForce}(${event.description}) 持续=${event.duration}s`);
    touchState.s1.touching = false;
  }

  // === 传感器2 ===
  if (parsed.touch2 && !touchState.s2.touching) {
    touchState.s2.touching = true;
    touchState.s2.startTime = now;
    touchState.s2.maxForce = parsed.sensor2;
    console.log(`[触摸开始] 大大灵 s2=${parsed.sensor2} 服务器时间=${ts.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`);
  } else if (parsed.touch2 && touchState.s2.touching) {
    if (parsed.sensor2 > touchState.s2.maxForce) {
      touchState.s2.maxForce = parsed.sensor2;
    }
  } else if (!parsed.touch2 && touchState.s2.touching) {
    const duration = (now - touchState.s2.startTime) / 1000;
    const event = {
      time: ts.toISOString(),
      device: parsed.deviceId,
      sensor: 's2',
      sensorLabel: '大大灵',
      maxForce: touchState.s2.maxForce,
      duration: Math.round(duration * 10) / 10,
      description: getForceDescription(touchState.s2.maxForce),
    };
    history.push(event);
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    saveHistory();

    latestTouchSummary = {
      lastTouch: event.time,
      sensor: event.sensor,
      sensorLabel: event.sensorLabel,
      maxForce: event.maxForce,
      forcePercent: Math.round((event.maxForce / 4095) * 100),
      duration: event.duration,
      description: event.description,
    };

    console.log(`[触摸结束] 大大灵 力度=${event.maxForce}(${event.description}) 持续=${event.duration}s`);
    touchState.s2.touching = false;
  }
}

// ============ 工具函数 ============
let latestData = null;
const ONLINE_THRESHOLD_MS = 30 * 1000;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-device-key');
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
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

// ============ Viewer HTML 页面 ============
function getViewerHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>共感娃娃触摸记录</title>
<style>
:root{--bg:#0f1117;--card:#1a1d28;--border:#2a2d3a;--text:#e0e0e0;--dim:#888;--accent:#4f8cff;--touch:#ff6b81;--ok:#42d392}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;min-height:100vh;padding:16px}
.status-bar{text-align:center;padding:40px 20px;background:var(--card);border-radius:16px;margin-bottom:20px;border:1px solid var(--border);transition:border-color .3s}
.status-bar.active{border-color:var(--touch)}
.status-bar h1{font-size:32px;font-weight:700;margin-bottom:8px}
.status-bar.idle h1{color:var(--dim)}
.status-bar.active h1{color:var(--touch)}
.status-bar .detail{font-size:16px;color:var(--dim)}
.status-bar .detail span{color:var(--accent);font-weight:600}
.status-bar.active .detail span{color:var(--touch)}
.history-list{display:flex;flex-direction:column;gap:8px;max-width:600px;margin:0 auto}
.history-list h2{font-size:18px;margin-bottom:8px;color:var(--dim)}
.event{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--card);border-radius:12px;border:1px solid var(--border)}
.event .icon{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;flex-shrink:0}
.event .icon.s1{background:rgba(79,140,255,.15);color:var(--accent)}
.event .icon.s2{background:rgba(255,107,129,.15);color:var(--touch)}
.event .info{flex:1;min-width:0}
.event .info .top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.event .info .label{font-weight:600;font-size:15px}
.event .info .desc{font-size:13px;padding:2px 8px;border-radius:6px;background:rgba(255,255,255,.06);color:var(--dim)}
.event .info .time{font-size:12px;color:var(--dim)}
.event .stats{text-align:right;flex-shrink:0}
.event .stats .force{font-size:20px;font-weight:700}
.event .stats .force .pct{font-size:14px;color:var(--dim)}
.event .stats .dur{font-size:12px;color:var(--dim)}
.empty{text-align:center;padding:40px;color:var(--dim);font-size:15px}
</style>
</head>
<body>
<div class="status-bar idle" id="statusBar">
  <h1 id="statusText">等待中...</h1>
  <div class="detail" id="statusDetail">等待触摸</div>
</div>
<div class="history-list">
  <h2>触摸记录</h2>
  <div id="historyContainer">
    <div class="empty">暂无记录</div>
  </div>
</div>
<script>
var API_KEY='touch-demo-key-2026';
function fmtTime(iso){
  var d=new Date(iso);
  var pad=function(n){return n<10?'0'+n:n};
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
}
async function poll(){
  try{
    var r=await fetch('/api/touch',{headers:{'x-device-key':API_KEY}});
    var d=await r.json();
    var bar=document.getElementById('statusBar');
    var text=document.getElementById('statusText');
    var detail=document.getElementById('statusDetail');
    if(d.ok&&d.data){
      var touching=d.data.touch1||d.data.touch2;
      if(touching){
        bar.className='status-bar active';
        var sensor=d.data.touch1?'脸':'大大灵';
        var val=d.data.touch1?d.data.sensor1:d.data.sensor2;
        var pct=Math.round(val/4095*100);
        text.textContent='正在被摸！力度: '+pct+'%';
        detail.innerHTML='位置: <span>'+sensor+'</span> | 原始值: '+val;
      }else{
        bar.className='status-bar idle';
        text.textContent='等待中...';
        detail.textContent='设备在线，等待触摸';
      }
    }else{
      bar.className='status-bar idle';
      text.textContent='等待中...';
      detail.textContent='设备未连接';
    }
  }catch(e){}
  try{
    var r2=await fetch('/api/touch-history?limit=50');
    var h=await r2.json();
    var c=document.getElementById('historyContainer');
    if(!h||h.length===0){
      c.innerHTML='<div class="empty">暂无记录</div>';
    }else{
      c.innerHTML=h.map(function(e){
        var pct=Math.round(e.maxForce/4095*100);
        var icn=e.sensor==='s1'?'脸':'灵';
        return '<div class="event">'
          +'<div class="icon '+e.sensor+'">'+icn+'</div>'
          +'<div class="info">'
          +'<div class="top">'
          +'<span class="label">'+e.sensorLabel+'</span>'
          +'<span class="desc">'+e.description+'</span>'
          +'</div>'
          +'<div class="time">'+fmtTime(e.time)+'</div>'
          +'</div>'
          +'<div class="stats">'
          +'<div class="force">'+pct+'<span class="pct">%</span></div>'
          +'<div class="dur">'+e.duration+'s</div>'
          +'</div>'
          +'</div>';
      }).join('');
    }
  }catch(e){}
}
poll();
setInterval(poll,3000);
</script>
</body>
</html>`;
}

// ============ HTTP 服务器 ============
const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // === MCP 端点（Claude 自定义连接器）===
  // POST /mcp — JSON-RPC 2.0 over HTTP
  // GET  /mcp — 返回服务器信息（健康检查）
  if (req.url === '/mcp' || req.url.startsWith('/mcp?')) {
    if (req.method === 'POST') {
      const mcpContext = { history, latestTouchSummary, touchState };
      handleMcpRequest(req, res, mcpContext);
      return;
    }
    if (req.method === 'GET') {
      sendJSON(res, 200, {
        server: 'touch-doll-mcp',
        version: '1.0.0',
        protocolVersion: '2025-06-18',
        tools: ['get_recent_touches', 'get_last_touch'],
        events: history.length,
      });
      return;
    }
  }

  // === 公开路由（不需要密钥）===

  // GET /viewer — 前端页面
  if (req.method === 'GET' && (req.url === '/viewer' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getViewerHTML());
    return;
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    sendJSON(res, 200, { ok: true, uptime: process.uptime(), events: history.length });
    return;
  }

  // GET /api/touch-history
  if (req.method === 'GET' && req.url.startsWith('/api/touch-history')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const limit = parseInt(urlObj.searchParams.get('limit')) || 50;
    const data = history.slice(-limit).reverse();
    sendJSON(res, 200, data);
    return;
  }

  // GET /api/touch-latest
  if (req.method === 'GET' && req.url === '/api/touch-latest') {
    // 如果有正在进行的触摸，也返回实时状态
    const live = {};
    if (touchState.s1.touching) {
      live.s1 = {
        touching: true,
        currentForce: touchState.s1.maxForce,
        duration: Math.round((Date.now() - touchState.s1.startTime) / 100) / 10,
      };
    }
    if (touchState.s2.touching) {
      live.s2 = {
        touching: true,
        currentForce: touchState.s2.maxForce,
        duration: Math.round((Date.now() - touchState.s2.startTime) / 100) / 10,
      };
    }
    sendJSON(res, 200, { latest: latestTouchSummary, live: live });
    return;
  }

  // === 以下路由需要密钥验证 ===
  const apiKey = req.headers['x-device-key'];
  if (!apiKey || apiKey !== API_KEY) {
    sendJSON(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  // GET /api/touch — 实时数据
  if (req.method === 'GET' && req.url === '/api/touch') {
    res.setHeader('Cache-Control', 'no-store');
    if (!latestData) {
      sendJSON(res, 200, { ok: true, online: false, data: null });
      return;
    }
    const receivedAt = new Date(latestData.receivedAt).getTime();
    const now = Date.now();
    const online = !isNaN(receivedAt) && (now - receivedAt) <= ONLINE_THRESHOLD_MS;
    sendJSON(res, 200, { ok: true, online, data: latestData });
    return;
  }

  // POST /api/touch — ESP32 上报
  if (req.method === 'POST' && req.url === '/api/touch') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' });
        return;
      }

      const error = validateBody(parsed);
      if (error) {
        sendJSON(res, 400, { ok: false, error });
        return;
      }

      const now = new Date().toISOString();
      latestData = {
        deviceId: parsed.deviceId,
        sensor1: parsed.sensor1,
        sensor2: parsed.sensor2,
        touch1: parsed.touch1,
        touch2: parsed.touch2,
        receivedAt: now,
      };

      // 处理触摸事件
      processTouch(parsed, now);

      const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      if (parsed.touch1 || parsed.touch2) {
        console.log(`[${t}] 触摸中: device=${parsed.deviceId} s1=${parsed.sensor1} s2=${parsed.sensor2} t1=${parsed.touch1} t2=${parsed.touch2}`);
      }

      sendJSON(res, 200, { ok: true, message: '数据已接收', data: latestData });
    });
    return;
  }

  sendJSON(res, 404, { ok: false, error: 'Not Found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  触摸玩偶 API + MCP 服务器 V3');
  console.log('========================================');
  console.log(`监听端口: ${PORT}`);
  console.log(`API 密钥: ${API_KEY}`);
  console.log(`查看页面: http://<本机IP>:${PORT}/viewer`);
  console.log(`MCP 端点: http://<本机IP>:${PORT}/mcp`);
  console.log(`历史记录: ${history.length} 条`);
  console.log('');
});
