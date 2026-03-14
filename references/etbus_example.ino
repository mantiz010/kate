// REFERENCE: Working ET-Bus sensor pattern
#include <WiFi.h>
#include <ArduinoJson.h>
#include "ETBus.h"

static const char* WIFI_SSID = "mantiz010";
static const char* WIFI_PASS = "DavidCross010";
static const char* PSK_HEX = "b6f0c3d7a12e4f9c8d77e0b35b9a6c1f4b2a3e19c0d4f8a1b7c2d9e3f4a5b6c7";

ETBus etbus;

void onCommand(const char* dev_class, JsonObject payload) {
  Serial.print("Command: ");
  serializeJson(payload, Serial);
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());

  etbus.begin("DEVICE_ID", "sensor.device_type", "Friendly Name", "1.0");
  etbus.enableEncryptionHex(PSK_HEX);
  etbus.onCommand(onCommand);
}

void loop() {
  etbus.loop();
  static unsigned long last = 0;
  if (millis() - last > 10000) {
    last = millis();
    StaticJsonDocument<256> doc;
    JsonObject payload = doc.to<JsonObject>();
    payload["temp"] = 22.5;
    payload["humidity"] = 55.0;
    etbus.sendState(payload);
  }
}
