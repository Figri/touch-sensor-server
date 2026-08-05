# touch-sensor-server

Vercel Serverless API，接收 ESP32-S3 双压力传感器上传的数据，通过 Upstash Redis 保存最新状态并提供查询接口。

当前版本仅保存**最新一次**状态，不保存历史记录。

## 环境变量

在 Vercel 项目设置 → Environment Variables 中配置：

| 变量名 | 说明 | 示例 |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST 端点 URL | `https://xxx.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST 访问令牌 | `xxx` |
| `DEVICE_API_KEY` | 设备与服务端之间的共享密钥 | 自定义任意字符串 |

Upstash Redis 可通过 Vercel 集成市场一键添加，会自动注入上述两个环境变量。

## 接口说明

所有请求（GET 和 POST）都需在请求头中携带密钥：

```
x-device-key: <DEVICE_API_KEY>
```

### POST /api/touch

接收 ESP32-S3 上传的压力传感器数据，并写入 Redis（key: `touch:latest`）。

**请求体：**

```json
{
  "deviceId": "doll-01",
  "sensor1": 1234,
  "sensor2": 567,
  "touch1": true,
  "touch2": false
}
```

**字段校验规则：**

- `deviceId`：非空字符串
- `sensor1`、`sensor2`：0 ~ 4095 之间的有限数字
- `touch1`、`touch2`：布尔值
- 校验失败返回 HTTP 400

**成功响应（HTTP 200）：**

```json
{
  "ok": true,
  "message": "数据已接收",
  "data": {
    "deviceId": "doll-01",
    "sensor1": 1234,
    "sensor2": 567,
    "touch1": true,
    "touch2": false,
    "receivedAt": "2026-08-05T10:30:00.000Z"
  }
}
```

服务端会在写入时追加 `receivedAt`（ISO 时间字符串）。

### GET /api/touch

返回最新保存的传感器数据。响应头含 `Cache-Control: no-store`，禁止缓存。

**有数据且 30 秒内有上报（online=true）：**

```json
{
  "ok": true,
  "online": true,
  "data": {
    "deviceId": "doll-01",
    "sensor1": 1234,
    "sensor2": 567,
    "touch1": true,
    "touch2": false,
    "receivedAt": "2026-08-05T10:30:00.000Z"
  }
}
```

**超过 30 秒未上报（online=false）：**

```json
{
  "ok": true,
  "online": false,
  "data": { ... }
}
```

**Redis 中没有任何数据：**

```json
{
  "ok": true,
  "online": false,
  "data": null
}
```

### 错误响应

- **401 Unauthorized**：缺少 `x-device-key` 请求头或密钥错误
  ```json
  { "ok": false, "error": "Unauthorized" }
  ```
- **400 Bad Request**：请求体字段不合法
  ```json
  { "ok": false, "error": "sensor1 必须是 0 到 4095 之间的有限数字" }
  ```
- **405 Method Not Allowed**：不支持的 HTTP 方法

## CORS

接口已开启 CORS，允许任意来源的浏览器网页调用，允许方法：`GET`、`POST`、`OPTIONS`，允许请求头：`Content-Type`、`x-device-key`。

> 注意：CORS 是浏览器安全策略，ESP32 等非浏览器客户端不受影响。

## curl 测试命令

```bash
# 替换为你的部署地址和密钥
API_URL="https://your-project.vercel.app/api/touch"
API_KEY="your-device-api-key"

# POST 上传数据
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "x-device-key: $API_KEY" \
  -d '{"deviceId":"doll-01","sensor1":1234,"sensor2":567,"touch1":true,"touch2":false}'

# GET 查询数据
curl -H "x-device-key: $API_KEY" "$API_URL"

# 测试错误密钥（应返回 401）
curl -H "x-device-key: wrong-key" "$API_URL"

# 测试超出范围（应返回 400）
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "x-device-key: $API_KEY" \
  -d '{"deviceId":"doll-01","sensor1":9999,"sensor2":567,"touch1":true,"touch2":false}'
```

## ESP32 请求头格式

在 Arduino 代码中：

```cpp
#include <HTTPClient.h>
#include "secrets.h"  // Wi-Fi 凭据

// 服务器地址和密钥
const char* SERVER_URL = "https://your-project.vercel.app/api/touch";
const char* DEVICE_API_KEY = "your-device-api-key";

void postSensorData(int s1, int s2, bool t1, bool t2) {
  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_API_KEY);

  String body = "{\"deviceId\":\"doll-01\",";
  body += "\"sensor1\":" + String(s1) + ",";
  body += "\"sensor2\":" + String(s2) + ",";
  body += "\"touch1\":" + String(t1 ? "true" : "false") + ",";
  body += "\"touch2\":" + String(t2 ? "true" : "false") + "}";

  int code = http.POST(body);
  Serial.printf("HTTP %d\n", code);
  http.end();
}
```

> Wi-Fi 凭据保存在本地 `secrets.h` 中，该文件已加入 `.gitignore`，不会提交到 GitHub。使用前请复制 `secrets.example.h` 为 `secrets.h` 并填入真实凭据。

## 数据结构（Redis key: `touch:latest`）

```json
{
  "deviceId": "doll-01",
  "sensor1": 1234,
  "sensor2": 567,
  "touch1": true,
  "touch2": false,
  "receivedAt": "2026-08-05T10:30:00.000Z"
}
```

## 部署步骤

### 1. 准备 Upstash Redis

在 Vercel Dashboard → 项目 → Integrations → Add Integration → 搜索 **Upstash Redis** → 安装并创建数据库。安装后会自动注入以下环境变量：

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### 2. 配置设备密钥

在 Vercel 项目 → Settings → Environment Variables 中添加：

- `DEVICE_API_KEY` = 你自定义的密钥字符串

### 3. 推送代码并部署

```bash
git push origin main
```

由于仓库已与 Vercel 关联，推送到 `main` 分支会自动触发部署。

也可手动部署：

```bash
vercel deploy --prod
```

### 4. 验证部署

用上面的 curl 测试命令验证 POST 和 GET 是否正常。

## 文件结构

```
.
├── api/
│   └── touch.js          # 核心接口（GET/POST /api/touch）
├── .gitignore            # 忽略规则（含 secrets.h）
├── secrets.example.h     # ESP32 Wi-Fi 凭据示例（占位符）
├── secrets.h             # 本地 Wi-Fi 凭据（不提交）
├── package.json          # 项目依赖
└── README.md             # 本文档
```

## 说明

- 仅保存最新一次传感器数据，不保存历史记录
- 30 秒未收到设备上报时，GET 接口返回 `online: false`
- 所有接口均需密钥验证，密钥通过环境变量配置，不写入代码
