#!/usr/bin/env python3
"""
Arduino Sketch Simulator for Kate
Simulates Arduino .ino files without real hardware
"""
import re
import sys
from typing import List, Dict, Any

class FakeSerial:
    def __init__(self):
        self.output = []
    
    def begin(self, baud):
        self.output.append(f"[SETUP] Serial.begin({baud})")
    
    def println(self, msg):
        self.output.append(f"Serial: {msg}")
    
    def print(self, msg):
        self.output.append(f"Serial: {msg}")

class FakeHTU21D:
    def __init__(self):
        self.output = []
    
    def begin(self):
        self.output.append("[SETUP] HTU21D.begin() → OK")
    
    def readTemperature(self):
        return 22.5
    
    def readHumidity(self):
        return 55.0

class FakeBME280:
    def __init__(self):
        self.output = []
    
    def readTempC(self):
        return 21.3
    
    def readFloatHumidity(self):
        return 48.0
    
    def readFloatPressure(self):
        return 101325

class FakeWiFi:
    def __init__(self):
        self.output = []
        self.status_value = 3  # WL_CONNECTED
    
    def begin(self, ssid):
        self.output.append(f'[SETUP] WiFi.begin("{ssid}") → Connected (192.168.1.100)')
    
    def status(self):
        return self.status_value

class FakePubSubClient:
    def __init__(self):
        self.output = []
    
    def publish(self, topic, payload):
        self.output.append(f"MQTT: topic = {payload}")

class FakeETBus:
    def __init__(self):
        self.output = []
        self.name = ""
        self.type = ""
        self.description = ""
        self.version = ""
    
    def begin(self, name, sensor_type, description, version):
        self.name = name
        self.type = sensor_type
        self.description = description
        self.version = version
        self.output.append(f'[SETUP] ETBus.begin("{name}", "{sensor_type}", "{description}", "{version}")')
    
    def loop(self):
        pass
    
    def sendState(self, payload):
        self.output.append(f"ETBUS: {payload}")

class FakeGPIO:
    def __init__(self):
        self.pins = {}
    
    def pinMode(self, pin, mode):
        self.pins[pin] = mode
    
    def digitalWrite(self, pin, value):
        self.pins[pin] = value
    
    def digitalRead(self, pin):
        return self.pins.get(pin, 0)
    
    def analogRead(self, pin):
        return 512

