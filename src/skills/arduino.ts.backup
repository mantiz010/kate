import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const ARDUINO_DIR = path.join(os.homedir(), "kate", "projects", "arduino");


function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Board configurations ───────────────────────────────────────
const BOARDS: Record<string, {
  "esp8266": { name: "ESP8266 D1 Mini", fqbn: "esp8266:esp8266:d1_mini", pins: { LED: "2", SDA: "4", SCL: "5", A0: "A0" } },
  "d1mini": { name: "ESP8266 D1 Mini", fqbn: "esp8266:esp8266:d1_mini", pins: { LED: "2", SDA: "4", SCL: "5", A0: "A0" } },
  "nodemcu": { name: "ESP8266 NodeMCU", fqbn: "esp8266:esp8266:nodemcuv2", pins: { LED: "2", SDA: "4", SCL: "5", A0: "A0" } },
  "esp32c3": { name: "ESP32-C3", fqbn: "esp32:esp32:esp32c3", pins: { SDA: "8", SCL: "9", LED: "8" } },
  "esp32c6": { name: "ESP32-C6", fqbn: "esp32:esp32:esp32c6", pins: { SDA: "6", SCL: "7", LED: "8" } },
  "esp32h2": { name: "ESP32-H2", fqbn: "esp32:esp32:esp32h2", pins: { SDA: "1", SCL: "0", LED: "8" } },
  "esp32s2": { name: "ESP32-S2 Mini", fqbn: "esp32:esp32:esp32s2", pins: { SDA: "8", SCL: "9", LED: "15" } },
  "atmega1284p": { name: "ATmega1284P", fqbn: "MightyCore:avr:1284", pins: { SDA: "17", SCL: "16", LED: "13" } },
  "samd21": { name: "SAMD21 (Zero)", fqbn: "arduino:samd:arduino_zero_native", pins: { SDA: "20", SCL: "21", LED: "13" } },
 fqbn: string; platform: string; name: string; pins: Record<string, number> }> = {
  "esp32": {
    fqbn: "esp32:esp32:esp32",
    platform: "esp32:esp32",
    name: "ESP32 DevKit V1",
    pins: {
      LED_BUILTIN: 2, SDA: 21, SCL: 22,
      MOSI: 23, MISO: 19, SCK: 18, SS: 5,
      DAC1: 25, DAC2: 26,
      A0: 36, A3: 39, A4: 32, A5: 33, A6: 34, A7: 35,
      TX: 1, RX: 3, TX2: 17, RX2: 16,
    },
  },
  "esp32-s3": {
    fqbn: "esp32:esp32:esp32s3",
    platform: "esp32:esp32",
    name: "ESP32-S3 DevKit",
    pins: {
      LED_BUILTIN: 48, SDA: 8, SCL: 9, MOSI: 11, MISO: 13, SCK: 12,
      USB_DN: 19, USB_DP: 20,
    },
  },
  "esp32-c3": {
    fqbn: "esp32:esp32:esp32c3",
    platform: "esp32:esp32",
    name: "ESP32-C3 DevKit",
    pins: { LED_BUILTIN: 8, SDA: 5, SCL: 6, MOSI: 7, MISO: 2, SCK: 4 },
  },
  "arduino-uno": {
    fqbn: "arduino:avr:uno",
    platform: "arduino:avr",
    name: "Arduino Uno",
    pins: {
      LED_BUILTIN: 13, SDA: 18, SCL: 19,
      MOSI: 11, MISO: 12, SCK: 13,
      A0: 14, A1: 15, A2: 16, A3: 17, A4: 18, A5: 19,
    },
  },
  "arduino-nano": {
    fqbn: "arduino:avr:nano",
    platform: "arduino:avr",
    name: "Arduino Nano",
    pins: { LED_BUILTIN: 13, SDA: 18, SCL: 19 },
  },
  "arduino-mega": {
    fqbn: "arduino:avr:mega:cpu=atmega2560",
    platform: "arduino:avr",
    name: "Arduino Mega 2560",
    pins: {
      LED_BUILTIN: 13, SDA: 20, SCL: 21,
      MOSI: 51, MISO: 50, SCK: 52,
    },
  },
};

