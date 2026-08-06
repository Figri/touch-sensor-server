/*
 * touch-doll.ino
 * ESP32-S3 双压力传感器固件
 *
 * 功能：
 * - 读取 GPIO4 / GPIO5 两路模拟传感器（0~4095），10 次平均去抖
 * - 触摸状态变化立即上报；触摸中每 500ms 上报；无触摸每 10s 心跳
 * - 首次启动或无配置时开启热点 TouchDoll-Setup，手机配置 Wi-Fi
 * - 服务器地址和密钥已内置默认值，手机配置只需填 Wi-Fi 名称和密码
 * - 配置存入 NVS (Preferences)，断电不丢失
 * - 长按 BOOT(GPIO0) 5 秒清除配置并重启进入配置模式
 * - Wi-Fi 连接失败 60s 进入配置模式；运行中断网自动重连
 *
 * 硬件：ESP32-S3 Dev Module
 *   GPIO4 = 传感器1 (ADC1_CH3)
 *   GPIO5 = 传感器2 (ADC1_CH4)
 *   GPIO0 = 板载 BOOT 按键（按下为低电平）
 *
 * 仅依赖 ESP32 Arduino 自带库，无需第三方库。
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <HTTPClient.h>

// ============ 引脚与常量 ============
#define SENSOR1_PIN      4
#define SENSOR2_PIN      5
#define BOOT_BTN_PIN     0

#define TOUCH_THRESHOLD  150
#define SAMPLE_COUNT     10

#define LONG_PRESS_MS    5000
#define WIFI_TIMEOUT_MS  60000
#define RECONNECT_MS     5000

#define SEND_TOUCH_MS    500
#define HEARTBEAT_MS     10000
#define STATE_CHANGE_GUARD_MS 100
#define HTTP_TIMEOUT_MS  3000

// 配置热点
const char* AP_SSID = "TouchDoll-Setup";
const char* AP_PASS  = "TouchDoll88";

// ============ 全局对象 ============
WebServer server(80);
DNSServer dnsServer;
Preferences prefs;

const byte DNS_PORT = 53;

// ============ 配置结构 ============
struct Config {
  String wifiSSID;
  String wifiPass;
  String serverUrl;
  String apiKey;
  String deviceId;
} cfg;

bool configMode = false;
unsigned long wifiConnectStart = 0;
unsigned long lastReconnect = 0;
bool wifiConnected = false;

unsigned long lastSendTime = 0;
unsigned long lastHeartbeat = 0;
bool lastTouch1 = false;
bool lastTouch2 = false;

unsigned long btnPressStart = 0;
bool btnWasPressed = false;

// ============ NVS 配置读写 ============
#define PREFS_NAMESPACE "touchdoll"

// 服务器默认配置（写入 NVS，手机配置时可覆盖）
// 阿里云轻量服务器（美国硅谷）公网 IP
const char* DEFAULT_SERVER_URL = "http://47.251.33.14:3000/api/touch";
const char* DEFAULT_API_KEY    = "touch-demo-key-2026";
const char* DEFAULT_DEVICE_ID  = "doll-01";

void loadConfig() {
  prefs.begin(PREFS_NAMESPACE, true);
  cfg.wifiSSID   = prefs.getString("ssid", "");
  cfg.wifiPass   = prefs.getString("pass", "");
  cfg.serverUrl  = prefs.getString("url", DEFAULT_SERVER_URL);
  cfg.apiKey     = prefs.getString("key", DEFAULT_API_KEY);
  cfg.deviceId   = prefs.getString("devid", DEFAULT_DEVICE_ID);
  prefs.end();
}

bool hasValidConfig() {
  return cfg.wifiSSID.length() > 0;
}

void clearConfig() {
  prefs.begin(PREFS_NAMESPACE, false);
  prefs.clear();
  prefs.end();
}

// ============ 传感器读取 ============
int readAveraged(int pin) {
  long sum = 0;
  for (int i = 0; i < SAMPLE_COUNT; i++) {
    sum += analogRead(pin);
  }
  int val = sum / SAMPLE_COUNT;
  if (val < 0) val = 0;
  if (val > 4095) val = 4095;
  return val;
}

// ============ 数据上报 ============
void sendData(int s1, int s2, bool t1, bool t2) {
  Serial.println("[HTTP] --- 开始发送 ---");
  Serial.printf("[HTTP] URL: %s\n", cfg.serverUrl.c_str());
  Serial.printf("[HTTP] Key: %s\n", cfg.apiKey.c_str());
  Serial.printf("[HTTP] WiFi状态: %s\n", WiFi.status() == WL_CONNECTED ? "已连接" : "未连接");
  Serial.printf("[HTTP] 本地IP: %s\n", WiFi.localIP().toString().c_str());

  String body = "{\"deviceId\":\"" + cfg.deviceId + "\"";
  body += ",\"sensor1\":" + String(s1);
  body += ",\"sensor2\":" + String(s2);
  body += ",\"touch1\":" + String(t1 ? "true" : "false");
  body += ",\"touch2\":" + String(t2 ? "true" : "false");
  body += "}";

  int code = -999;

  // 根据协议选择 HTTP 或 HTTPS
  if (cfg.serverUrl.startsWith("https://")) {
    // ===== HTTPS（需要 SSL，用于外网服务器）=====
    Serial.println("[HTTP] 使用 HTTPS 模式");
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(HTTP_TIMEOUT_MS);

    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

    if (!http.begin(client, cfg.serverUrl)) {
      Serial.println("[HTTP] 错误: begin 失败（URL格式可能有问题）");
      return;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-device-key", cfg.apiKey);

    Serial.printf("[HTTP] 发送数据: %s\n", body.c_str());
    code = http.POST(body);

    if (code > 0) {
      String response = http.getString();
      Serial.printf("[HTTP] 成功! HTTP %d\n", code);
      Serial.printf("[HTTP] 响应: %s\n", response.c_str());
    } else {
      Serial.printf("[HTTP] 失败! code=%d (%s)\n", code, http.errorToString(code).c_str());
    }
    http.end();

  } else {
    // ===== HTTP（明文，用于局域网本地服务器）=====
    Serial.println("[HTTP] 使用 HTTP 模式（局域网）");
    WiFiClient client;
    client.setTimeout(HTTP_TIMEOUT_MS);

    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

    if (!http.begin(client, cfg.serverUrl)) {
      Serial.println("[HTTP] 错误: begin 失败（URL格式可能有问题）");
      return;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-device-key", cfg.apiKey);

    Serial.printf("[HTTP] 发送数据: %s\n", body.c_str());
    code = http.POST(body);

    if (code > 0) {
      String response = http.getString();
      Serial.printf("[HTTP] 成功! HTTP %d\n", code);
      Serial.printf("[HTTP] 响应: %s\n", response.c_str());
    } else {
      Serial.printf("[HTTP] 失败! code=%d (%s)\n", code, http.errorToString(code).c_str());
      if (code == -1) Serial.println("[HTTP] 连接被拒绝——请确认电脑上 server.js 已启动，且 IP 地址正确");
      else if (code == -2) Serial.println("[HTTP] 请求超时");
      else if (code == -11) Serial.println("[HTTP] 读取超时");
      else Serial.println("[HTTP] 未知错误");
    }
    http.end();
  }

  Serial.println("[HTTP] --- 发送结束 ---");
}

// ============ 配置模式页面（原生 HTML 表单，不依赖 JavaScript）============
String buildConfigPage() {
  String h = "";
  h += "<!DOCTYPE html><html lang='zh-CN'><head>";
  h += "<meta charset='utf-8'>";
  h += "<meta name='viewport' content='width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no'>";
  h += "<title>触摸玩偶配置</title>";
  h += "<style>";
  h += "*{box-sizing:border-box;margin:0;padding:0}";
  h += "body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;";
  h += "background:#f0f2f5;color:#1a1a1a;padding:16px;max-width:480px;margin:0 auto;overflow-x:hidden}";
  h += "h2{font-size:20px;margin:16px 0 4px}";
  h += ".sub{font-size:13px;color:#888;margin-bottom:18px}";
  h += ".card{background:#fff;border-radius:12px;padding:20px 16px;box-shadow:0 1px 4px rgba(0,0,0,0.06)}";
  h += "label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}";
  h += "input{width:100%;padding:12px 14px;font-size:16px;border:1px solid #ddd;border-radius:8px;outline:none;-webkit-appearance:none}";
  h += "input:focus{border-color:#4f8cff}";
  h += "input.ro{background:#eef2f7;color:#555}";
  h += ".req{color:#e04040}";
  h += ".btn{width:100%;margin-top:22px;padding:14px;font-size:17px;color:#fff;background:#4f8cff;border:none;border-radius:10px}";
  h += ".btn:active{background:#3a78ee}";
  h += ".hint{font-size:12px;color:#aaa;margin-top:4px}";
  h += "</style></head><body>";

  h += "<h2>触摸玩偶配置</h2>";
  h += "<div class='sub'>只需填 Wi-Fi 名称和密码，服务器地址已自动填好，保存后自动重启。</div>";
  h += "<div class='card'>";

  // 原生 HTML 表单 POST，所有手机浏览器都支持，无需 JavaScript
  h += "<form method='POST' action='/save'>";

  h += "<label>Wi-Fi 名称 <span class='req'>*</span></label>";
  h += "<input name='ssid' type='text' placeholder='如 CMCC-nh6e' required>";

  h += "<label>Wi-Fi 密码 <span class='req'>*</span></label>";
  h += "<input name='pass' type='password' placeholder='Wi-Fi 密码' required>";

  h += "<label>服务器地址（已填好）</label>";
  h += "<input name='url' type='text' class='ro' readonly value='" + cfg.serverUrl + "'>";

  h += "<label>设备密钥（已填好）</label>";
  h += "<input name='key' type='text' class='ro' readonly value='" + cfg.apiKey + "'>";

  h += "<label>设备 ID（已填好）</label>";
  h += "<input name='devid' type='text' class='ro' readonly value='" + cfg.deviceId + "'>";

  h += "<div class='hint'>以上三项已自动填好，无需修改。</div>";
  h += "<button class='btn' type='submit'>保存并连接</button>";
  h += "</form>";

  h += "</div>";
  h += "</body></html>";
  return h;
}

// ============ 配置模式 HTTP 处理 ============
void handleRoot() {
  server.send(200, "text/html; charset=utf-8", buildConfigPage());
}

void handleSave() {
  if (!server.hasArg("ssid") || !server.hasArg("pass")) {
    String err = "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>";
    err += "<meta name='viewport' content='width=device-width,initial-scale=1.0'>";
    err += "<title>错误</title><style>body{font-family:sans-serif;text-align:center;padding:60px}";
    err += "h3{color:#c03030}</style></head><body>";
    err += "<h3>缺少 Wi-Fi 名称或密码</h3>";
    err += "<p>请返回上一页重新填写。</p>";
    err += "</body></html>";
    server.send(400, "text/html; charset=utf-8", err);
    return;
  }

  String ssid  = server.arg("ssid");
  String pass  = server.arg("pass");
  String url   = server.hasArg("url") ? server.arg("url") : DEFAULT_SERVER_URL;
  String key   = server.hasArg("key") ? server.arg("key") : DEFAULT_API_KEY;
  String devid = server.hasArg("devid") ? server.arg("devid") : DEFAULT_DEVICE_ID;

  if (url.length() == 0)  url  = DEFAULT_SERVER_URL;
  if (key.length() == 0)  key  = DEFAULT_API_KEY;
  if (devid.length() == 0) devid = DEFAULT_DEVICE_ID;

  prefs.begin(PREFS_NAMESPACE, false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.putString("url", url);
  prefs.putString("key", key);
  prefs.putString("devid", devid);
  prefs.end();

  Serial.println("[CONFIG] 配置已保存:");
  Serial.printf("[CONFIG]   Wi-Fi: %s\n", ssid.c_str());
  Serial.printf("[CONFIG]   URL: %s\n", url.c_str());
  Serial.printf("[CONFIG]   Key: %s\n", key.c_str());
  Serial.printf("[CONFIG]   DeviceID: %s\n", devid.c_str());

  // 返回 HTML 页面（浏览器提交表单后会跳转到这个页面）
  String resp = "";
  resp += "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>";
  resp += "<meta name='viewport' content='width=device-width,initial-scale=1.0'>";
  resp += "<title>保存成功</title><style>";
  resp += "body{font-family:-apple-system,sans-serif;background:#f0f2f5;text-align:center;padding:60px 20px}";
  resp += ".card{background:#fff;border-radius:12px;padding:30px;max-width:360px;margin:0 auto;box-shadow:0 1px 4px rgba(0,0,0,0.1)}";
  resp += "h2{color:#1a7a3a;font-size:22px;margin-bottom:12px}";
  resp += "p{color:#666;font-size:15px;line-height:1.6;margin-top:8px}";
  resp += "</style></head><body>";
  resp += "<div class='card'>";
  resp += "<h2>✓ 配置已保存</h2>";
  resp += "<p>设备正在重启…</p>";
  resp += "<p>请等待约 10 秒。</p>";
  resp += "<p>设备会自动连接 Wi-Fi，手机热点将断开。</p>";
  resp += "</div></body></html>";

  server.send(200, "text/html; charset=utf-8", resp);

  // 等待响应发完再重启
  delay(1500);
  ESP.restart();
}

void handleNotFound() {
  server.sendHeader("Location", "http://192.168.4.1/", true);
  server.send(302, "text/plain", "");
}

void startConfigMode() {
  configMode = true;
  Serial.println("[MODE] 进入配置模式");

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  delay(100);
  Serial.print("[AP] 热点: ");
  Serial.print(AP_SSID);
  Serial.print("  IP: ");
  Serial.println(WiFi.softAPIP());

  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());

  server.on("/", HTTP_GET, handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("[AP] 手机连接热点后访问 http://192.168.4.1");
}

// ============ Wi-Fi 连接 ============
void connectWiFi() {
  Serial.printf("[WIFI] 正在连接 %s\n", cfg.wifiSSID.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(cfg.wifiSSID.c_str(), cfg.wifiPass.c_str());
  wifiConnectStart = millis();
  wifiConnected = false;
}

// ============ BOOT 按键检测 ============
void checkBootButton() {
  bool pressed = (digitalRead(BOOT_BTN_PIN) == LOW);

  if (pressed && !btnWasPressed) {
    btnPressStart = millis();
    btnWasPressed = true;
  }

  if (pressed && btnWasPressed) {
    if (millis() - btnPressStart >= LONG_PRESS_MS) {
      Serial.println("[BTN] 长按 BOOT 5 秒，清除配置并重启");
      clearConfig();
      delay(200);
      ESP.restart();
    }
  }

  if (!pressed) {
    btnWasPressed = false;
  }
}

// ============ setup / loop ============
void setup() {
  Serial.begin(115200);
  delay(300);

  analogReadResolution(12);

  pinMode(BOOT_BTN_PIN, INPUT_PULLUP);
  pinMode(SENSOR1_PIN, INPUT);
  pinMode(SENSOR2_PIN, INPUT);

  Serial.println();
  Serial.println("========================================");
  Serial.println("  touch-doll  ESP32-S3 触摸玩偶固件 v2");
  Serial.println("========================================");

  loadConfig();

  Serial.println("[BOOT] 当前配置:");
  Serial.printf("[BOOT]   Wi-Fi: %s\n", cfg.wifiSSID.length() > 0 ? cfg.wifiSSID.c_str() : "(空)");
  Serial.printf("[BOOT]   URL: %s\n", cfg.serverUrl.c_str());
  Serial.printf("[BOOT]   Key: %s\n", cfg.apiKey.c_str());
  Serial.printf("[BOOT]   DeviceID: %s\n", cfg.deviceId.c_str());

  if (hasValidConfig()) {
    Serial.println("[BOOT] 已有 Wi-Fi 配置，开始连接");
    connectWiFi();
  } else {
    Serial.println("[BOOT] 无 Wi-Fi 配置，进入配置模式");
    startConfigMode();
  }
}

void loop() {
  if (configMode) {
    dnsServer.processNextRequest();
    server.handleClient();
    checkBootButton();
    return;
  }

  checkBootButton();

  // Wi-Fi 连接状态管理
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) {
      wifiConnected = true;
      Serial.printf("[WIFI] 已连接 %s，IP: %s，DNS: %s\n",
                    WiFi.SSID().c_str(),
                    WiFi.localIP().toString().c_str(),
                    WiFi.dnsIP().toString().c_str());
    }
  } else {
    if (wifiConnected) {
      wifiConnected = false;
      Serial.println("[WIFI] 连接断开，尝试重连…");
    }

    if (millis() - wifiConnectStart > WIFI_TIMEOUT_MS) {
      Serial.println("[WIFI] 连接超时 60s，进入配置模式");
      startConfigMode();
      return;
    }

    if (millis() - lastReconnect > RECONNECT_MS) {
      lastReconnect = millis();
      WiFi.reconnect();
    }
  }

  // 读取传感器
  int sensor1 = readAveraged(SENSOR1_PIN);
  int sensor2 = readAveraged(SENSOR2_PIN);
  bool touch1 = sensor1 > TOUCH_THRESHOLD;
  bool touch2 = sensor2 > TOUCH_THRESHOLD;

  Serial.printf("[SENSOR] s1=%4d s2=%4d t1=%s t2=%s wifi=%s\n",
                sensor1, sensor2,
                touch1 ? "Y" : "n",
                touch2 ? "Y" : "n",
                wifiConnected ? "ON" : "OFF");

  // 上报决策
  bool stateChanged = (touch1 != lastTouch1) || (touch2 != lastTouch2);
  bool touching = touch1 || touch2;
  unsigned long now = millis();
  bool shouldSend = false;

  if (stateChanged && (now - lastSendTime >= STATE_CHANGE_GUARD_MS || lastSendTime == 0)) {
    shouldSend = true;
    Serial.println("[SEND] 触发：状态变化");
  } else if (touching && (now - lastSendTime >= SEND_TOUCH_MS || lastSendTime == 0)) {
    shouldSend = true;
  } else if (!touching && (now - lastHeartbeat >= HEARTBEAT_MS || lastHeartbeat == 0)) {
    shouldSend = true;
    lastHeartbeat = now;
    Serial.println("[SEND] 触发：心跳");
  }

  if (shouldSend && wifiConnected) {
    sendData(sensor1, sensor2, touch1, touch2);
    lastSendTime = millis();
  } else if (shouldSend && !wifiConnected) {
    Serial.println("[SEND] Wi-Fi 未连接，跳过");
    lastSendTime = millis();
  }

  lastTouch1 = touch1;
  lastTouch2 = touch2;

  delay(50);
}
