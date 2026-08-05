/*
 * touch-doll.ino
 * ESP32-S3 双压力传感器固件
 *
 * 功能：
 * - 读取 GPIO4 / GPIO5 两路模拟传感器（0~4095），10 次平均去抖
 * - 触摸状态变化立即上报；触摸中每 500ms 上报；无触摸每 10s 心跳
 * - 首次启动或无配置时开启热点 TouchDoll-Setup，手机配置 Wi-Fi/服务器/密钥
 * - 配置存入 NVS (Preferences)，断电不丢失
 * - 长按 BOOT(GPIO0) 5 秒清除配置并重启进入配置模式
 * - Wi-Fi 连接失败 60s 进入配置模式；运行中断网自动重连
 * - 所有凭据均通过手机配置，不写死在代码中
 *
 * 硬件：ESP32-S3 Dev Module
 *   GPIO4 = 传感器1 (ADC1_CH3)
 *   GPIO5 = 传感器2 (ADC1_CH4)
 *   GPIO0 = 板载 BOOT 按键（按下为低电平）
 *
 * 仅依赖 ESP32 Arduino 自带库，无需第三方库。
 */

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <HTTPClient.h>

// ============ 引脚与常量 ============
#define SENSOR1_PIN      4    // 传感器1
#define SENSOR2_PIN      5    // 传感器2
#define BOOT_BTN_PIN     0    // 板载 BOOT 键 (GPIO0, 低电平有效)

#define TOUCH_THRESHOLD  150  // 触摸判定阈值
#define SAMPLE_COUNT     10   // 每次读取平均次数

#define LONG_PRESS_MS    5000 // 长按 BOOT 清除配置的时长
#define WIFI_TIMEOUT_MS 60000 // 连接 Wi-Fi 超时，超时进入配置模式
#define RECONNECT_MS     5000 // 断网重连间隔

#define SEND_TOUCH_MS    500  // 触摸中最大上报频率
#define HEARTBEAT_MS     10000 // 无触摸心跳间隔
#define STATE_CHANGE_GUARD_MS 100 // 状态变化最小上报间隔(防抖刷屏)
#define HTTP_TIMEOUT_MS  3000 // HTTP 超时，防止卡死

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

bool configMode = false;            // 是否处于配置模式
unsigned long wifiConnectStart = 0; // 连接开始时间
unsigned long lastReconnect = 0;    // 上次重连尝试
bool wifiConnected = false;

// 上报状态
unsigned long lastSendTime = 0;
unsigned long lastHeartbeat = 0;
bool lastTouch1 = false;
bool lastTouch2 = false;

// 按键状态
unsigned long btnPressStart = 0;
bool btnWasPressed = false;

// ============ NVS 配置读写 ============
#define PREFS_NAMESPACE "touchdoll"