// ── Code templates ─────────────────────────────────────────────
const CODE_TEMPLATES: Record<string, (board: string) => string> = {
  "blink": (board) => `
// Blink — Basic LED blink test
// Board: ${BOARDS[board]?.name || board}

#define LED_PIN ${BOARDS[board]?.pins.LED_BUILTIN ?? 2}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Blink started");
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  delay(1000);
  digitalWrite(LED_PIN, LOW);
  delay(1000);
}
`.trim(),

  "wifi-scan": () => `
// WiFi Scanner — Scan and list nearby WiFi networks
// Board: ESP32

#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  Serial.println("WiFi Scanner Ready");
}

void loop() {
  Serial.println("Scanning...");
  int n = WiFi.scanNetworks();

  if (n == 0) {
    Serial.println("No networks found");
  } else {
    Serial.printf("Found %d networks:\\n", n);
    for (int i = 0; i < n; i++) {
      Serial.printf("  %2d: %-32s  %ddBm  Ch:%d  %s\\n",
        i + 1,
        WiFi.SSID(i).c_str(),
        WiFi.RSSI(i),
        WiFi.channel(i),
        WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "Open" : "Encrypted"
      );
    }
  }

  delay(5000);
}
`.trim(),

  "wifi-webserver": () => `
// WiFi Web Server — Serve a simple control page over WiFi
// Board: ESP32

#include <WiFi.h>
#include <WebServer.h>

const char* WIFI_SSID = "YOUR_SSID";
const char* WIFI_PASS = "YOUR_PASSWORD";

WebServer server(80);
bool ledState = false;

#define LED_PIN 2

void handleRoot() {
  String html = "<!DOCTYPE html><html><head>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<style>body{font-family:sans-serif;text-align:center;padding:2em;}";
  html += "button{font-size:1.5em;padding:1em 2em;margin:0.5em;border:none;border-radius:8px;cursor:pointer;}";
  html += ".on{background:#4CAF50;color:white;}.off{background:#f44336;color:white;}</style></head>";
  html += "<body><h1>ESP32 Control</h1>";
  html += "<p>LED is: <strong>" + String(ledState ? "ON" : "OFF") + "</strong></p>";
  html += "<a href='/on'><button class='on'>Turn ON</button></a>";
  html += "<a href='/off'><button class='off'>Turn OFF</button></a>";
  html += "</body></html>";
  server.send(200, "text/html", html);
}

void handleOn() {
  ledState = true;
  digitalWrite(LED_PIN, HIGH);
  server.sendHeader("Location", "/");
  server.send(303);
}

void handleOff() {
  ledState = false;
  digitalWrite(LED_PIN, LOW);
  server.sendHeader("Location", "/");
  server.send(303);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\\nConnected! IP: %s\\n", WiFi.localIP().toString().c_str());

  server.on("/", handleRoot);
  server.on("/on", handleOn);
  server.on("/off", handleOff);
  server.begin();
  Serial.println("Web server started");
}

void loop() {
  server.handleClient();
}
`.trim(),

  "mqtt-sensor": () => `
// MQTT Sensor Publisher — Read sensor and publish via MQTT
// Board: ESP32
// Libraries needed: PubSubClient

#include <WiFi.h>
#include <PubSubClient.h>

const char* WIFI_SSID = "YOUR_SSID";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* MQTT_SERVER = "YOUR_MQTT_BROKER";
const int   MQTT_PORT = 1883;
const char* MQTT_TOPIC = "home/sensors/esp32";

WiFiClient espClient;
PubSubClient mqtt(espClient);

unsigned long lastPublish = 0;
const long PUBLISH_INTERVAL = 10000; // 10 seconds

void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\\nWiFi connected: %s\\n", WiFi.localIP().toString().c_str());
}

void connectMQTT() {
  while (!mqtt.connected()) {
    Serial.print("Connecting MQTT...");
    if (mqtt.connect("kate-esp32")) {
      Serial.println("connected!");
      mqtt.subscribe("home/commands/esp32");
    } else {
      Serial.printf("failed (rc=%d), retry in 5s\\n", mqtt.state());
      delay(5000);
    }
  }
}

void onMessage(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  Serial.printf("MQTT [%s]: %s\\n", topic, msg.c_str());

  if (msg == "led_on") digitalWrite(2, HIGH);
  else if (msg == "led_off") digitalWrite(2, LOW);
}

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  connectWiFi();
  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setCallback(onMessage);
}

void loop() {
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();

  if (millis() - lastPublish > PUBLISH_INTERVAL) {
    lastPublish = millis();

    // Read analog sensor (e.g. temperature via thermistor on GPIO36)
    int raw = analogRead(36);
    float voltage = raw * 3.3 / 4095.0;

    char payload[128];
    snprintf(payload, sizeof(payload),
      "{\\"sensor\\":\\"analog\\",\\"raw\\":%d,\\"voltage\\":%.2f,\\"uptime\\":%lu}",
      raw, voltage, millis() / 1000);

    mqtt.publish(MQTT_TOPIC, payload);
    Serial.printf("Published: %s\\n", payload);
  }
}
`.trim(),

  "i2c-scanner": () => `
// I2C Scanner — Detect all devices on the I2C bus
// Board: ESP32 / Arduino

#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Serial.println("I2C Scanner Ready");
  Serial.println("Scanning...");
}

void loop() {
  int devices = 0;

  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte error = Wire.endTransmission();

    if (error == 0) {
      Serial.printf("  Device found at 0x%02X", addr);
      devices++;

      // Identify common devices
      switch (addr) {
        case 0x3C: case 0x3D: Serial.print(" (OLED SSD1306)"); break;
        case 0x76: case 0x77: Serial.print(" (BME280/BMP280)"); break;
        case 0x68: Serial.print(" (MPU6050/DS3231)"); break;
        case 0x48: Serial.print(" (ADS1115/TMP102)"); break;
        case 0x27: case 0x3F: Serial.print(" (LCD I2C)"); break;
        case 0x50: Serial.print(" (EEPROM AT24C)"); break;
        case 0x29: Serial.print(" (VL53L0X ToF)"); break;
        case 0x40: Serial.print(" (INA219/HDC1080)"); break;
        case 0x1E: Serial.print(" (HMC5883L Compass)"); break;
        case 0x57: Serial.print(" (MAX30102 Pulse)"); break;
      }
      Serial.println();
    }
  }

  Serial.printf("\\nFound %d device(s)\\n\\n", devices);
  delay(5000);
}
`.trim(),

  "deep-sleep": () => `
// Deep Sleep — Ultra low power with timed wake-up
// Board: ESP32

#include <esp_sleep.h>

#define SLEEP_SECONDS 60
#define LED_PIN 2

RTC_DATA_ATTR int bootCount = 0;

void printWakeupReason() {
  esp_sleep_wakeup_cause_t reason = esp_sleep_get_wakeup_cause();
  switch (reason) {
    case ESP_SLEEP_WAKEUP_TIMER: Serial.println("Wake: timer"); break;
    case ESP_SLEEP_WAKEUP_EXT0:  Serial.println("Wake: external (RTC_IO)"); break;
    case ESP_SLEEP_WAKEUP_EXT1:  Serial.println("Wake: external (RTC_CNTL)"); break;
    case ESP_SLEEP_WAKEUP_TOUCHPAD: Serial.println("Wake: touch"); break;
    default: Serial.printf("Wake: other (%d)\\n", reason); break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(100);

  bootCount++;
  Serial.printf("\\n=== Boot #%d ===\\n", bootCount);
  printWakeupReason();

  // Do your work here
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);
  delay(200);
  digitalWrite(LED_PIN, LOW);

  Serial.printf("Going to sleep for %d seconds...\\n", SLEEP_SECONDS);
  esp_sleep_enable_timer_wakeup(SLEEP_SECONDS * 1000000ULL);
  esp_deep_sleep_start();
}

void loop() {
  // Never reached
}
`.trim(),

  "ble-beacon": () => `
// BLE Beacon — Advertise as a Bluetooth Low Energy beacon
// Board: ESP32

#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEBeacon.h>
#include <BLEAdvertising.h>

#define DEVICE_NAME "Kate-Beacon"
#define BEACON_UUID "8ec76ea3-6668-48da-9866-75be8bc86f4d"

BLEAdvertising* pAdvertising;

void setup() {
  Serial.begin(115200);
  Serial.println("Starting BLE Beacon...");

  BLEDevice::init(DEVICE_NAME);

  BLEBeacon beacon;
  beacon.setManufacturerId(0x4C00); // Apple iBeacon compatible
  beacon.setProximityUUID(BLEUUID(BEACON_UUID));
  beacon.setMajor(1);
  beacon.setMinor(1);
  beacon.setSignalPower(-59);

  BLEAdvertisementData advData;
  advData.setFlags(0x04); // BR_EDR_NOT_SUPPORTED
  std::string strServiceData;
  strServiceData += (char)26;   // length
  strServiceData += (char)0xFF; // type: manufacturer specific
  strServiceData += beacon.getData();
  advData.addData(strServiceData);

  pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->setAdvertisementData(advData);
  pAdvertising->start();

  Serial.println("BLE Beacon active!");
  Serial.printf("UUID: %s\\n", BEACON_UUID);
}

void loop() {
  delay(1000);
}
`.trim(),
};

