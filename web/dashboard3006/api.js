// API endpoint for dashboard data
const express = require('express');
const router = express.Router();

// Mock data functions - in reality these would call actual systems
function getKateStatus() {
  return {
    status: 'Online',
    uptime: '2 days, 4 hours',
    memory: '1.2 GB',
    cpu: '15%'
  };
}

function getProxmoxStatus() {
  return {
    total: 12,
    running: 8,
    stopped: 4,
    cpu: '22%',
    memory: '3.4 GB'
  };
}

function getOllamaStatus() {
  return {
    status: 'Online',
    memory: '4.2 GB',
    usage: '35%',
    temp: '68°C',
    power: '120W'
  };
}

function getHomeAssistantStatus() {
  return {
    total: 156,
    online: 142,
    offline: 14,
    last_update: '2 minutes ago'
  };
}

function getNetworkStatus() {
  return {
    active: 24,
    ports: 1024,
    open: 12,
    scanned: 254
  };
}

function getHistoricalData() {
  const now = Date.now();
  const labels = [];
  const cpuData = [];
  const memoryData = [];
  
  // Generate mock historical data for charts
  for (let i = 0; i < 20; i++) {
    const time = new Date(now - (19 - i) * 60000);
    labels.push(time.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
    cpuData.push(Math.floor(Math.random() * 40) + 10);
    memoryData.push(Math.floor(Math.random() * 30) + 5);
  }
  
  return {
    kate: {
      labels: labels,
      cpu: cpuData,
      memory: memoryData
    },
    vm: {
      labels: labels,
      cpu: cpuData.map(v => v + 5),
      memory: memoryData.map(v => v + 3)
    },
    gpu: {
      labels: labels,
      usage: cpuData.map(v => v * 0.8),
      temp: cpuData.map(v => v * 1.5 + 50)
    },
    sensors: {
      labels: labels,
      online: cpuData.map(v => 150 - Math.floor(v * 2)),
      offline: cpuData.map(v => 14 + Math.floor(v * 0.5))
    },
    network: {
      labels: labels,
      active: cpuData.map(v => 20 + Math.floor(v * 0.5)),
      open: cpuData.map(v => 5 + Math.floor(v * 0.2))
    }
  };
}

router.get('/api/dashboard', (req, res) => {
  res.json({
    kate: getKateStatus(),
    proxmox: getProxmoxStatus(),
    ollama: getOllamaStatus(),
    homeassistant: getHomeAssistantStatus(),
    network: getNetworkStatus(),
    history: getHistoricalData()
  });
});

module.exports = router;