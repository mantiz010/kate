const express = require('express');
const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const run = async (cmd, t=10000) => { try { return (await promisify(exec)(cmd, {timeout:t})).stdout.trim(); } catch { return ""; } };

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/status', async (req, res) => {
  const [kate, pve, ollama, ha, net] = await Promise.all([
    (async () => ({
      uptime: await run("uptime -p"),
      memory: await run("free -m | awk '/Mem:/{print $3\"/\"$2\" MB\"}'"),
      cpu: (await run("top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'")) + "%",
      load: await run("cat /proc/loadavg | awk '{print $1,$2,$3}'"),
      disk: await run("df -h / | awk 'NR==2{print $3\"/\"$2}'"),
      status: "online"
    }))(),
    (async () => {
      const t = "root@pam!kate=72044133-574b-4b30-be19-3559f828a7b0";
      const nodes = await run('curl -sk -H "Authorization: PVEAPIToken=' + t + '" https://172.168.1.204:8006/api2/json/nodes');
      const vms = await run('curl -sk -H "Authorization: PVEAPIToken=' + t + '" https://172.168.1.204:8006/api2/json/nodes/pve/qemu');
      let nd = {}, vl = [];
      try { const n = JSON.parse(nodes); const d = n.data[0]; nd = { name: d.node, cpu: (d.cpu*100).toFixed(1)+"%", mem: (d.mem/1073741824).toFixed(1)+"/"+(d.maxmem/1073741824).toFixed(1)+" GB", uptime: (d.uptime/3600).toFixed(0)+"h" }; } catch {}
      try { vl = JSON.parse(vms).data.map(v => ({ id: v.vmid, name: v.name, status: v.status, cpu: v.cpus, mem: (v.maxmem/1073741824).toFixed(1)+"GB" })); } catch {}
      return { node: nd, vms: vl, count: vl.length, status: nd.name ? "online" : "offline" };
    })(),
    (async () => {
      const ping = await run("curl -s -m 3 -o /dev/null -w '%{http_code}' http://172.168.1.162:11434/");
      let models = [], running = [];
      try { models = JSON.parse(await run("curl -s -m 5 http://172.168.1.162:11434/api/tags")).models.map(m => m.name); } catch {}
      try { running = JSON.parse(await run("curl -s -m 5 http://172.168.1.162:11434/api/ps")).models.map(m => m.name); } catch {}
      return { status: ping==="200"?"online":"offline", models, running, gpu: "Tesla P100 16GB + Tesla P4 8GB" };
    })(),
    (async () => {
      const tok = await run("grep -oP 'HA_TOKEN.*?\"\\K[^\"]+' /home/mantiz010/kate/src/etbus-daemon.py 2>/dev/null | head -1");
      if (!tok) return { status: "no token", sensors: 0 };
      const cnt = await run('curl -s -m 5 -H "Authorization: Bearer ' + tok + '" http://172.168.1.8:8123/api/states 2>/dev/null | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null');
      return { status: "online", sensors: parseInt(cnt) || 0 };
    })(),
    (async () => ({ devices: parseInt(await run("arp -an | wc -l")) || 0, status: "online" }))()
  ]);
  res.json({ kate, proxmox: pve, ollama, homeassistant: ha, network: net });
});

http.createServer(app).listen(3006, '0.0.0.0', () => console.log('Dashboard http://0.0.0.0:3006'));