const arduino: Skill = {
  id: "builtin.arduino",
  name: "Arduino & ESP32",
  description: "Generate, compile, and upload Arduino/ESP32 firmware. Includes templates for WiFi, MQTT, BLE, I2C, deep sleep, and more. Supports arduino-cli.",
  version: "1.0.0",
  tools: [
    {
      name: "arduino_new",
      description: "Create a new Arduino/ESP32 project with a template or blank sketch",
      parameters: [
        { name: "name", type: "string", description: "Project name", required: true },
        { name: "board", type: "string", description: "Board: esp32, esp32-s3, esp32-c3, arduino-uno, arduino-nano, arduino-mega", required: true },
        { name: "template", type: "string", description: "Template: blink, wifi-scan, wifi-webserver, mqtt-sensor, i2c-scanner, deep-sleep, ble-beacon, or blank", required: false },
      ],
    },
    {
      name: "arduino_write",
      description: "Write or overwrite the main .ino sketch file for a project",
      parameters: [
        { name: "project", type: "string", description: "Project name", required: true },
        { name: "code", type: "string", description: "The complete Arduino/C++ source code", required: true },
      ],
    },
    {
      name: "arduino_add_file",
      description: "Add an additional .h or .cpp file to the project (for multi-file projects)",
      parameters: [
        { name: "project", type: "string", description: "Project name", required: true },
        { name: "filename", type: "string", description: "File name (e.g. sensors.h, config.h)", required: true },
        { name: "content", type: "string", description: "File content", required: true },
      ],
    },
    {
      name: "arduino_compile",
      description: "Compile the project using arduino-cli. Returns errors if any.",
      parameters: [
        { name: "project", type: "string", description: "Project name", required: true },
        { name: "board", type: "string", description: "Override board (optional)", required: false },
      ],
    },
    {
      name: "arduino_upload",
      description: "Compile and upload firmware to a connected board via USB",
      parameters: [
        { name: "project", type: "string", description: "Project name", required: true },
        { name: "port", type: "string", description: "Serial port (e.g. /dev/ttyUSB0, /dev/cu.usbserial)", required: true },
        { name: "board", type: "string", description: "Override board (optional)", required: false },
      ],
    },
    {
      name: "arduino_serial",
      description: "Open serial monitor and read output from the board",
      parameters: [
        { name: "port", type: "string", description: "Serial port (e.g. /dev/ttyUSB0)", required: true },
        { name: "baud", type: "number", description: "Baud rate (default: 115200)", required: false },
        { name: "duration", type: "number", description: "How many seconds to read (default: 5)", required: false },
      ],
    },
    {
      name: "arduino_install_lib",
      description: "Install an Arduino library via arduino-cli",
      parameters: [
        { name: "library", type: "string", description: "Library name (e.g. 'PubSubClient', 'Adafruit BME280')", required: true },
      ],
    },
    {
      name: "arduino_list_boards",
      description: "List supported boards and their pin configurations",
      parameters: [],
    },
    {
      name: "arduino_list_templates",
      description: "List available code templates",
      parameters: [],
    },
    {
      name: "arduino_list_ports",
      description: "Detect connected boards (serial ports)",
      parameters: [],
    },
    {
      name: "arduino_read",
      description: "Read the current source code of a project",
      parameters: [
        { name: "project", type: "string", description: "Project name", required: true },
      ],
    },
    {
      name: "arduino_list_projects",
      description: "List all Arduino projects",
      parameters: [],
    },
    {
      name: "arduino_setup",
      description: "Install arduino-cli and required board cores (ESP32, AVR)",
      parameters: [
        { name: "boards", type: "string", description: "Comma-separated platforms to install: esp32, avr (default: esp32)", required: false },
      ],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    ensureDir(ARDUINO_DIR);

    switch (toolName) {
      case "arduino_new": {
        // ALWAYS search existing projects first
        const searchName = (args.name as string || "").toLowerCase().replace(/[_-]/g, " ");
        const searchWords = searchName.split(" ").filter((w: string) => w.length > 2);
        try {
          const existingDir = "/home/mantiz010/Arduino";
          const existing = fs.readdirSync(existingDir).filter((d: string) => {
            const dLow = d.toLowerCase();
            return searchWords.filter((w: string) => dLow.includes(w)).length >= 2;
          });
          if (existing.length > 0) {
            // Found matches — read the best one
            const best = existing[existing.length - 1]; // Latest version
            const inoFiles = fs.readdirSync(existingDir + "/" + best).filter((f: string) => f.endsWith(".ino"));
            if (inoFiles.length > 0) {
              const code = fs.readFileSync(existingDir + "/" + best + "/" + inoFiles[0], "utf-8");
              return "Found " + existing.length + " existing project(s) matching your request:\n\n" +
                "Best match: ~/Arduino/" + best + "\n" +
                "All matches: " + existing.slice(0, 5).join(", ") + "\n\n" +
                "```cpp\n" + (code.length > 3000 ? code.slice(0, 3000) + "\n// ... (" + code.length + " chars total)" : code) + "\n```\n\n" +
                "This is your existing code. I can improve it or create a new version.";
            }
          }
        } catch {}

        const name = args.name as string;
        const board = args.board as string;
        const template = (args.template as string) || "blank";
        const projDir = path.join(ARDUINO_DIR, name);

        ensureDir(projDir);

        let code: string;
        if (template !== "blank" && CODE_TEMPLATES[template]) {
          code = CODE_TEMPLATES[template](board);
        } else {
          code = `// ${name}\n// Board: ${BOARDS[board]?.name || board}\n\nvoid setup() {\n  Serial.begin(115200);\n  Serial.println("Hello from ${name}!");\n}\n\nvoid loop() {\n  \n}\n`;
        }

        fs.writeFileSync(path.join(projDir, `${name}.ino`), code);

        // Save project metadata
        fs.writeFileSync(path.join(projDir, "project.json"), JSON.stringify({
          name, board, template, createdAt: Date.now(),
          fqbn: BOARDS[board]?.fqbn || board,
        }, null, 2));

        return `Created project: ${name}\nBoard: ${BOARDS[board]?.name || board}\nTemplate: ${template}\nLocation: ${projDir}\n\nSource:\n${code}`;
      }

      case "arduino_write": {
        const project = args.project as string;
        const code = args.code as string;
        const projDir = path.join(ARDUINO_DIR, project);
        ensureDir(projDir);
        fs.writeFileSync(path.join(projDir, `${project}.ino`), code);
        return `Updated ${project}.ino (${code.length} chars)`;
      }

      case "arduino_add_file": {
        const project = args.project as string;
        const filename = args.filename as string;
        const content = args.content as string;
        const projDir = path.join(ARDUINO_DIR, project);
        ensureDir(projDir);
        fs.writeFileSync(path.join(projDir, filename), content);
        return `Added ${filename} to ${project} (${content.length} chars)`;
      }

      case "arduino_compile": {
        const project = args.project as string;
        const projDir = path.join(ARDUINO_DIR, project);
        const metaPath = path.join(projDir, "project.json");

        let fqbn = "esp32:esp32:esp32";
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          fqbn = BOARDS[args.board as string]?.fqbn || meta.fqbn || fqbn;
        }

        try {
          const { stdout, stderr } = await execAsync(
            `arduino-cli compile --fqbn ${fqbn} "${projDir}" 2>&1`,
            { timeout: 120000 },
          );
          const output = stdout || stderr;
          if (output.includes("error:")) {
            return `Compilation FAILED:\n${output.slice(0, 5000)}`;
          }
          return `Compilation successful!\n${output.slice(0, 3000)}`;
        } catch (err: any) {
          return `Compile error:\n${(err.stderr || err.stdout || err.message).slice(0, 5000)}`;
        }
      }

      case "arduino_upload": {
        const project = args.project as string;
        const port = args.port as string;
        const projDir = path.join(ARDUINO_DIR, project);
        const metaPath = path.join(projDir, "project.json");

        let fqbn = "esp32:esp32:esp32";
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          fqbn = BOARDS[args.board as string]?.fqbn || meta.fqbn || fqbn;
        }

        try {
          const { stdout, stderr } = await execAsync(
            `arduino-cli compile --fqbn ${fqbn} -u -p ${port} "${projDir}" 2>&1`,
            { timeout: 180000 },
          );
          return `Upload successful!\n${(stdout || stderr).slice(0, 3000)}`;
        } catch (err: any) {
          return `Upload failed:\n${(err.stderr || err.stdout || err.message).slice(0, 5000)}`;
        }
      }

      case "arduino_serial": {
        const port = args.port as string;
        const baud = (args.baud as number) || 115200;
        const duration = (args.duration as number) || 5;

        try {
          const { stdout } = await execAsync(
            `timeout ${duration} cat ${port}`,
            { timeout: (duration + 2) * 1000 },
          );
          return `Serial output (${duration}s at ${baud} baud):\n${stdout.slice(0, 5000)}`;
        } catch (err: any) {
          // timeout exits with code 124, which is normal
          if (err.stdout) return `Serial output:\n${err.stdout.slice(0, 5000)}`;
          return `Serial error: ${err.message}`;
        }
      }

      case "arduino_install_lib": {
        const library = (args.library as string).trim();
        const searchTerms = library.toLowerCase().replace(/[_\-\s]+/g, " ").split(" ").filter((w: string) => w.length > 2);
        
        // Search local libraries
        try {
          const { readdirSync, existsSync } = await import("node:fs");
          const libDir = "/home/mantiz010/Arduino/libraries";
          const localLibs = readdirSync(libDir).filter((d: string) => {
            const full = libDir + "/" + d;
            try { return existsSync(full) && readdirSync(full).length > 0; } catch { return false; }
          });
          
          // Score each local library against search terms
          const scored = localLibs.map((l: string) => {
            const lLow = l.toLowerCase().replace(/[_\-]/g, " ");
            let score = 0;
            for (const term of searchTerms) {
              if (lLow.includes(term)) score += 10;
            }
            // Exact match bonus
            if (lLow.replace(/\s/g, "") === library.toLowerCase().replace(/[_\-\s]/g, "")) score += 100;
            return { name: l, score };
          }).filter((s: any) => s.score > 0).sort((a: any, b: any) => b.score - a.score);
          
          if (scored.length > 0) {
            const best = scored[0];
            let info = "✓ Found locally: ~/Arduino/libraries/" + best.name + "\n";
            try {
              const files = readdirSync(libDir + "/" + best.name);
              const headers = files.filter((f: string) => f.endsWith(".h"));
              const src = files.filter((f: string) => f.endsWith(".cpp") || f.endsWith(".c"));
              if (headers.length > 0) info += "Headers: " + headers.join(", ") + "\n";
              if (headers.length > 0) info += "Include: #include <" + headers[0] + ">\n";
              info += "Files: " + files.length + " (" + headers.length + " .h, " + src.length + " .cpp)\n";
            } catch {}
            if (scored.length > 1) {
              info += "Also found: " + scored.slice(1, 4).map((s: any) => s.name).join(", ");
            }
            return info;
          }
        } catch {}
        
        // Not found locally — try arduino-cli
        try {
          const { stdout } = await execAsync("arduino-cli lib install \"" + library + "\"", { timeout: 60000 });
          return "Installed: " + library + "\n" + stdout;
        } catch (err: any) {
          // Try searching instead
          try {
            const { stdout } = await execAsync("arduino-cli lib search \"" + library + "\" 2>&1 | head -20", { timeout: 15000 });
            return "Library \"" + library + "\" not found by exact name. Search results:\n" + stdout;
          } catch {
            return "Library not found: " + library + ". Check ~/Arduino/libraries/ for local alternatives.";
          }
        }
      }
      case "arduino_list_boards": {
        return Object.entries(BOARDS).map(([key, b]) => {
          const pinList = Object.entries(b.pins).map(([name, pin]) => `${name}=${pin}`).join(", ");
          return `• ${key} — ${b.name}\n  FQBN: ${b.fqbn}\n  Pins: ${pinList}`;
        }).join("\n\n");
      }

      case "arduino_list_templates": {
        return Object.entries(CODE_TEMPLATES).map(([name, fn]) => {
          const first = fn("esp32").split("\n").find(l => l.startsWith("//"))?.slice(3) || name;
          return `• ${name} — ${first}`;
        }).join("\n");
      }

      case "arduino_list_ports": {
        try {
          const { stdout } = await execAsync("arduino-cli board list --format json", { timeout: 10000 });
          const data = JSON.parse(stdout);
          if (!data.detected_ports?.length) return "No boards detected. Check USB connections.";
          return data.detected_ports.map((p: any) => {
            const board = p.matching_boards?.[0];
            return `• ${p.port.address} — ${board?.name || "Unknown"} (${p.port.protocol})`;
          }).join("\n");
        } catch (err: any) {
          // Fallback: list serial devices
          try {
            const { stdout } = await execAsync("ls /dev/ttyUSB* /dev/ttyACM* /dev/cu.usb* 2>/dev/null || echo 'No serial devices found'");
            return `Serial ports:\n${stdout}`;
          } catch {
            return "Could not detect ports. Is arduino-cli installed?";
          }
        }
      }

      case "arduino_read": {
        const project = args.project as string;
        const inoPath = path.join(ARDUINO_DIR, project, `${project}.ino`);
        if (!fs.existsSync(inoPath)) return `Project not found: ${project}`;
        return fs.readFileSync(inoPath, "utf-8");
      }

      case "arduino_list_projects": {
        if (!fs.existsSync(ARDUINO_DIR)) return "No projects yet.";
        const dirs = fs.readdirSync(ARDUINO_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        if (dirs.length === 0) return "No projects yet.";
        return dirs.map(d => {
          const metaPath = path.join(ARDUINO_DIR, d.name, "project.json");
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            return `• ${d.name} — ${BOARDS[meta.board]?.name || meta.board} (${meta.template || "custom"})`;
          }
          return `• ${d.name}`;
        }).join("\n");
      }

      case "arduino_setup": {
        const boards = (args.boards as string || "esp32").split(",").map(s => s.trim());
        const results: string[] = [];

        // Check if arduino-cli exists
        try {
          const { stdout } = await execAsync("arduino-cli version");
          results.push(`arduino-cli: ${stdout.trim()}`);
        } catch {
          results.push("arduino-cli not found. Installing...");
          try {
            await execAsync("curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh", { timeout: 60000 });
            results.push("arduino-cli installed");
          } catch (err: any) {
            return `Failed to install arduino-cli: ${err.message}\nManual install: https://arduino.github.io/arduino-cli/installation/`;
          }
        }

        // Update index
        try {
          await execAsync("arduino-cli core update-index");
          results.push("Core index updated");
        } catch {}

        // Install board cores
        for (const board of boards) {
          if (board === "esp32") {
            try {
              await execAsync('arduino-cli config add board_manager.additional_urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json');
              await execAsync("arduino-cli core update-index");
              await execAsync("arduino-cli core install esp32:esp32", { timeout: 300000 });
              results.push("ESP32 core installed");
            } catch (err: any) {
              results.push(`ESP32 install failed: ${err.message}`);
            }
          } else if (board === "avr") {
            try {
              await execAsync("arduino-cli core install arduino:avr", { timeout: 120000 });
              results.push("Arduino AVR core installed");
            } catch (err: any) {
              results.push(`AVR install failed: ${err.message}`);
            }
          }
        }

        return results.join("\n");
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },
};

export default arduino;

