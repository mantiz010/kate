import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
const run = async (cmd: string, timeout = 60000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 5 });
    return (stdout || stderr || "(no output)").slice(0, 12000);
  } catch (err: any) { return `Error: ${err.stderr || err.message}`.slice(0, 5000); }
};

// Espressif MAC prefixes for ESP32/ESP8266 detection
const ESP_OUIS = ["24:0a:c4","a4:cf:12","30:ae:a4","24:6f:28","ac:67:b2","8c:aa:b5","e8:db:84","dc:54:75","b4:e6:2d","cc:50:e3","84:f3:eb","a8:03:2a","7c:9e:bd","94:b9:7e","d8:bf:c0","78:e3:6d","10:52:1c","b0:a7:32","34:86:5d","c8:2b:96","ec:94:cb","68:c6:3a","70:03:9f","fc:f5:c4","18:fe:34","60:01:94","2c:f4:32","80:7d:3a","c4:4f:33","d4:f9:8d"];

const network: Skill = {
  id: "builtin.network",
  name: "Network",
  description: "Scan networks, discover devices, find ESP32s, test ports, MQTT, DNS, bandwidth",
  version: "2.0.0",
  tools: [
    { name: "net_scan", description: "Scan local network for devices with hostnames and MAC vendors", parameters: [
      { name: "subnet", type: "string", description: "Subnet to scan e.g. 192.168.1.0/24 (default: auto-detect)", required: false },
    ]},
    { name: "net_find_esp", description: "Find all ESP32/ESP8266 devices on the network by Espressif MAC address", parameters: [
      { name: "subnet", type: "string", description: "Subnet to scan e.g. 192.168.1.0/24 (default: auto-detect)", required: false },
    ]},
    { name: "net_scan_services", description: "Scan for known homelab services: Home Assistant, Ollama, MQTT, Kate, Proxmox, Grafana", parameters: [
      { name: "subnet", type: "string", description: "Subnet to scan e.g. 192.168.1.0/24", required: false },
    ]},
    { name: "net_portscan", description: "Scan open ports on a specific host", parameters: [
      { name: "host", type: "string", description: "Target IP or hostname", required: true },
      { name: "ports", type: "string", description: "Ports to scan (default: common ports)", required: false },
    ]},
    { name: "net_mqtt_test", description: "Test MQTT broker connectivity and list active topics", parameters: [
      { name: "host", type: "string", description: "MQTT broker IP (default: 172.168.1.8)", required: false },
      { name: "port", type: "number", description: "MQTT port (default: 1883)", required: false },
      { name: "topic", type: "string", description: "Topic to subscribe to for 5s (default: #)", required: false },
    ]},
    { name: "net_ping", description: "Ping a host", parameters: [
      { name: "host", type: "string", description: "Host to ping", required: true },
      { name: "count", type: "number", description: "Number of pings (default: 4)", required: false },
    ]},
    { name: "net_traceroute", description: "Trace route to a host", parameters: [
      { name: "host", type: "string", description: "Target host", required: true },
    ]},
    { name: "net_dns", description: "DNS lookup", parameters: [
      { name: "domain", type: "string", description: "Domain to look up", required: true },
      { name: "type", type: "string", description: "Record type: A, AAAA, MX, TXT, CNAME (default: A)", required: false },
    ]},
    { name: "net_interfaces", description: "List network interfaces and IPs", parameters: [] },
    { name: "net_connections", description: "Show active network connections or listening ports", parameters: [
      { name: "filter", type: "string", description: "listen, established, or all (default: listen)", required: false },
    ]},
    { name: "net_bandwidth", description: "Measure bandwidth on a network interface", parameters: [
      { name: "interface", type: "string", description: "Interface name e.g. eth0, ens4f0", required: false },
      { name: "seconds", type: "number", description: "Duration to measure (default: 3)", required: false },
    ]},
    { name: "net_wake", description: "Send Wake-on-LAN magic packet", parameters: [
      { name: "mac", type: "string", description: "MAC address to wake", required: true },
      { name: "broadcast", type: "string", description: "Broadcast address (default: 255.255.255.255)", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {

      case "net_scan": {
        const subnet = (args.subnet as string) || "";
        const target = subnet || "$(ip route | grep 'src' | head -1 | awk '{print $1}' 2>/dev/null || echo '192.168.1.0/24')";
        // nmap with hostname resolution and MAC vendor (-sn = ping scan, no port scan)
        const out = await run(`sudo nmap -sn ${target} --oG - 2>/dev/null | grep "Host:" | awk '{print $2, $3}' | sort -t. -k4 -n`, 60000);
        if (out.includes("Error") || out.trim() === "") {
          // fallback to arp-scan
          return run(`sudo arp-scan ${subnet || "--localnet"} 2>/dev/null || ip neigh show`, 30000);
        }
        // Also get MAC/vendor with second nmap pass
        const rich = await run(`sudo nmap -sn ${target} 2>/dev/null | grep -E "report|MAC|latency" | head -80`, 60000);
        return rich || out;
      }

      case "net_find_esp": {
        const subnet = (args.subnet as string) || "";
        const results: string[] = ["=== ESP32/ESP8266 Device Scan ===\n"];
        // ARP scan is fastest for MAC lookup
        const arpOut = await run(`sudo arp-scan ${subnet || "--localnet"} 2>/dev/null`, 30000);
        const lines = arpOut.split("\n");
        const found: string[] = [];
        for (const line of lines) {
          const lower = line.toLowerCase();
          if (ESP_OUIS.some(oui => lower.includes(oui)) || lower.includes("espressif")) {
            found.push(line.trim());
          }
        }
        if (found.length === 0) {
          // Try nmap with MAC detection
          const nmapOut = await run(`sudo nmap -sn ${subnet || "192.168.1.0/24"} 2>/dev/null | grep -A1 -i "espressif"`, 60000);
          if (nmapOut.trim()) {
            results.push("Found via nmap:\n" + nmapOut);
          } else {
            results.push("No ESP32/ESP8266 devices found.\nMake sure devices are powered on and connected.\n");
            results.push("Raw ARP scan (check manually):\n" + arpOut.slice(0, 3000));
          }
        } else {
          results.push(`Found ${found.length} Espressif device(s):\n`);
          found.forEach(d => results.push("  📡 " + d));
        }
        return results.join("\n");
      }

      case "net_scan_services": {
        const subnet = (args.subnet as string) || "192.168.1.0/24";
        const results: string[] = [`=== Homelab Service Scan (${subnet}) ===\n`];
        // Scan for known homelab service ports
        const services: Record<string, string> = {
          "8123": "Home Assistant",
          "11434": "Ollama",
          "1883": "MQTT",
          "8883": "MQTT TLS",
          "3201": "Kate AI",
          "3006": "Kate Dashboard",
          "8006": "Proxmox",
          "3000": "Grafana",
          "9090": "Prometheus",
          "5000": "Flask/API",
          "80": "HTTP",
          "443": "HTTPS",
          "22": "SSH",
        };
        const ports = Object.keys(services).join(",");
        const out = await run(`sudo nmap -p ${ports} --open ${subnet} 2>/dev/null | grep -E "Nmap scan|open|report"`, 120000);
        results.push(out);
        results.push("\nPort legend:");
        Object.entries(services).forEach(([p, s]) => results.push(`  ${p} = ${s}`));
        return results.join("\n");
      }

      case "net_portscan": {
        const ports = (args.ports as string) || "22,80,443,3000,3201,5000,8000,8080,8123,8443,8883,1883,9090,11434";
        return run(`nmap -p ${ports} --open ${args.host} 2>/dev/null`, 120000);
      }

      case "net_mqtt_test": {
        const host = (args.host as string) || "172.168.1.8";
        const port = (args.port as number) || 1883;
        const topic = (args.topic as string) || "#";
        const results: string[] = [`=== MQTT Test: ${host}:${port} ===\n`];
        // Test connectivity
        const pingOut = await run(`timeout 3 bash -c "echo >/dev/tcp/${host}/${port}" 2>&1 && echo "BROKER REACHABLE" || echo "BROKER UNREACHABLE"`, 5000);
        results.push(pingOut.includes("REACHABLE") ? "✅ Broker is reachable" : "❌ Broker unreachable");
        // Subscribe briefly if mosquitto_sub available
        const subOut = await run(`which mosquitto_sub 2>/dev/null && timeout 5 mosquitto_sub -h ${host} -p ${port} -u mantiz010 -P DavidCross010 -t '${topic}' -v 2>/dev/null | head -20 || echo "mosquitto_sub not installed — run: sudo apt install mosquitto-clients"`, 10000);
        results.push("\nMessages (5s sample):\n" + subOut);
        return results.join("\n");
      }

      case "net_ping": {
        const n = (args.count as number) || 4;
        return run(`ping -c ${n} -W 2 ${args.host}`);
      }

      case "net_traceroute": return run(`traceroute ${args.host} 2>/dev/null || tracepath ${args.host} 2>/dev/null`, 30000);

      case "net_dns": {
        const type = (args.type as string) || "A";
        return run(`dig ${args.domain} ${type} +short 2>/dev/null || nslookup ${args.domain}`);
      }

      case "net_interfaces": return run(`ip -br addr 2>/dev/null || ifconfig 2>/dev/null`);

      case "net_connections": {
        const filter = (args.filter as string) || "listen";
        switch (filter) {
          case "listen": return run("ss -tlnp 2>/dev/null | head -40");
          case "established": return run("ss -tnp state established 2>/dev/null | head -40");
          default: return run("ss -tnap 2>/dev/null | head -50");
        }
      }

      case "net_bandwidth": {
        const iface = (args.interface as string) || "";
        const sec = (args.seconds as number) || 3;
        if (iface) {
          return run(`(R1=$(cat /sys/class/net/${iface}/statistics/rx_bytes) && T1=$(cat /sys/class/net/${iface}/statistics/tx_bytes) && sleep ${sec} && R2=$(cat /sys/class/net/${iface}/statistics/rx_bytes) && T2=$(cat /sys/class/net/${iface}/statistics/tx_bytes) && echo "Interface: ${iface}" && echo "RX: $(( (R2-R1)/${sec}/1024 )) KB/s" && echo "TX: $(( (T2-T1)/${sec}/1024 )) KB/s")`, (sec + 5) * 1000);
        }
        return run(`ip -s link show 2>/dev/null | head -40`);
      }

      case "net_wake": {
        const mac = (args.mac as string).replace(/[:-]/g, "");
        const broadcast = (args.broadcast as string) || "255.255.255.255";
        return run(`python3 -c "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);mac=bytes.fromhex('${mac}');s.sendto(b'\\xff'*6+mac*16,('${broadcast}',9));print('WOL sent to ${args.mac}')" 2>&1`);
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};
export default network;
