/*
 * REFERENCE: Working ET-Bus sensor with encryption
 * Kate: COPY THIS PATTERN for all ET-Bus projects
 * Do NOT use MQTT/PubSubClient with ET-Bus
 * Do NOT use etbus.newData() — use StaticJsonDocument
 * ETBus etbus; MUST be declared global
 * HTU21D class: begin() returns void, not bool
 */

#include <WiFi.h>
#include <ArduinoJson.h>
#include <ETBusWiFiManager.h>
#include <ETBus.h>

ETBusWiFiManager wm;
ETBus etbus;

String devName;
String psk;

#define RESET_PIN 0

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("\n=== ET-Bus Sensor ===");

    pinMode(RESET_PIN, INPUT_PULLUP);
    if (digitalRead(RESET_PIN) == LOW) {
        Serial.println("[BOOT] Reset held — clearing settings");
        wm.resetSettings();
    }

    wm.begin("ETBus-Sensor");

    Serial.printf("[WIFI] Connected to: %s\n", wm.getSSID().c_str());
    Serial.printf("[WIFI] IP: %s\n", WiFi.localIP().toString().c_str());
    WiFi.setSleep(false);

    devName = wm.getDevName();
    if (devName.length() == 0) devName = "sensor1";

    psk = wm.getPSK();

    etbus.begin(devName.c_str(), "sensor.temp_hum", "Temp Sensor", "v1.0");

    if (psk.length() == 64) {
        if (etbus.enableEncryptionHex(psk.c_str())) {
            Serial.println("[ETBUS] Encrypted (key from portal)");
        }
    } else {
        Serial.println("[ETBUS] No PSK — running unencrypted");
    }

    Serial.println("[BOOT] READY\n");
}

void loop() {
    etbus.loop();

    // WiFi keep-alive
    static unsigned long lastWifiCheck = 0;
    if (millis() - lastWifiCheck > 5000) {
        lastWifiCheck = millis();
        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("[WIFI] lost — rebooting");
            ESP.restart();
        }
    }

    // Send sensor data every 10s
    static unsigned long lastSend = 0;
    if (millis() - lastSend > 10000) {
        lastSend = millis();

        StaticJsonDocument<128> payload;
        payload["temp"] = 22.5;
        payload["humidity"] = 55.0;

        Serial.print("[ETBUS] sending: ");
        serializeJson(payload, Serial);
        Serial.println();

        etbus.sendState(payload.as<JsonObject>());
    }
}