class SketchSimulator:
    def __init__(self, sketch_file):
        self.sketch_file = sketch_file
        self.serial = FakeSerial()
        self.htu21d = FakeHTU21D()
        self.bme280 = FakeBME280()
        self.wifi = FakeWiFi()
        self.mqtt = FakePubSubClient()
        self.etbus = FakeETBus()
        self.gpio = FakeGPIO()
        self.millis_counter = 0
        self.loop_count = 0
        self.setup_lines = []
        self.loop_lines = []
        self.includes = []
        self.global_vars = []
        self.output = []
        self.errors = []
    
    def parse_sketch(self):
        try:
            with open(self.sketch_file, 'r') as f:
                content = f.read()
        except Exception as e:
            self.errors.append(f"Error reading sketch file: {e}")
            return False
        
        # Extract includes
        includes = re.findall(r'#include\s*[<"]([^>"]+)[>"]', content)
        self.includes = includes
        
        # Extract setup and loop functions
        setup_match = re.search(r'void setup\(\)\s*{([^}]*(?:}(?:\s*{[^}]*)?)*?)\s*}', content, re.DOTALL)
        loop_match = re.search(r'void loop\(\)\s*{([^}]*(?:}(?:\s*{[^}]*)?)*?)\s*}', content, re.DOTALL)
        
        if setup_match:
            setup_content = setup_match.group(1)
            self.setup_lines = [line.strip() for line in setup_content.split('\n') if line.strip()]
        
        if loop_match:
            loop_content = loop_match.group(1)
            self.loop_lines = [line.strip() for line in loop_content.split('\n') if line.strip()]
        
        return True
    
    def simulate_setup(self):
        self.output.append(f"=== Sketch Simulator: {self.sketch_file} ===")
        for line in self.setup_lines:
            self.execute_line(line, is_setup=True)
    
    def simulate_loop(self, iterations=5):
        for i in range(iterations):
            self.loop_count = i + 1
            self.output.append(f"[LOOP {self.loop_count}] millis={self.millis_counter}")
            for line in self.loop_lines:
                self.execute_line(line, is_setup=False)
            self.millis_counter += 5000  # Increment by 5 seconds (as in delay(5000))
    
    def execute_line(self, line, is_setup=False):
        # Handle Serial.println
        serial_print_match = re.search(r'serial\.println\((.*)\)', line, re.IGNORECASE)
        if serial_print_match:
            msg = serial_print_match.group(1)
            # Remove quotes if present
            if msg.startswith('"') and msg.endswith('"'):
                msg = msg[1:-1]
            self.serial.println(msg)
            return
        
        # Handle Serial.print
        serial_print_match = re.search(r'serial\.print\((.*)\)', line, re.IGNORECASE)
        if serial_print_match:
            msg = serial_print_match.group(1)
            # Remove quotes if present
            if msg.startswith('"') and msg.endswith('"'):
                msg = msg[1:-1]
            self.serial.print(msg)
            return
        
        # Handle HTU21D sensor calls
        if 'htu21d.begin()' in line.lower():
            self.htu21d.begin()
            return
        
        if 'htu21d.readTemperature()' in line:
            temp = self.htu21d.readTemperature()
            self.output.append(f"  Temperature: {temp}°C")
            return
        
        if 'htu21d.readHumidity()' in line:
            humidity = self.htu21d.readHumidity()
            self.output.append(f"  Humidity: {humidity}%")
            return
        
        # Handle BME280 sensor calls
        if 'bme280.readTempC()' in line:
            temp = self.bme280.readTempC()
            self.output.append(f"  Temperature: {temp}°C")
            return
        
        if 'bme280.readFloatHumidity()' in line:
            humidity = self.bme280.readFloatHumidity()
            self.output.append(f"  Humidity: {humidity}%")
            return
        
        if 'bme280.readFloatPressure()' in line:
            pressure = self.bme280.readFloatPressure()
            self.output.append(f"  Pressure: {pressure} Pa")
            return
        
        # Handle WiFi calls
        if 'wifi.begin(' in line.lower():
            ssid_match = re.search(r'wifi\.begin\(["\']([^"\']+)["\']\)', line, re.IGNORECASE)
            if ssid_match:
                ssid = ssid_match.group(1)
                self.wifi.begin(ssid)
            return
        
        if 'wifi.status()' in line.lower():
            status = self.wifi.status()
            self.output.append(f"  WiFi Status: {status}")
            return
        
        # Handle ETBus calls
        if 'etbus.begin(' in line.lower():
            # Extract parameters from the function call
            begin_match = re.search(r'etbus\.begin\([^,]*,([^,]*),([^,]*),([^)]*)\)', line, re.IGNORECASE)
            if begin_match:
                name = begin_match.group(1).strip().strip('"\'')
                sensor_type = begin_match.group(2).strip().strip('"\'')
                description = begin_match.group(3).strip().strip('"\'')
                self.etbus.begin(name, sensor_type, description, "v1.0")
            return
        
        if 'etbus.loop()' in line.lower():
            self.etbus.loop()
            return
        
        # Handle etbus.sendState() - this is the key part we need to detect
        # Looking for the exact pattern: etbus.sendState(payload.as<JsonObject>())
        if 'etbus.sendState' in line and 'payload' in line and 'as<JsonObject>' in line:
            # Simulate sending sensor data
            temp = self.htu21d.readTemperature()
            humidity = self.htu21d.readHumidity()
            payload = f'{{"temp": {temp}, "humidity": {humidity}}}'
            self.etbus.sendState(payload)
            return
        
        # Handle GPIO calls
        if 'pinMode(' in line:
            pin_match = re.search(r'pinMode\((\d+),\s*(\w+)\)', line)
            if pin_match:
                pin = int(pin_match.group(1))
                mode = pin_match.group(2)
                self.gpio.pinMode(pin, mode)
                return
        
        if 'digitalWrite(' in line:
            write_match = re.search(r'digitalWrite\((\d+),\s*(\w+)\)', line)
            if write_match:
                pin = int(write_match.group(1))
                value = write_match.group(2)
                self.gpio.digitalWrite(pin, value)
                return
        
        if 'digitalRead(' in line:
            read_match = re.search(r'digitalRead\((\d+)\)', line)
            if read_match:
                pin = int(read_match.group(1))
                value = self.gpio.digitalRead(pin)
                self.output.append(f"  Digital Read Pin {pin}: {value}")
                return
        
        if 'analogRead(' in line:
            read_match = re.search(r'analogRead\((\d+)\)', line)
            if read_match:
                pin = int(read_match.group(1))
                value = self.gpio.analogRead(pin)
                self.output.append(f"  Analog Read Pin {pin}: {value}")
                return
        
        # Handle millis
        if 'millis()' in line:
            self.output.append(f"  millis(): {self.millis_counter}")
            return
        
        # Handle delay
        if 'delay(' in line:
            delay_match = re.search(r'delay\((\d+)\)', line)
            if delay_match:
                delay_time = int(delay_match.group(1))
                self.millis_counter += delay_time
                return
        
        # Handle deep sleep
        if 'deepSleep(' in line.lower():
            self.output.append("DEEP SLEEP")
            return
    
    def run(self):
        if not self.parse_sketch():
            return False
        
        self.simulate_setup()
        self.simulate_loop(5)
        
        # Print final report
        mqtt_count = len([line for line in self.mqtt.output if line.startswith("MQTT:")])
        etbus_count = len([line for line in self.etbus.output if line.startswith("ETBUS:")])
        error_count = len(self.errors)
        
        self.output.append(f"=== Done: {etbus_count} ETBus sends, {mqtt_count} MQTT publishes, {error_count} errors ===")
        return True
    
    def get_output(self):
        return self.output

def main():
    if len(sys.argv) != 2:
        print("Usage: python sketch_sim.py <sketch_file.ino>")
        sys.exit(1)
    
    sketch_file = sys.argv[1]
    simulator = SketchSimulator(sketch_file)
    
    if simulator.run():
        for line in simulator.get_output():
            print(line)
    else:
        print("Failed to run simulation")
        sys.exit(1)

if __name__ == "__main__":
    main()