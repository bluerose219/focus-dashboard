// XIAO ESP32S3 Sense · 핸드폰 연동
// PC 대시보드와 USB로 연결되고, 핸드폰 핫스팟(Wi-Fi)에 접속해 핸드폰에 화면을 제공합니다.
//   PC → XIAO (USB, JSON 한 줄): {"t":"view",...} 지금 판단과 값 / {"t":"result","id":N,...} 핸드폰 명령 결과
//   XIAO → PC (USB, JSON 한 줄): {"t":"wifi",...} Wi-Fi 상태 / {"t":"cmd","id":N,"cmd":"LED 1"} 핸드폰에서 누른 명령
// 센서와 UNO는 PC 대시보드가 다루며, XIAO는 명령을 다시 보내지 않습니다.
// 보드: XIAO_ESP32S3 · USB CDC On Boot: Enabled(기본값)
#include <WiFi.h>
#include <WebServer.h>
#include "phone_page.h"
#if __has_include("secrets.h")
#include "secrets.h"   // 핫스팟 이름·비밀번호. secrets.example.h를 복사해 만듭니다.
#define HAS_SECRETS 1
#else
#define HAS_SECRETS 0
#define WIFI_SSID ""
#define WIFI_PASS ""
#endif

WebServer server(80);
String view, result, lineBuf;   // PC가 보낸 최신 화면 값과 명령 결과 (JSON 원문)
unsigned long viewAt = 0, lastWifiReport = 0;
uint16_t nextId = 1;

void jsonString(String &out, const char *s) {
  out += '"';
  for (; *s; s++) { if (*s == '"' || *s == '\\') out += '\\'; if ((uint8_t)*s >= 0x20) out += *s; }
  out += '"';
}
void reportWifi() {
  String out = "{\"t\":\"wifi\",\"status\":";
  if (!HAS_SECRETS || !strlen(WIFI_SSID)) out += "\"no_secrets\"";
  else out += WiFi.status() == WL_CONNECTED ? "\"connected\"" : "\"connecting\"";
  out += ",\"ssid\":"; jsonString(out, WIFI_SSID);
  out += ",\"ip\":"; jsonString(out, WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "");
  out += "}";
  Serial.println(out);
}
void handlePcLine(String line) {
  line.trim();
  if (!line.startsWith("{") || !line.endsWith("}") || line.length() > 1500) return; // 깨진 줄은 버립니다.
  if (line.startsWith("{\"t\":\"view\"")) { view = line; viewAt = millis(); }
  else if (line.startsWith("{\"t\":\"result\"")) result = line;
}
void pumpPc() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') { handlePcLine(lineBuf); lineBuf = ""; }
    else if (lineBuf.length() < 1600) lineBuf += c;
  }
}

void handleView() {
  String out = "{\"age_ms\":";
  out += viewAt ? String(millis() - viewAt) : String("null");
  out += ",\"view\":";   out += view.length() ? view : String("null");
  out += ",\"result\":"; out += result.length() ? result : String("null");
  out += "}";
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json; charset=utf-8", out);
}
void handleLed() {
  String on = server.arg("on");
  if (on != "0" && on != "1") { server.send(400, "application/json; charset=utf-8", "{\"ok\":false,\"text\":\"on은 0 또는 1이어야 합니다.\"}"); return; }
  if (!viewAt || millis() - viewAt > 4000) {
    server.send(503, "application/json; charset=utf-8", "{\"ok\":false,\"text\":\"PC 대시보드가 연결돼 있지 않아 보내지 않았습니다.\"}");
    return;
  }
  uint16_t id = nextId++;
  if (nextId == 0) nextId = 1;
  Serial.printf("{\"t\":\"cmd\",\"id\":%u,\"cmd\":\"LED %s\"}\n", id, on.c_str());
  server.send(200, "application/json; charset=utf-8", String("{\"ok\":true,\"id\":") + id + "}");
}

void setup() {
  Serial.begin(115200);
  if (HAS_SECRETS && strlen(WIFI_SSID)) {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true); // 핫스팟이 잠시 꺼졌다 켜져도 다시 접속합니다.
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
  server.on("/", HTTP_GET, [] { server.send(200, "text/html; charset=utf-8", PHONE_HTML); });
  server.on("/api/view", HTTP_GET, handleView);
  server.on("/api/led", HTTP_POST, handleLed);
  server.onNotFound([] { server.send(404, "text/plain; charset=utf-8", "없는 주소입니다."); });
  server.begin();
}

void loop() {
  pumpPc();
  server.handleClient();
  if (millis() - lastWifiReport >= 3000) { lastWifiReport = millis(); reportWifi(); }
}
