# Arduino Sketch Simulator — Build Spec for Kate

## What It Does
Parses Arduino .ino files and simulates what they'd do WITHOUT real hardware.
Shows: Serial output, GPIO states, sensor readings, MQTT/ETBus messages.

## Implementation: Python script ~/kate/scripts/sketch_sim.py

### Fake Libraries (classes that return test data):
- Serial: print/println → collect output
- HTU21D: readTemperature() → 22.5, readHumidity() → 55.0
- BME280: readTempC() → 21.3, readFloatHumidity() → 48.0, readFloatPressure() → 101325
- WiFi: begin() → prints "WiFi connected", status() → WL_CONNECTED
- PubSubClient: publish(topic, payload) → logs "MQTT: topic = payload"
- ETBus: begin/loop/sendState → logs "ETBUS: payload"
- pinMode/digitalWrite/digitalRead/analogRead → tracks pin states
- millis() → increments each loop
- delay() → adds to millis counter
- ESP.deepSleep() → prints "DEEP SLEEP" and stops

### How It Works:
1. Read the .ino file
2. Extract: includes, globals, setup(), loop()
3. Run setup() logic line by line
4. Run loop() 5 times with incrementing millis()
5. Collect all Serial output, MQTT publishes, ETBus sends
6. Print a report

### Output Example:
```
=== Sketch Simulator: etbussensortest5 ===
[SETUP] Serial.begin(115200)
[SETUP] HTU21D.begin() → OK
[SETUP] WiFi.begin("mantiz010") → Connected (192.168.1.100)
[SETUP] ETBus.begin("sensor1", "sensor.temp_hum", "Sensor", "v1.0")
[LOOP 1] millis=10000
  ETBus.sendState({"temp": 22.5, "humidity": 55.0})
  Serial: "[ETBUS] sending: {"temp":22.5,"humidity":55.0}"
[LOOP 2] millis=20000
  ETBus.sendState({"temp": 22.5, "humidity": 55.0})
=== Done: 2 ETBus sends, 0 MQTT publishes, 0 errors ===
```

### Keep It Simple:
- Don't parse C++ properly — use regex to find function calls
- Don't execute real code — simulate the behavior
- Focus on: Serial, sensors, MQTT, ETBus, GPIO, deep sleep
- Single Python file, no dependencies beyond stdlib
