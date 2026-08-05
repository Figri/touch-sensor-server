# touch-sensor-server

Vercel Serverless API，用于接收 ESP32 触摸传感器上传的数据并提供查询接口。

## 接口说明

### POST /api/touch

接收 ESP32 上传的 JSON 数据并保存（内存变量）。

**请求体：**

```json
{
  "sensor1": 1234,
  "sensor2": 567
}
```

**响应示例：**

```json
{
  "ok": true,
  "message": "数据已接收",
  "data": {
    "sensor1": 1234,
    "sensor2": 567,
    "timestamp": "2026-08-05T10:30:00.000Z"
  }
}
```

### GET /api/touch

返回当前保存的最近一次数据。

**响应示例：**

```json
{
  "sensor1": 1234,
  "sensor2": 567,
  "timestamp": "2026-08-05T10:30:00.000Z"
}
```

## 本地开发

```bash
npm install -g vercel
npm run dev
```

## ESP32 调用示例（Arduino HTTPClient）

```cpp
http.begin("https://<你的域名>/api/touch");
http.addHeader("Content-Type", "application/json");
String body = "{\"sensor1\":1234,\"sensor2\":567}";
int code = http.POST(body);
```