void loadConfig() {
  prefs.begin(PREFS_NAMESPACE, true);
  cfg.wifiSSID   = prefs.getString("ssid", "");
  cfg.wifiPass   = prefs.getString("pass", "");
  cfg.serverUrl  = prefs.getString("url", "");
  cfg.apiKey     = prefs.getString("key", "");
  cfg.deviceId   = prefs.getString("devid", "doll-01");
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
  if (cfg.serverUrl.length() == 0) {
    Serial.println("[HTTP] 服务器地址为空，跳过上报");
    return;
  }
  if (cfg.apiKey.length() == 0) {
    Serial.println("[HTTP] 密钥为空，跳过上报");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure(); // 不校验证书（ESP32 资源有限，简化部署）
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);

  if (!http.begin(client, cfg.serverUrl)) {
    Serial.println("[HTTP] begin 失败");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", cfg.apiKey);

  String body = "{";
  body += "\"deviceId\":\"" + cfg.deviceId + "\",";
  body += "\"sensor1\":" + String(s1) + ",";
  body += "\"sensor2\":" + String(s2) + ",";
  body += "\"touch1\":" + String(t1 ? "true" : "false") + ",";
  body += "\"touch2\":" + String(t2 ? "true" : "false");
  body += "}";

  int code = http.POST(body);
  if (code > 0) {
    Serial.printf("[HTTP] POST 返回 %d\n", code);
  } else {
    Serial.printf("[HTTP] 请求失败 code=%d (%s)\n", code, http.errorToString(code).c_str());
  }
  http.end();
}

// ============ 配置模式页面 ============
String buildConfigPage() {
  String html = R"HTML(<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>触摸玩偶 - 设备配置</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f0f2f5; color: #1a1a1a;
    padding: 16px; max-width: 480px; margin: 0 auto;
    overflow-x: hidden;
  }
  h2 { font-size: 20px; margin: 16px 0 4px; }
  .sub { font-size: 13px; color: #888; margin-bottom: 18px; }
  .card {
    background: #fff; border-radius: 12px; padding: 20px 16px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }
  label { display: block; font-size: 14px; font-weight: 600; margin: 14px 0 6px; }
  input {
    width: 100%; padding: 12px 14px; font-size: 16px;
    border: 1px solid #ddd; border-radius: 8px; outline: none;
    -webkit-appearance: none;
  }
  input:focus { border-color: #4f8cff; }
  .req { color: #e04040; }
  .btn {
    width: 100%; margin-top: 22px; padding: 14px;
    font-size: 17px; color: #fff; background: #4f8cff;
    border: none; border-radius: 10px; cursor: pointer;
  }
  .btn:active { background: #3a78ee; }
  .hint { font-size: 12px; color: #aaa; margin-top: 4px; }
  #msg {
    margin-top: 16px; padding: 12px 14px; border-radius: 8px;
    font-size: 14px; display: none;
  }
  .ok { background: #e8f7ee; color: #1a7a3a; display: block !important; }
  .err { background: #fdeaea; color: #c03030; display: block !important; }
</style>
</head>
<body>
<h2>触摸玩偶配置</h2>
<div class="sub">请填写以下信息，保存后设备将自动重启并连接 Wi-Fi。</div>
<div class="card">
  <form id="f" onsubmit="return submitForm()">
    <label>Wi-Fi 名称 <span class="req">*</span></label>
    <input id="ssid" type="text" placeholder="如 CMCC-xxx" autocomplete="off">
    <label>Wi-Fi 密码 <span class="req">*</span></label>
    <input id="pass" type="password" placeholder="Wi-Fi 密码">
    <label>服务器接口地址 <span class="req">*</span></label>
    <input id="url" type="text" placeholder="https://xxx.vercel.app/api/touch" autocomplete="off">
    <label>DEVICE_API_KEY <span class="req">*</span></label>
    <input id="key" type="text" placeholder="设备密钥" autocomplete="off">
    <label>设备 ID</label>
    <input id="devid" type="text" placeholder="doll-01" value="doll-01" autocomplete="off">
    <div class="hint">用于区分不同设备，默认 doll-01。</div>
    <button class="btn" type="submit">保存并连接</button>
  </form>
  <div id="msg"></div>
</div>
<script>
var submitForm=()=>{
  var ssid=document.getElementById('ssid').value.trim();
  var pass=document.getElementById('pass').value;
  var url=document.getElementById('url').value.trim();
  var key=document.getElementById('key').value.trim();
  var devid=document.getElementById('devid').value.trim()||'doll-01';
  var msg=document.getElementById('msg');
  msg.className='';
  if(!ssid||!pass||!url||!key){
    msg.className='err';
    msg.innerText='请填写所有带 * 的必填项。';
    return false;
  }
  if(url.indexOf('http://')!==0 && url.indexOf('https://')!==0){
    msg.className='err';
    msg.innerText='服务器地址必须以 http:// 或 https:// 开头。';
    return false;
  }
  msg.className='ok';
  msg.innerText='正在保存，设备即将重启…';
  var p='ssid='+encodeURIComponent(ssid)+'&pass='+encodeURIComponent(pass)
    +'&url='+encodeURIComponent(url)+'&key='+encodeURIComponent(key)
    +'&devid='+encodeURIComponent(devid);
  var x=new XMLHttpRequest();
  x.open('POST','/save',false);
  x.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
  try{ x.send(p); }catch(e){}
  return false;
};
</script>
</body>
</html>)HTML";
  return html;
}

// ============ 配置模式 HTTP 处理 ============
void handleRoot() {
  server.send(200, "text/html; charset=utf-8", buildConfigPage());
}

void handleSave() {
  if (!server.hasArg("ssid") || !server.hasArg("pass") ||
      !server.hasArg("url") || !server.hasArg("key")) {
    server.send(400, "text/plain; charset=utf-8", "缺少必填字段");
    return;
  }

  String ssid  = server.arg("ssid");
  String pass  = server.arg("pass");
  String url   = server.arg("url");
  String key   = server.arg("key");
  String devid = server.hasArg("devid") ? server.arg("devid") : "doll-01";
  if (devid.length() == 0) devid = "doll-01";

  prefs.begin(PREFS_NAMESPACE, false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.putString("url", url);
  prefs.putString("key", key);
  prefs.putString("devid", devid);
  prefs.end();

  Serial.println("[CONFIG] 配置已保存，即将重启");
  server.send(200, "text/plain; charset=utf-8", "OK");

  delay(500); // 等响应发出
  ESP.restart();
}

void handleNotFound() {
  // 捕获门户：所有请求重定向到首页
  server.sendHeader("Location", "http://192.168.4.1/", true);
  server.send(302, "text/plain", "");
}

void startConfigMode() {
  configMode = true;
  Serial.println("[MODE] 进入配置模式");

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  delay(100);
  Serial.print("[AP] 热点已开启: ");
  Serial.print(AP_SSID);
  Serial.print("  IP: ");
  Serial.println(WiFi.softAPIP());

  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());

  server.on("/", HTTP_GET, handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("[AP] 手机连接热点后访问 http://192.168.4.1 进行配置");
}

// ============ Wi-Fi 连接 ============
void connectWiFi() {
  Serial.printf("[WIFI] 正在连接 %s\n", cfg.wifiSSID.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true); // 断网后自动重连
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

  analogReadResolution(12); // 0~4095

  pinMode(BOOT_BTN_PIN, INPUT_PULLUP);
  pinMode(SENSOR1_PIN, INPUT);
  pinMode(SENSOR2_PIN, INPUT);

  Serial.println();
  Serial.println("========================================");
  Serial.println("  touch-doll  ESP32-S3 触摸玩偶固件");
  Serial.println("========================================");

  loadConfig();

  if (hasValidConfig()) {
    Serial.println("[BOOT] 已有配置，开始连接 Wi-Fi");
    connectWiFi();
  } else {
    Serial.println("[BOOT] 无有效配置，进入配置模式");
    startConfigMode();
  }
}

void loop() {
  // 配置模式：处理 DNS + Web，不读传感器
  if (configMode) {
    dnsServer.processNextRequest();
    server.handleClient();
    checkBootButton();
    return;
  }

  // ---- 正常模式 ----
  checkBootButton();

  // Wi-Fi 连接状态管理
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) {
      wifiConnected = true;
      Serial.printf("[WIFI] 已连接 %s，IP: %s\n",
                    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
    }
  } else {
    if (wifiConnected) {
      wifiConnected = false;
      Serial.println("[WIFI] 连接断开，尝试重连…");
    }

    // 连接超时检测
    if (millis() - wifiConnectStart > WIFI_TIMEOUT_MS) {
      Serial.println("[WIFI] 连接超时 60s，进入配置模式");
      startConfigMode();
      return;
    }

    // 定期显式重连（双重保障，配合 setAutoReconnect）
    if (millis() - lastReconnect > RECONNECT_MS) {
      lastReconnect = millis();
      WiFi.reconnect();
      Serial.println("[WIFI] 尝试重连…");
    }
  }

  // ---- 读取传感器 ----
  int sensor1 = readAveraged(SENSOR1_PIN);
  int sensor2 = readAveraged(SENSOR2_PIN);
  bool touch1 = sensor1 > TOUCH_THRESHOLD;
  bool touch2 = sensor2 > TOUCH_THRESHOLD;

  // 串口打印
  Serial.printf("[SENSOR] s1=%4d s2=%4d t1=%s t2=%s wifi=%s\n",
                sensor1, sensor2,
                touch1 ? "Y" : "n",
                touch2 ? "Y" : "n",
                wifiConnected ? "ON" : "OFF");

  // ---- 上报决策 ----
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
    Serial.println("[SEND] Wi-Fi 未连接，跳过上报（数据不丢失，下次重试）");
    lastSendTime = millis(); // 重置计时避免连发
  }

  lastTouch1 = touch1;
  lastTouch2 = touch2;

  // 非阻塞延时，控制采样频率约 ~50ms/轮
  delay(50);
}
