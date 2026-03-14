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

const network: Skill = {
  id: "builtin.network",
  name: "Network",
  description: "Scan networks, discover devices, test ports, check DNS, trace routes, monitor bandwidth, find IoT devices",
  version: "1.0.0",
  tools: [
    { name: "net_scan", description: "Scan local network for devices (ARP scan)", parameters: [
      { name: "subnet", type: "string", description: "Subnet to scan (default: auto-detect, e.g. 192.168.1.0/24)", required: false },
    ]},
    { name: "net_portscan", description: "Scan open ports on a host", parameters: [
      { name: "host", type: "string", description: "Target IP or hostname", required: true },
      { name: "ports", type: "string", description: "Port range (default: 1-1024, or specific: 22,80,443,8080)", required: false },
    ]},
    { name: "net_ping", description: "Ping a host to test connectivity", parameters: [
      { name: "host", type: "string", description: "Host to ping", required: true },
      { name: "count", type: "number", description: "Number of pings (default: 4)", required: false },
    ]},
    { name: "net_traceroute", description: "Trace the route to a host", parameters: [
      { name: "host", type: "string", description: "Target host", required: true },
    ]},
    { name: "net_dns", description: "DNS lookup for a domain", parameters: [
      { name: "domain", type: "string", description: "Domain to look up", required: true },
      { name: "type", type: "string", description: "Record type: A, AAAA, MX, NS, TXT, CNAME (default: A)", required: false },
    ]},
    { name: "net_whois", description: "WHOIS lookup for a domain or IP", parameters: [
      { name: "target", type: "string", description: "Domain or IP", required: true },
    ]},
    { name: "net_speed", description: "Test internet speed (download/upload)", parameters: [] },
    { name: "net_interfaces", description: "Show all network interfaces with IPs and MACs", parameters: [] },
    { name: "net_connections", description: "Show active network connections", parameters: [
      { name: "filter", type: "string", description: "Filter: listen, established, all (default: listen)", required: false },
    ]},
    { name: "net_bandwidth", description: "Monitor bandwidth usage for a few seconds", parameters: [
      { name: "interface", type: "string", description: "Interface name (default: auto)", required: false },
      { name: "seconds", type: "number", description: "Duration (default: 3)", required: false },
    ]},
    { name: "net_wake", description: "Wake-on-LAN: send magic packet to a MAC address", parameters: [
      { name: "mac", type: "string", description: "MAC address (e.g. AA:BB:CC:DD:EE:FF)", required: true },
      { name: "broadcast", type: "string", description: "Broadcast IP (default: 255.255.255.255)", required: false },
    ]},
    { name: "net_discover_iot", description: "Discover IoT devices on the network (mDNS/Bonjour + common ports)", parameters: [
      { name: "subnet", type: "string", description: "Subnet (default: auto)", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "net_scan": {
        const subnet = args.subnet as string;
        if (subnet) {
          return run(`nmap -sn ${subnet} 2>/dev/null || arp-scan --localnet 2>/dev/null || ip neigh show 2>/dev/null`);
        }
        // Auto-detect
        return run(`arp-scan --localnet 2>/dev/null || nmap -sn $(ip route | head -1 | awk '{print $1}') 2>/dev/null || ip neigh show`);
      }
      case "net_portscan": {
        const ports = (args.ports as string) || "22,80,443,3000,3200,5000,5050,8000,8080,8443,8883,1883,9090,11434";
        if (ports.includes("-")) {
          return run(`nmap -p ${ports} ${args.host} 2>/dev/null || echo "Install nmap: sudo apt install nmap"`, 120000);
        }
        // Quick bash port scan for specific ports
        const results: string[] = [`Scanning ${args.host}...`];
        const portList = ports.split(",").map(p => p.trim());
        for (const port of portList) {
          const out = await run(`timeout 2 bash -c "echo >/dev/tcp/${args.host}/${port}" 2>&1 && echo "${port}: OPEN" || echo "${port}: closed"`, 5000);
          if (out.includes("OPEN")) results.push(`  ✓ ${port}: OPEN`);
          else results.push(`  ✗ ${port}: closed`);
        }
        return results.join("\n");
      }
      case "net_ping": {
        const n = (args.count as number) || 4;
        return run(`ping -c ${n} -W 2 ${args.host}`);
      }
      case "net_traceroute": return run(`traceroute ${args.host} 2>/dev/null || tracepath ${args.host} 2>/dev/null`, 30000);
      case "net_dns": {
        const type = (args.type as string) || "A";
        return run(`dig ${args.domain} ${type} +short 2>/dev/null || nslookup -type=${type} ${args.domain} 2>/dev/null || host -t ${type} ${args.domain}`);
      }
      case "net_whois": return run(`whois ${args.target} 2>/dev/null | head -40`);
      case "net_speed": return run(`speedtest-cli --simple 2>/dev/null || curl -s https://raw.githubusercontent.com/sivel/speedtest-cli/master/speedtest.py | python3 - --simple 2>/dev/null || echo "Install: pip install speedtest-cli"`, 60000);
      case "net_interfaces": return run(`ip -br addr 2>/dev/null || ifconfig 2>/dev/null`);
      case "net_connections": {
        const filter = (args.filter as string) || "listen";
        switch (filter) {
          case "listen": return run("ss -tlnp 2>/dev/null | head -30 || netstat -tlnp 2>/dev/null | head -30");
          case "established": return run("ss -tnp state established 2>/dev/null | head -30");
          default: return run("ss -tnap 2>/dev/null | head -40");
        }
      }
      case "net_bandwidth": {
        const iface = (args.interface as string) || "";
        const sec = (args.seconds as number) || 3;
        if (iface) {
          return run(`ifstat -i ${iface} 1 ${sec} 2>/dev/null || (R1=$(cat /sys/class/net/${iface}/statistics/rx_bytes) && T1=$(cat /sys/class/net/${iface}/statistics/tx_bytes) && sleep ${sec} && R2=$(cat /sys/class/net/${iface}/statistics/rx_bytes) && T2=$(cat /sys/class/net/${iface}/statistics/tx_bytes) && echo "RX: $(( (R2-R1)/${sec}/1024 )) KB/s" && echo "TX: $(( (T2-T1)/${sec}/1024 )) KB/s")`, (sec + 5) * 1000);
        }
        return run(`ifstat 1 ${sec} 2>/dev/null || echo "Install: sudo apt install ifstat"`, (sec + 5) * 1000);
      }
      case "net_wake": {
        const mac = (args.mac as string).replace(/[:-]/g, "");
        const broadcast = (args.broadcast as string) || "255.255.255.255";
        // Build magic packet using python
        return run(`python3 -c "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);mac=bytes.fromhex('${mac}');s.sendto(b'\\xff'*6+mac*16,('${broadcast}',9));print('WOL sent to ${args.mac}')" 2>&1`);
      }
      case "net_discover_iot": {
        const results: string[] = ["=== IoT Device Discovery ===\n"];
        // mDNS
        results.push("--- mDNS/Bonjour ---");
        results.push(await run("avahi-browse -tpr _http._tcp 2>/dev/null | head -20 || echo 'avahi not available'", 10000));
        results.push(await run("avahi-browse -tpr _mqtt._tcp 2>/dev/null | head -10 || true", 10000));
        // Common IoT ports
        results.push("\n--- Common IoT ports ---");
        const subnet = (args.subnet as string) || "";
        if (subnet) {
          results.push(await run(`nmap -p 80,443,1883,8883,8080,8123,5353,1900 --open ${subnet} 2>/dev/null | grep -E "open|Nmap scan" || echo "nmap not available"`, 60000));
        } else {
          results.push("Specify subnet for port scan (e.g. 192.168.1.0/24)");
        }
        return results.join("\n");
      }
      default: return `Unknown: ${toolName}`;
    }
  },
};
export default network;

