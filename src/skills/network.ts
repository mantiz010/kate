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

// MAC OUI → Vendor lookup (first 3 octets, lowercase)
const MAC_VENDORS: Record<string, string> = {
  // Apple
  "a4:83:e7":"Apple","3c:22:fb":"Apple","f0:18:98":"Apple","14:7d:da":"Apple","6c:96:cf":"Apple",
  "a8:66:7f":"Apple","dc:a9:04":"Apple","f4:5c:89":"Apple","78:7b:8a":"Apple","88:66:a5":"Apple",
  "ac:bc:32":"Apple","70:ef:00":"Apple","c8:69:cd":"Apple","a0:99:9b":"Apple","38:c9:86":"Apple",
  "28:cf:e9":"Apple","d0:03:4b":"Apple","0c:4d:e9":"Apple","b8:53:ac":"Apple","64:b0:a6":"Apple",
  // Samsung
  "50:01:bb":"Samsung","8c:f5:a3":"Samsung","cc:07:ab":"Samsung","78:47:1d":"Samsung",
  "94:e6:ba":"Samsung","40:ae:30":"Samsung","c8:7f:54":"Samsung","34:23:ba":"Samsung",
  "10:5b:ad":"Samsung","5c:84:3c":"Samsung","20:57:9e":"Samsung","28:87:ba":"Samsung",
  // Google/Nest
  "f4:f5:d8":"Google","54:60:09":"Google","a4:77:33":"Google","30:fd:38":"Google",
  "48:d6:d5":"Google","20:df:b9":"Google",
  // Amazon/Ring
  "f0:f0:a4":"Amazon","fc:65:de":"Amazon","a0:02:dc":"Amazon","44:00:49":"Amazon",
  "74:c2:46":"Amazon","68:54:fd":"Amazon","40:b4:cd":"Amazon",
  // Raspberry Pi
  "b8:27:eb":"Raspberry Pi","dc:a6:32":"Raspberry Pi","e4:5f:01":"Raspberry Pi",
  "28:cd:c1":"Raspberry Pi","d8:3a:dd":"Raspberry Pi",
  // Intel
  "3c:97:0e":"Intel","a4:34:d9":"Intel","8c:ec:4b":"Intel","f8:75:a4":"Intel",
  "34:13:e8":"Intel","80:ce:62":"Intel","48:51:b7":"Intel",
  // Ubiquiti
  "04:18:d6":"Ubiquiti","f4:92:bf":"Ubiquiti","78:8a:20":"Ubiquiti","e0:63:da":"Ubiquiti",
  "fc:ec:da":"Ubiquiti","24:5a:4c":"Ubiquiti","68:d7:9a":"Ubiquiti","b4:fb:e4":"Ubiquiti",
  "04:f4:1c":"Ubiquiti",
  // TP-Link
  "50:c7:bf":"TP-Link","60:32:b1":"TP-Link","b0:a7:b9":"TP-Link","ec:08:6b":"TP-Link",
  "30:de:4b":"TP-Link","a8:42:a1":"TP-Link","60:a4:b7":"TP-Link","54:af:97":"TP-Link",
  // Sonos
  "b8:e9:37":"Sonos","5c:aa:fd":"Sonos","78:28:ca":"Sonos","48:a6:b8":"Sonos",
  // Roku
  "b0:a7:32":"Roku","dc:3a:5e":"Roku","b8:3e:59":"Roku",
  // HP
  "3c:d9:2b":"HP","10:60:4b":"HP","94:57:a5":"HP","ec:b1:d7":"HP",
  // Dell
  "34:17:eb":"Dell","f8:bc:12":"Dell","18:66:da":"Dell","d4:be:d9":"Dell",
  // Sonoff / ITEAD
  "d8:bf:c0":"Sonoff","60:01:94":"Sonoff",
  // Tuya
  "d8:1f:12":"Tuya","7c:f6:66":"Tuya","a0:92:08":"Tuya","10:d5:61":"Tuya",
  // Shelly
  "e8:68:e7":"Shelly","ec:fa:bc":"Shelly","34:98:7a":"Shelly","c8:2b:96":"Shelly",
  // Ring
  "9c:76:1f":"Ring","34:3e:a4":"Ring",
  // Netgear
  "c0:ff:d4":"Netgear","b0:7f:b9":"Netgear","6c:b0:ce":"Netgear","a4:2b:8c":"Netgear",
  // Cisco/Linksys
  "00:1a:2b":"Cisco","58:6d:8f":"Cisco","34:62:88":"Linksys","c0:56:27":"Linksys",
  // Hikvision
  "c0:56:e3":"Hikvision","54:c4:15":"Hikvision","bc:ad:28":"Hikvision","44:19:b6":"Hikvision",
  // Xiaomi
  "78:11:dc":"Xiaomi","64:cc:2e":"Xiaomi","28:6c:07":"Xiaomi","50:ec:50":"Xiaomi",
  "04:cf:8c":"Xiaomi","7c:49:eb":"Xiaomi","34:80:0d":"Xiaomi","1c:53:f9":"Xiaomi",
  // Nvidia
  "bc:24:11":"Nvidia","48:b0:2d":"Nvidia","00:04:4b":"Nvidia",
  // Microsoft/Xbox
  "7c:ed:8d":"Microsoft","28:18:78":"Microsoft","c8:3f:26":"Xbox",
  // Wyze
  "2c:aa:8e":"Wyze","d0:3f:27":"Wyze",
  // LG
  "a8:23:fe":"LG","58:fd:b1":"LG","c4:36:6c":"LG","20:3d:bd":"LG",
  // Sony
  "f8:46:1c":"Sony","bc:60:a7":"Sony","78:c8:81":"Sony",
  // Philips Hue
  "00:17:88":"Philips Hue","ec:b5:fa":"Philips Hue",
  // Espressif (same as ESP_OUIS but for vendor name)
  "24:0a:c4":"Espressif","a4:cf:12":"Espressif","30:ae:a4":"Espressif","24:6f:28":"Espressif",
  "ac:67:b2":"Espressif","8c:aa:b5":"Espressif","e8:db:84":"Espressif","dc:54:75":"Espressif",
  "b4:e6:2d":"Espressif","cc:50:e3":"Espressif","84:f3:eb":"Espressif","a8:03:2a":"Espressif",
  "7c:9e:bd":"Espressif","94:b9:7e":"Espressif","78:e3:6d":"Espressif","10:52:1c":"Espressif",
  "34:86:5d":"Espressif","ec:94:cb":"Espressif","68:c6:3a":"Espressif","70:03:9f":"Espressif",
  "fc:f5:c4":"Espressif","18:fe:34":"Espressif","2c:f4:32":"Espressif","80:7d:3a":"Espressif",
  "c4:4f:33":"Espressif","d4:f9:8d":"Espressif",
  // Broadcom
  "20:50:e7":"Broadcom",
  // Realtek
  "48:27:e2":"Realtek","08:d1:f9":"Realtek","52:54:00":"Realtek",
  // Texas Instruments
  "54:3a:d6":"TI","d0:39:72":"TI","b0:b4:48":"TI",
  // Microchip
  "d8:80:39":"Microchip",
  // QNAP
  "24:5e:be":"QNAP",
  // Synology
  "00:11:32":"Synology",
};

