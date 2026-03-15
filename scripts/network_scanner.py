#!/usr/bin/env python3
"""Kate Network Scanner — find all devices, ports, services on 172.168.1.0/24"""

import subprocess
import json
import socket
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

NETWORK = "172.168.1.0/24"

KNOWN_DEVICES = {
    "172.168.1.8": "Home Assistant",
    "172.168.1.72": "Kate VM (openclaw)",
    "172.168.1.162": "Ollama GPU Server",
    "172.168.1.204": "Proxmox Host",
}

COMMON_PORTS = [22, 80, 443, 1883, 3000, 3200, 3201, 5555, 8006, 8080, 8123, 8883, 9090, 11434]

def ping_host(ip):
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", "1", str(ip)],
            capture_output=True, timeout=3
        )
        return result.returncode == 0
    except:
        return False

def scan_ports(ip, ports):
    open_ports = []
    for port in ports:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(0.5)
            if sock.connect_ex((ip, port)) == 0:
                service = ""
                try:
                    service = socket.getservbyport(port)
                except:
                    services = {
                        22: "ssh", 80: "http", 443: "https", 1883: "mqtt",
                        3200: "aegis", 3201: "kate", 5555: "etbus",
                        8006: "proxmox", 8123: "homeassistant", 8883: "mqtts",
                        11434: "ollama", 9090: "prometheus",
                    }
                    service = services.get(port, "unknown")
                open_ports.append({"port": port, "service": service})
            sock.close()
        except:
            pass
    return open_ports

def get_hostname(ip):
    try:
        return socket.gethostbyaddr(ip)[0]
    except:
        return ""

def get_mac(ip):
    try:
        result = subprocess.run(["arp", "-n", ip], capture_output=True, text=True, timeout=3)
        for line in result.stdout.split("\n"):
            if ip in line:
                parts = line.split()
                for p in parts:
                    if ":" in p and len(p) == 17:
                        return p
    except:
        pass
    return ""

def scan_network(quick=False):
    print(f"Scanning {NETWORK}...\n")
    
    # Find alive hosts
    alive = []
    base = "172.168.1."
    
    with ThreadPoolExecutor(max_workers=50) as executor:
        futures = {executor.submit(ping_host, f"{base}{i}"): i for i in range(1, 255)}
        for future in as_completed(futures):
            i = futures[future]
            ip = f"{base}{i}"
            if future.result():
                alive.append(ip)
    
    alive.sort(key=lambda x: int(x.split(".")[-1]))
    print(f"Found {len(alive)} hosts alive\n")
    
    devices = []
    for ip in alive:
        hostname = get_hostname(ip)
        mac = get_mac(ip)
        known = KNOWN_DEVICES.get(ip, "")
        
        ports = []
        if not quick:
            ports = scan_ports(ip, COMMON_PORTS)
        
        device = {
            "ip": ip,
            "hostname": hostname,
            "mac": mac,
            "known": known,
            "ports": ports,
        }
        devices.append(device)
        
        # Print live
        name = known or hostname or "unknown"
        port_str = ", ".join([f"{p['port']}/{p['service']}" for p in ports]) if ports else ""
        print(f"  {ip:16s} {name:25s} {mac:18s} {port_str}")
    
    return devices

def scan_single(ip):
    print(f"Scanning {ip}...\n")
    hostname = get_hostname(ip)
    mac = get_mac(ip)
    known = KNOWN_DEVICES.get(ip, "")
    
    # Scan more ports for single host
    all_ports = list(range(1, 1024)) + COMMON_PORTS
    all_ports = sorted(set(all_ports))
    ports = scan_ports(ip, all_ports)
    
    name = known or hostname or "unknown"
    print(f"  Host: {ip} ({name})")
    print(f"  MAC:  {mac}")
    print(f"  Ports:")
    for p in ports:
        print(f"    {p['port']:5d}/{p['service']}")
    
    return {"ip": ip, "hostname": hostname, "mac": mac, "known": known, "ports": ports}

if __name__ == "__main__":
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if arg == "--quick":
            scan_network(quick=True)
        elif arg == "--json":
            devices = scan_network()
            print("\n" + json.dumps(devices, indent=2))
        elif arg.startswith("172."):
            scan_single(arg)
        else:
            print("Usage: network_scanner.py [--quick|--json|IP]")
    else:
        scan_network()
