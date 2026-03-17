const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { exec } = require('child_process');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static('public'));

// API routes
app.get('/api/kate-status', (req, res) => {
  // Get Kate system status
  const commands = [
    'free -m',
    'uptime'
  ];
  
  let results = {};
  
  exec(commands.join(' && '), (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: 'Failed to fetch Kate status' });
    }
    
    const lines = stdout.trim().split('\n');
    const memoryLine = lines[1];
    const uptimeLine = lines[lines.length - 1];
    
    // Parse memory
    const memoryMatch = memoryLine.match(/(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (memoryMatch) {
      results.memory = {
        total: parseInt(memoryMatch[1]),
        used: parseInt(memoryMatch[2]),
        free: parseInt(memoryMatch[3]),
        buff_cache: parseInt(memoryMatch[4]),
        available: parseInt(memoryMatch[6])
      };
    }
    
    // Parse uptime
    const uptimeMatch = uptimeLine.match(/up\s+([^,]+),\s+.*load average:\s+(.*)/);
    if (uptimeMatch) {
      results.uptime = uptimeMatch[1];
      results.load_average = uptimeMatch[2];
    }
    
    res.json(results);
  });
});

app.get('/api/proxmox-status', (req, res) => {
  // Get Proxmox status
  const proxmoxUrl = 'http://172.168.1.204/api2/json/cluster/status';
  const command = `curl -s -k "${proxmoxUrl}"`;
  
  exec(command, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: 'Failed to fetch Proxmox status' });
    }
    
    try {
      const data = JSON.parse(stdout);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse Proxmox data' });
    }
  });
});

app.get('/api/ollama-status', (req, res) => {
  // Get Ollama status
  const ollamaUrl = 'http://172.168.1.162:11434/api/tags';
  const command = `curl -s "${ollamaUrl}"`;
  
  exec(command, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: 'Failed to fetch Ollama status' });
    }
    
    try {
      const data = JSON.parse(stdout);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse Ollama data' });
    }
  });
});

app.get('/api/home-assistant-status', (req, res) => {
  // Get Home Assistant status
  const haUrl = 'http://172.168.1.8:8123/api/states';
  const command = `curl -s -H "Authorization: Bearer YOUR_HA_TOKEN" "${haUrl}"`;
  
  exec(command, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: 'Failed to fetch Home Assistant status' });
    }
    
    try {
      const data = JSON.parse(stdout);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse Home Assistant data' });
    }
  });
});

// Socket.io for real-time updates
io.on('connection', (socket) => {
  console.log('Client connected');
  
  // Send data every 30 seconds
  const interval = setInterval(() => {
    // Fetch all data
    const data = {};
    
    exec('free -m && uptime', (error, stdout, stderr) => {
      if (!error) {
        const lines = stdout.trim().split('\n');
        const memoryLine = lines[1];
        const uptimeLine = lines[lines.length - 1];
        
        const memoryMatch = memoryLine.match(/(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
        const uptimeMatch = uptimeLine.match(/up\s+([^,]+),\s+.*load average:\s+(.*)/);
        
        if (memoryMatch && uptimeMatch) {
          data.kate = {
            memory: {
              total: parseInt(memoryMatch[1]),
              used: parseInt(memoryMatch[2]),
              free: parseInt(memoryMatch[3]),
              buff_cache: parseInt(memoryMatch[4]),
              available: parseInt(memoryMatch[6])
            },
            uptime: uptimeMatch[1],
            load_average: uptimeMatch[2]
          };
        }
      }
      
      // Proxmox data
      exec('curl -s -k "http://172.168.1.204/api2/json/cluster/status"', (error, stdout, stderr) => {
        if (!error) {
          try {
            data.proxmox = JSON.parse(stdout);
          } catch (e) {
            data.proxmox = { error: 'Failed to parse Proxmox data' };
          }
        }
        
        // Ollama data
        exec('curl -s "http://172.168.1.162:11434/api/tags"', (error, stdout, stderr) => {
          if (!error) {
            try {
              data.ollama = JSON.parse(stdout);
            } catch (e) {
              data.ollama = { error: 'Failed to parse Ollama data' };
            }
          }
          
          socket.emit('dashboard-update', data);
        });
      });
    });
  }, 30000);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

const PORT = 3006;
server.listen(PORT, () => {
  console.log(`Dashboard server running on port ${PORT}`);
});