function lookupVendor(mac: string): string {
  const prefix = mac.toLowerCase().slice(0, 8);
  return MAC_VENDORS[prefix] || "";
}

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
        const subnet = (args.subnet as string) || "172.168.1.0/24";

        // Step 1: Ping sweep with nmap (just to fill ARP, ignore output completely)
        try { await execAsync(`nmap -sn ${subnet} -T4 1>/dev/null 2>/dev/null`, { timeout: 90000 }); } catch {}

        // Step 2: Read ARP table directly in TypeScript — no shell parsing issues
        let arpRaw = "";
        try { arpRaw = (await execAsync(`ip neigh show`, { timeout: 10000 })).stdout; } catch {}

        const macMap = new Map<string, string>();
        for (const line of arpRaw.split("\n")) {
          const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s.*lladdr\s+([0-9a-f:]+)/i);
          if (m) macMap.set(m[1], m[2]);
        }

        // Step 3: Get hostnames from nmap
        let nmapRaw = "";
        try { nmapRaw = (await execAsync(`nmap -sn ${subnet} -T4`, { timeout: 90000 })).stdout; } catch {}

        const hostMap = new Map<string, string>();
        for (const line of nmapRaw.split("\n")) {
          const m1 = line.match(/report for (\S+)\s+\((\d+\.\d+\.\d+\.\d+)\)/);
          const m2 = line.match(/report for (\d+\.\d+\.\d+\.\d+)$/);
          if (m1) { hostMap.set(m1[2], m1[1]); if (!macMap.has(m1[2])) macMap.set(m1[2], "n/a"); }
          else if (m2) { if (!macMap.has(m2[1])) macMap.set(m2[1], "n/a"); }
        }

        // Step 4: /etc/hosts
        let etcRaw = "";
        try { etcRaw = (await execAsync(`grep -E "^[0-9]" /etc/hosts`, { timeout: 3000 })).stdout; } catch {}
        for (const line of etcRaw.split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && !hostMap.has(parts[0])) hostMap.set(parts[0], parts[1]);
        }

        // Sort IPs
        const allIps = [...macMap.keys()].sort((a, b) => {
          const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
          for (let i = 0; i < 4; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
          return 0;
        });

        // Build markdown table with vendor lookup
        const rows: string[] = [];
        rows.push("| IP Address | MAC Address | Vendor | Hostname |");
        rows.push("|---|---|---|---|");
        let espCount = 0;
        for (const ip of allIps) {
          const mac = macMap.get(ip) || "n/a";
          const hostname = hostMap.get(ip) || "";
          const vendor = mac !== "n/a" ? lookupVendor(mac) : "";
          const isEsp = mac !== "n/a" && ESP_OUIS.some(oui => mac.toLowerCase().startsWith(oui));
          if (isEsp) espCount++;
          rows.push(`| ${ip} | ${mac} | ${vendor}${isEsp ? " 📡" : ""} | ${hostname} |`);
        }
        rows.push(`\nTotal: ${allIps.length} devices | ESP: ${espCount}`);

        return rows.join("\n");
      }

      case "net_find_esp": {
        const subnet = (args.subnet as string) || "172.168.1.0/24";
        const results: string[] = ["=== ESP32/ESP8266 Device Scan ===\n"];

        // Ping sweep first to populate ARP table
        await run(`nmap -sn ${subnet} -T4 2>/dev/null`, 60000);

        // Check ARP table for Espressif MACs (no sudo needed)
        const arpOut = await run(`ip neigh show 2>/dev/null | grep -v FAILED`, 10000);
        const found: Array<{ip: string; mac: string}> = [];
        for (const line of arpOut.split("\n")) {
          const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s.*lladdr\s+([0-9a-f:]+)/i);
          if (m && ESP_OUIS.some(oui => m[2].toLowerCase().startsWith(oui))) {
            found.push({ ip: m[1], mac: m[2] });
          }
        }

        // Also try arp-scan for vendor confirmation
        const arpScanOut = await run(`sudo arp-scan --localnet 2>/dev/null`, 15000);
        if (!arpScanOut.includes("Error")) {
          for (const line of arpScanOut.split("\n")) {
            if (line.toLowerCase().includes("espressif") || ESP_OUIS.some(oui => line.toLowerCase().includes(oui))) {
              const parts = line.split("\t");
              if (parts[0] && !found.some(f => f.ip === parts[0].trim())) {
                found.push({ ip: parts[0].trim(), mac: parts[1]?.trim() || "" });
              }
            }
          }
        }

        if (found.length === 0) {
          results.push("No ESP32/ESP8266 devices found on the network.");
          results.push("\nPossible reasons:");
          results.push("  - Devices are in deep sleep (common for battery sensors)");
          results.push("  - Devices are on a different subnet/VLAN");
          results.push("  - Devices haven't connected to WiFi yet");
          results.push("\nTip: Check MQTT topics for devices that publish periodically:");
          results.push("  mqtt_subscribe topic='sensor/#' duration=10");
        } else {
          results.push(`Found ${found.length} Espressif device(s):\n`);
          for (const d of found) {
            results.push(`  📡 ${d.ip.padEnd(18)}${d.mac}`);
          }
        }
        return results.join("\n");
      }

      case "net_scan_services": {
        const subnet = (args.subnet as string) || "172.168.1.0/24";
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
        const out = await run(`nmap -p ${ports} --open ${subnet} 2>/dev/null | grep -E "Nmap scan|open|report"`, 120000);
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
